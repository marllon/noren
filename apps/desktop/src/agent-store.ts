import { useSyncExternalStore } from "react";
import { agentSettingsOf, detectAgentByCommand, resolveAgent } from "@noren/model";
import type { Id, Pane } from "@noren/model";
import { configManager } from "./config-store";

// Which CLI agent runs in which pane. Two sources, read here and nowhere else:
//
// - the command the shell reported (OSC 633;E, kept on the pane as `runningCommand.text` while it
//   runs), matched against the catalog of the settings by `detectAgentByCommand`;
// - the process tree of the session, looked at on an interval by the scanner (`agent-scanner.ts`),
//   which hands the result to `setTreeAgents`.
//
// The command wins when both know (`resolveAgent`). Nothing is saved: an agent is a fact about a
// running shell, so it is gone with the window. With `agents.enabled` off, no pane has an agent.

/** The agent under the shell of each pane, as the last look at the process tree said. */
let treeAgents: ReadonlyMap<Id, string> = new Map();

/** Moves when the tree result or the settings may have changed, so a view knows to ask again. */
let version = 0;

const listeners = new Set<() => void>();

function notify(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

/** `onChange` runs when what `agentOfPane` answers may have changed. Returns the function that stops it. */
export function subscribeAgents(onChange: () => void): () => void {
  listeners.add(onChange);
  const stopFollowingConfig = configManager.subscribe(() => {
    version++;
    onChange();
  });
  return () => {
    listeners.delete(onChange);
    stopFollowingConfig();
  };
}

/** Replaces the agents the process tree showed. Telling the views only when something differs. */
export function setTreeAgents(next: ReadonlyMap<Id, string>): void {
  const same =
    next.size === treeAgents.size &&
    [...next].every(([paneId, agentId]) => treeAgents.get(paneId) === agentId);
  if (same) return;
  treeAgents = new Map(next);
  notify();
}

/** The agent of a pane now: its running command, else what the process tree showed; `undefined` for none. */
export function agentOfPane(pane: Pane): string | undefined {
  const settings = agentSettingsOf(configManager.state.config.agents);
  if (!settings.enabled) return undefined;
  const byCommand = detectAgentByCommand(pane.runningCommand?.text, settings.catalog);
  return resolveAgent(byCommand, treeAgents.get(pane.id));
}

/**
 * `agentOfPane` for a component: it renders again when the process tree or the settings change
 * (a change of the pane itself already renders the component).
 */
export function useAgentOfPane(): (pane: Pane) => string | undefined {
  useSyncExternalStore(subscribeAgents, () => version);
  return agentOfPane;
}

/** Forgets what the process tree showed, so a test starts from nothing. */
export function resetAgentStore(): void {
  treeAgents = new Map();
  version++;
}
