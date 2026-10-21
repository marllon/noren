import { useSyncExternalStore } from "react";
import {
  AgentStateTracker,
  agentSettingsOf,
  buildAgentList,
  compileAgentRules,
  firstWaitingAgent,
} from "@noren/model";
import type { AgentInfo, AgentRow, AgentState, Clock, Id, Pane, Workspace } from "@noren/model";
import {
  agentOfPane,
  commandAgentOfPane,
  subscribeAgents,
  treeAgentOfPane,
  useAgentOfPane,
} from "./agent-store";
import { configManager } from "./config-store";
import { itemTitle } from "./favorites";
import { realClock } from "./real-clock";

// What each pane's agent is doing: working, waiting for you, or idle. The classifier is pure and
// lives in `@noren/model` (`agent-state.ts`); this keeps one tracker per pane that has an agent and
// tells the views when a state changes.
//
// The tracker is fed from three places, all cheap and none of them on the path that paints the
// terminal (the bytes go to xterm first):
// - the output of the session (`feedAgentOutput`): turned into plain text and matched against the
//   patterns of the agent, once per chunk the backend batched;
// - a notification the program raised, OSC 9 or OSC 777 (`noteAgentNotification`);
// - the keys the person types (`noteAgentInput`).
// A pane without an agent costs one lookup per chunk and nothing else. Nothing is saved: a state is
// a fact about a running agent, so it is gone with the window.

interface Entry {
  readonly agentId: string;
  /** The session the pane holds now (it can change while the entry lives), for the local API. */
  sessionId: string | undefined;
  /** The agent was found only by the process tree: when the tree stops showing it, the entry goes. */
  readonly viaTree: boolean;
  readonly tracker: AgentStateTracker;
  state: AgentState;
  /** The `agents` section the rules were compiled from, to compile again when the file changes. */
  source: unknown;
}

const entries = new Map<Id, Entry>();

/** The clock the silence is measured on: real time in the app, the fake shell's clock in web mode. */
let clock: Clock = realClock;

/**
 * Told every time the state of an agent changes, with the session of its pane (NOR-F17-01f): the
 * local API says it to the clients that subscribed. It has to repeat nothing and wait for nothing;
 * it is set once by the app (`agent-state-report.ts`) and is none in web mode.
 */
export type AgentStateReporter = (sessionId: string, state: AgentState) => void;
let reporter: AgentStateReporter | undefined;

/** Sets who is told of changes of state; `undefined` stops telling. */
export function setAgentStateReporter(next: AgentStateReporter | undefined): void {
  reporter = next;
}

function report(entry: Entry, state: AgentState): void {
  if (entry.sessionId !== undefined) reporter?.(entry.sessionId, state);
}

/** Moves when any state changed, so a view knows to ask again. */
let version = 0;
const listeners = new Set<() => void>();
let watching = false;

/**
 * Moves when the last line of some agent changed. Apart from `version` on purpose: this one moves
 * with every chunk of output, and only the Agents panel reads it.
 */
let lineVersion = 0;
const lineListeners = new Set<() => void>();

/** Moves once a second while the Agents panel is open, so the time in each state keeps counting. */
let tickVersion = 0;
const tickListeners = new Set<() => void>();
let cancelTick: (() => void) | undefined;

function notify(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

/** `onChange` runs when `agentStateOfPane` may answer something else. Returns the function that stops it. */
export function subscribeAgentStates(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Sets the clock new trackers use (the silence of an agent is measured on it). */
export function setAgentStateClock(next: Clock): void {
  clock = next;
}

function rulesOf(agentId: string) {
  const settings = agentSettingsOf(configManager.state.config.agents);
  return compileAgentRules(
    settings.catalog.find((candidate) => candidate.id === agentId),
    settings.silenceMs,
  );
}

/** An agent that left the tree takes its state with it; one that stays keeps it. */
function forgetLostTreeAgents(): void {
  let changed = false;
  for (const [paneId, entry] of [...entries]) {
    if (entry.viaTree && treeAgentOfPane(paneId) === undefined) {
      entry.tracker.dispose();
      entries.delete(paneId);
      report(entry, "idle");
      changed = true;
    }
  }
  if (changed) notify();
}

function entryOf(pane: Pane, agentId: string): Entry {
  if (!watching) {
    watching = true;
    subscribeAgents(forgetLostTreeAgents);
  }
  const source = configManager.state.config.agents;
  const known = entries.get(pane.id);
  if (known !== undefined && known.agentId === agentId) {
    if (known.source !== source) {
      known.source = source;
      known.tracker.setRules(rulesOf(agentId));
    }
    return known;
  }
  if (known !== undefined) {
    known.tracker.dispose();
    report(known, "idle");
  }
  const created: Entry = {
    agentId,
    sessionId: pane.sessionId,
    viaTree: commandAgentOfPane(pane) === undefined,
    state: "idle",
    source,
    tracker: new AgentStateTracker({
      clock,
      rules: rulesOf(agentId),
      onChange: (state) => {
        created.state = state;
        report(created, state);
        notify();
      },
      onLine: () => {
        lineVersion++;
        for (const listener of [...lineListeners]) listener();
      },
    }),
  };
  entries.set(pane.id, created);
  return created;
}

/** The entry of a pane with an agent now; none for a pane without one (and a stale entry goes). */
function liveEntry(pane: Pane): Entry | undefined {
  const agentId = agentOfPane(pane);
  if (agentId === undefined) {
    forgetAgentState(pane.id);
    return undefined;
  }
  const entry = entryOf(pane, agentId);
  entry.sessionId = pane.sessionId;
  return entry;
}

/** A chunk of the output of the session of `pane`, as the bytes it arrived in. */
export function feedAgentOutput(pane: Pane, bytes: Uint8Array): void {
  liveEntry(pane)?.tracker.feed(bytes);
}

/** The program of `pane` raised a notification (OSC 9 or OSC 777). */
export function noteAgentNotification(pane: Pane): void {
  liveEntry(pane)?.tracker.notify();
}

/** The person typed in `pane`. */
export function noteAgentInput(pane: Pane): void {
  liveEntry(pane)?.tracker.input();
}

/** Forgets the state of a pane (its command ended, or the pane went away). */
export function forgetAgentState(paneId: Id): void {
  const entry = entries.get(paneId);
  if (entry === undefined) return;
  entry.tracker.dispose();
  entries.delete(paneId);
  report(entry, "idle");
  notify();
}

/**
 * What the agent of a pane is doing now; `undefined` when the pane has no agent. An agent that has
 * not printed anything yet is idle.
 */
export function agentStateOfPane(pane: Pane): AgentState | undefined {
  const agentId = agentOfPane(pane);
  if (agentId === undefined) return undefined;
  const entry = entries.get(pane.id);
  return entry !== undefined && entry.agentId === agentId ? entry.state : "idle";
}

/** `agentStateOfPane` for a component: it renders again when a state, an agent or the settings change. */
export function useAgentStateOfPane(): (pane: Pane) => AgentState | undefined {
  useAgentOfPane();
  useSyncExternalStore(subscribeAgentStates, () => version);
  return agentStateOfPane;
}

/**
 * What the Agents panel knows of the agent of a pane; `undefined` when the pane has none. The state
 * and the time in it are the tracker's (an agent that printed nothing yet starts its idle time the
 * first time it is asked about), the last line is the last one with something on it.
 */
export function agentInfoOfPane(pane: Pane): AgentInfo | undefined {
  const agentId = agentOfPane(pane);
  if (agentId === undefined) return undefined;
  const { tracker } = entryOf(pane, agentId);
  return { agentId, state: tracker.state, since: tracker.since, lastLine: tracker.lastLine };
}

/** The agents of every space in the order of the Agents panel (see `buildAgentList`). */
export function agentRows(workspace: Pick<Workspace, "spaces">): AgentRow[] {
  return buildAgentList(workspace, agentInfoOfPane, itemTitle, clock.now());
}

/** The agent that has waited for you longest, in any space; `undefined` when none waits. */
export function firstWaitingAgentOf(workspace: Pick<Workspace, "spaces">): AgentRow | undefined {
  return firstWaitingAgent(agentRows(workspace));
}

function subscribeLines(onChange: () => void): () => void {
  lineListeners.add(onChange);
  return () => {
    lineListeners.delete(onChange);
  };
}

function armTick(): void {
  cancelTick = clock.setTimer(() => {
    tickVersion++;
    for (const listener of [...tickListeners]) listener();
    armTick();
  }, 1000);
}

function subscribeTick(onChange: () => void): () => void {
  tickListeners.add(onChange);
  if (tickListeners.size === 1) armTick();
  return () => {
    tickListeners.delete(onChange);
    if (tickListeners.size === 0) {
      cancelTick?.();
      cancelTick = undefined;
    }
  };
}

/**
 * `agentRows` for the Agents panel: it renders again when a state, an agent or the settings change,
 * when an agent prints a new last line, and once a second for the time in each state. The ticks run
 * on the clock of the agent states, so a test that moves the fake clock moves them.
 */
export function useAgentRows(workspace: Pick<Workspace, "spaces">): AgentRow[] {
  useAgentOfPane();
  useSyncExternalStore(subscribeAgentStates, () => version);
  useSyncExternalStore(subscribeLines, () => lineVersion);
  useSyncExternalStore(subscribeTick, () => tickVersion);
  return agentRows(workspace);
}

/** Forgets every state and puts the real clock back, so a test starts from nothing. */
export function resetAgentStates(): void {
  for (const entry of entries.values()) entry.tracker.dispose();
  entries.clear();
  clock = realClock;
  version++;
  lineVersion++;
}
