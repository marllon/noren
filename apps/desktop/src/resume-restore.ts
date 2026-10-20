import { layoutPanes, planAgentResume } from "@noren/model";
import type { AgentResume, AgentSettings, Backend, RestoreResult } from "@noren/model";
import type { ResumeService } from "./resume-service";

/**
 * After the workspace is restored, arms the resume command of every pane that had an agent running
 * when the state was saved and got a new shell (`planAgentResume` decides which; with
 * `agents.resumeOnRestore` off, or agents off, nothing is armed). The command is typed, with an
 * Enter, into the session of the pane when its shell is ready (see `resume-service.ts`). Returns the
 * plan, for the tests and the log.
 */
export function armAgentResumes(options: {
  restored: Pick<RestoreResult, "workspace" | "savedCommands" | "reattachedPaneIds">;
  settings: Pick<AgentSettings, "enabled" | "resumeOnRestore" | "catalog">;
  backend: Pick<Backend, "write">;
  service: ResumeService;
}): AgentResume[] {
  const { restored, settings, backend, service } = options;
  const plan = planAgentResume({
    settings,
    savedCommands: restored.savedCommands,
    reattachedPaneIds: restored.reattachedPaneIds,
  });
  if (plan.length === 0) return plan;
  const sessions = new Map<string, string>();
  for (const space of restored.workspace.spaces) {
    for (const item of Object.values(space.items)) {
      for (const pane of layoutPanes(item.layout)) {
        if (pane.sessionId !== undefined) sessions.set(pane.id, pane.sessionId);
      }
    }
  }
  const armed: AgentResume[] = [];
  for (const resume of plan) {
    const sessionId = sessions.get(resume.paneId);
    if (sessionId === undefined) continue;
    service.arm(resume.paneId, () => {
      backend.write(Number(sessionId), `${resume.text}\r`).catch(() => undefined);
    });
    armed.push(resume);
  }
  return armed;
}
