import type { ProjectAction } from "@noren/model";
import { Play, Square } from "lucide-react";
import { menuPoint } from "./ContextMenu";
import { useT } from "./i18n";
import { useInterfaceStyle } from "./layout-store";
import type { MenuPoint } from "./SpaceMenu";
import type { ProjectActionsUi } from "./use-project-actions";

interface ActionsHeaderProps {
  /** Name of the active space, shown as the title. */
  spaceName: string;
  ui: ProjectActionsUi;
  /** Right click (or the menu key) on the row of an action: the page offers to put it in the Favorites bar. */
  onMenu?(action: ProjectAction, point: MenuPoint): void;
}

/**
 * The header of the active space in the sidebar: one row per action of its `.noren/actions.json`,
 * with a running indicator and Start or Stop. Nothing renders when the space has no actions.
 *
 * The glass style draws it as a card: the mark in the color of the space, its name and the words
 * "project actions", then each action as a button of its own (the icon of what it does, the label)
 * side by side. The names, the buttons and what they do are the same in both styles.
 */
export function ActionsHeader({ spaceName, ui, onMenu }: ActionsHeaderProps) {
  const t = useT();
  const glass = useInterfaceStyle() === "glass";
  if (ui.actions.length === 0) return null;
  return (
    <section className="space-header" data-nr-part="space-header" aria-label={t("actions.label")}>
      {glass ? (
        <div className="space-header-line">
          <span className="space-header-mark" aria-hidden="true" />
          <h2 className="space-header-title">{spaceName}</h2>
          <span className="space-header-note" aria-hidden="true">
            · {t("sidebar.actionsNote")}
          </span>
        </div>
      ) : (
        <h2 className="space-header-title">{spaceName}</h2>
      )}
      <ul className="space-actions">
        {ui.actions.map((action) => {
          const running = ui.statusOf(action) === "running";
          const verb = running ? t("actions.stop") : t("actions.start");
          const buttonName = running
            ? t("actions.stopNamed", { name: action.label })
            : t("actions.startNamed", { name: action.label });
          return (
            <li
              key={action.id}
              className="space-action"
              data-nr-state={running ? "running" : "idle"}
              onContextMenu={(event) => {
                if (onMenu === undefined) return;
                event.preventDefault();
                onMenu(action, menuPoint(event));
              }}
            >
              {!glass && (
                <>
                  <span
                    className="action-dot"
                    data-nr-indicator={running ? "running" : "idle"}
                    title={running ? t("actions.running") : t("actions.idle")}
                  />
                  <span className="action-label">{action.label}</span>
                </>
              )}
              <button
                type="button"
                className="action-button"
                aria-label={buttonName}
                disabled={ui.isBusy(action)}
                onClick={() => (running ? ui.stop(action) : ui.run(action))}
              >
                {running ? (
                  <Square size={glass ? 12 : 11} aria-hidden="true" />
                ) : (
                  <Play size={glass ? 12 : 11} aria-hidden="true" />
                )}
                {glass ? (
                  <>
                    <span className="action-label">{action.label}</span>
                    <span
                      className="action-dot"
                      data-nr-indicator={running ? "running" : "idle"}
                      title={running ? t("actions.running") : t("actions.idle")}
                    />
                  </>
                ) : (
                  verb
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
