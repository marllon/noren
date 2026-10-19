import { Play, Square } from "lucide-react";
import type { ProjectActionsUi } from "./use-project-actions";

interface ActionsHeaderProps {
  /** Name of the active space, shown as the title. */
  spaceName: string;
  ui: ProjectActionsUi;
}

/**
 * The header of the active space in the sidebar: one row per action of its `.noren/actions.json`,
 * with a running indicator and Start or Stop. Nothing renders when the space has no actions.
 */
export function ActionsHeader({ spaceName, ui }: ActionsHeaderProps) {
  if (ui.actions.length === 0) return null;
  return (
    <section className="space-header" data-nr-part="space-header" aria-label="Project actions">
      <h2 className="space-header-title">{spaceName}</h2>
      <ul className="space-actions">
        {ui.actions.map((action) => {
          const running = ui.statusOf(action) === "running";
          const verb = running ? "Stop" : "Start";
          return (
            <li
              key={action.id}
              className="space-action"
              data-nr-state={running ? "running" : "idle"}
            >
              <span
                className="action-dot"
                data-nr-indicator={running ? "running" : "idle"}
                title={running ? "Running" : "Not running"}
              />
              <span className="action-label">{action.label}</span>
              <button
                type="button"
                className="action-button"
                aria-label={`${verb} ${action.label}`}
                disabled={ui.isBusy(action)}
                onClick={() => (running ? ui.stop(action) : ui.run(action))}
              >
                {running ? (
                  <Square size={11} aria-hidden="true" />
                ) : (
                  <Play size={11} aria-hidden="true" />
                )}
                {verb}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
