import { detectAgentByCommand } from "./agents";
import type { AgentSettings } from "./agents";
import type { Id } from "./types";

// Resuming agents after the machine restarted (NOR-F14-03). The shells of the panes died with the
// restart, so every pane got a new shell in its folder; a pane that had a catalog agent running
// when the state was saved (the command line the shell reported, kept in `state.json`) may then be
// handed the resume command of that agent (`resume` in its catalog entry, such as `claude
// --continue`), but only when the user turned `agents.resumeOnRestore` on. The command is the one
// the user wrote in the settings, never one suggested by an AI.
//
// Pure: no DOM, no Tauri. Typing the command into the shell is the interface's job
// (`apps/desktop/src/resume-service.ts`).

/** The command line a pane was running when the state was saved. */
export interface SavedPaneCommand {
  paneId: Id;
  text: string;
}

/** The resume command to type into the new shell of one pane. */
export interface AgentResume {
  paneId: Id;
  /** The catalog agent the saved command named. */
  agentId: string;
  /** The command line, as the catalog entry wrote it (no line break; the caller adds the Enter). */
  text: string;
}

/**
 * Which panes get a resume command, and which one. A pane is resumed when all of these hold:
 *
 * - the settings have agents on and `resumeOnRestore` on;
 * - the command it was running names an agent of the catalog;
 * - the entry of that agent has a `resume` command;
 * - its shell is a new one: a pane in `reattachedPaneIds` kept its old shell (the session daemon held
 *   it), and the agent in it is still running, so nothing is typed.
 *
 * At most one entry per pane (the first, if a pane is listed twice), in the order of `savedCommands`.
 */
export function planAgentResume(input: {
  settings: Pick<AgentSettings, "enabled" | "resumeOnRestore" | "catalog">;
  savedCommands: readonly SavedPaneCommand[];
  reattachedPaneIds: readonly Id[];
}): AgentResume[] {
  const { settings, savedCommands, reattachedPaneIds } = input;
  if (!settings.enabled || !settings.resumeOnRestore) return [];
  const kept = new Set(reattachedPaneIds);
  const planned = new Set<Id>();
  const plan: AgentResume[] = [];
  for (const { paneId, text } of savedCommands) {
    if (kept.has(paneId) || planned.has(paneId)) continue;
    const agentId = detectAgentByCommand(text, settings.catalog);
    if (agentId === undefined) continue;
    const resume = settings.catalog.find((entry) => entry.id === agentId)?.resume;
    if (resume === undefined || resume.trim() === "") continue;
    planned.add(paneId);
    plan.push({ paneId, agentId, text: resume });
  }
  return plan;
}
