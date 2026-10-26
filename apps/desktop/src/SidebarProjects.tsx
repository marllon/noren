import { anyRunning } from "@noren/model";
import type { ActionStatus, Id, ProjectAction, ProjectEntry } from "@noren/model";
import { ChevronRight, Hourglass, Play, Square } from "lucide-react";
import type { CSSProperties } from "react";
import { menuPoint } from "./ContextMenu";
import { useT } from "./i18n";
import { useInterfaceStyle } from "./layout-store";
import type { MenuPoint } from "./SpaceMenu";

interface SidebarProjectsProps {
  entries: readonly ProjectEntry[];
  /** The space on screen, drawn as the current one. */
  activeSpaceId: Id;
  /** How the action of the space is (running, waiting to stop, idle), and whether a run or a stop of it is still going on. */
  statusOf(spaceId: Id, action: ProjectAction): ActionStatus;
  isBusy(spaceId: Id, action: ProjectAction): boolean;
  /** The user opened or closed the block of the space. */
  onToggle(spaceId: Id, open: boolean): void;
  onRun(spaceId: Id, action: ProjectAction): void;
  onStop(spaceId: Id, action: ProjectAction): void;
  /** The button of an action that is stopping was clicked: the page offers to end it at once. */
  onStopping(spaceId: Id, action: ProjectAction, point: MenuPoint): void;
  /** Right click (or the menu key) on the row of an action: the page offers to put it in the Favorites bar. */
  onMenu?(spaceId: Id, action: ProjectAction, point: MenuPoint): void;
}

/**
 * The Projects section of the sidebar, above the tree of tabs: one block for each space that has
 * a valid `.noren/actions.json` with an action (`listProjects`). A closed block is one line: a
 * state dot (lit while some action of the space runs), the name of the space and the Start or Stop
 * button of its main action. The name opens and closes the block, which lists the other actions,
 * each with its own button. An action that waits for its session to end (`stopWaits`) shows an
 * hourglass and an amber dot ("Stopping") until it does; its button offers to stop it now. The buttons act on the space of their block; the space on screen does
 * not change. Nothing renders when no space qualifies.
 */
export function SidebarProjects({
  entries,
  activeSpaceId,
  statusOf,
  isBusy,
  onToggle,
  onRun,
  onStop,
  onStopping,
  onMenu,
}: SidebarProjectsProps) {
  const t = useT();
  const glass = useInterfaceStyle() === "glass";
  const size = glass ? 12 : 9;
  if (entries.length === 0) return null;

  const button = (entry: ProjectEntry, action: ProjectAction) => {
    const spaceId = entry.space.id;
    const status = statusOf(spaceId, action);
    const words = { name: action.label, space: entry.space.name };
    const name =
      status === "stopping"
        ? t("projects.stoppingNamed", words)
        : status === "running"
          ? t("projects.stopNamed", words)
          : t("projects.startNamed", words);
    return (
      <button
        type="button"
        className="project-run"
        data-nr-part="project-run"
        data-nr-state={status}
        aria-label={name}
        aria-haspopup={status === "stopping" ? "menu" : undefined}
        title={name}
        disabled={isBusy(spaceId, action)}
        onClick={(event) => {
          if (status === "stopping") onStopping(spaceId, action, menuPoint(event));
          else if (status === "running") onStop(spaceId, action);
          else onRun(spaceId, action);
        }}
      >
        {status === "stopping" ? (
          <Hourglass size={size} aria-hidden="true" />
        ) : status === "running" ? (
          <Square size={size} aria-hidden="true" />
        ) : (
          <Play size={size} aria-hidden="true" />
        )}
      </button>
    );
  };

  return (
    <section className="projects" data-nr-part="projects" aria-label={t("projects.label")}>
      <h2 className="projects-title" aria-hidden="true">
        {t("projects.title")}
      </h2>
      <ul className="projects-list">
        {entries.map((entry) => {
          const spaceId = entry.space.id;
          const lit = anyRunning(entry, (action) => statusOf(spaceId, action) === "running");
          // Nothing runs, but an action waits for its session to end: the dot says so.
          const waiting =
            !lit && anyRunning(entry, (action) => statusOf(spaceId, action) === "stopping");
          const block = lit ? "running" : waiting ? "stopping" : "idle";
          const others = entry.actions.filter((action) => action !== entry.main);
          const bodyId = `project-actions-${spaceId}`;
          return (
            <li
              key={spaceId}
              className="project"
              data-nr-part="project"
              data-nr-state={block}
              data-nr-open={entry.open ? "true" : "false"}
              aria-current={spaceId === activeSpaceId ? "true" : undefined}
              style={{ "--nr-project-color": entry.space.color } as CSSProperties}
            >
              <div
                className="project-line"
                onContextMenu={(event) => {
                  if (onMenu === undefined) return;
                  event.preventDefault();
                  onMenu(spaceId, entry.main, menuPoint(event));
                }}
              >
                <span
                  className="project-dot"
                  data-nr-indicator={block}
                  title={
                    lit ? t("actions.running") : waiting ? t("actions.stopping") : t("actions.idle")
                  }
                />
                <button
                  type="button"
                  className="project-name"
                  data-nr-part="project-name"
                  aria-label={t("projects.toggle", { name: entry.space.name })}
                  aria-expanded={entry.open}
                  aria-controls={entry.open ? bodyId : undefined}
                  onClick={() => onToggle(spaceId, !entry.open)}
                >
                  <ChevronRight className="project-chevron" size={size} aria-hidden="true" />
                  <span className="project-name-text">{entry.space.name}</span>
                </button>
                {button(entry, entry.main)}
              </div>
              {entry.open && (
                <ul className="project-actions" id={bodyId}>
                  {others.length === 0 && (
                    <li className="project-none">{t("projects.noOthers")}</li>
                  )}
                  {others.map((action) => (
                    <li
                      key={action.id}
                      className="project-action"
                      data-nr-state={statusOf(spaceId, action)}
                      onContextMenu={(event) => {
                        if (onMenu === undefined) return;
                        event.preventDefault();
                        onMenu(spaceId, action, menuPoint(event));
                      }}
                    >
                      <span className="project-dot" data-nr-indicator={statusOf(spaceId, action)} />
                      <span className="project-action-label">{action.label}</span>
                      {button(entry, action)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
