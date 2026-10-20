import { useSyncExternalStore } from "react";
import { AgentStateTracker, agentSettingsOf, compileAgentRules } from "@noren/model";
import type { AgentState, Clock, Id, Pane } from "@noren/model";
import {
  agentOfPane,
  commandAgentOfPane,
  subscribeAgents,
  treeAgentOfPane,
  useAgentOfPane,
} from "./agent-store";
import { configManager } from "./config-store";
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

/** Moves when any state changed, so a view knows to ask again. */
let version = 0;
const listeners = new Set<() => void>();
let watching = false;

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
  known?.tracker.dispose();
  const created: Entry = {
    agentId,
    viaTree: commandAgentOfPane(pane) === undefined,
    state: "idle",
    source,
    tracker: new AgentStateTracker({
      clock,
      rules: rulesOf(agentId),
      onChange: (state) => {
        created.state = state;
        notify();
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
  return entryOf(pane, agentId);
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

/** Forgets every state and puts the real clock back, so a test starts from nothing. */
export function resetAgentStates(): void {
  for (const entry of entries.values()) entry.tracker.dispose();
  entries.clear();
  clock = realClock;
  version++;
}
