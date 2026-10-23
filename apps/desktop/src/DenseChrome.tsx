import { GitBranch, Search, Settings } from "lucide-react";
import type { CSSProperties } from "react";
import type { AgentRow, Workspace } from "@noren/model";
import { useAgentRows } from "./agent-state-store";
import { paneCount, useT } from "./i18n";
import type { PaneBarInfo } from "./pane-info";
import { ariaShortcutOf, useChord, useDenseKeys } from "./shortcut-keys";
import { openPaletteFromChrome, useWindowCrumbs, usePaletteOpenable } from "./window-chrome";

/**
 * The parts the dense window has that the glass one does not: the brand and the breadcrumb of the title
 * bar with the button of the palette, the settings row and the list of agents at the foot of the
 * sidebar, and the status bar at the foot of the window (`denso-janela`). They draw only what the app
 * has: where the person is, the folder and branch of the pane in focus, how many agents wait, how many
 * panes the tab holds. Nothing here is drawn under the glass style (the page asks).
 */

/** The mark of the brand: the prompt glyph, in the color the stylesheet gives it. */
export function BrandMark() {
  return (
    <svg
      className="brand-mark"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 8 4 4-4 4" />
      <path d="M12 16h7" />
    </svg>
  );
}

/** The space, the group and the tab on screen, in the title bar: `SITE / api / pnpm dev`. */
export function TitleCrumbs() {
  const t = useT();
  const crumbs = useWindowCrumbs();
  if (crumbs === undefined) return null;
  const parts = [
    { key: "space", text: crumbs.space },
    ...(crumbs.group !== undefined ? [{ key: "group", text: crumbs.group }] : []),
    ...(crumbs.tab !== undefined ? [{ key: "tab", text: crumbs.tab }] : []),
  ];
  return (
    <nav className="titlebar-crumbs" data-nr-part="titlebar-crumbs" aria-label={t("chrome.crumbs")}>
      <ol>
        {parts.map((part, index) => (
          <li
            key={part.key}
            data-nr-crumb={part.key}
            {...(index === parts.length - 1 ? { "aria-current": "location" as const } : {})}
          >
            {index > 0 && (
              <span className="titlebar-sep" aria-hidden="true">
                /
              </span>
            )}
            <span className="titlebar-crumb-text" title={part.text}>
              {part.text}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The field-like button of the title bar that opens the command palette, with its shortcut written out. */
export function TitlePalette() {
  const t = useT();
  const openable = usePaletteOpenable();
  const chord = useChord("palette.open");
  const keys = useDenseKeys("palette.open");
  return (
    <button
      type="button"
      className="titlebar-palette"
      data-nr-part="titlebar-palette"
      disabled={!openable}
      title={t("sidebar.search")}
      {...(chord !== undefined ? { "aria-keyshortcuts": ariaShortcutOf(chord) } : {})}
      onClick={openPaletteFromChrome}
    >
      <Search size={12} aria-hidden="true" />
      <span className="titlebar-palette-text">{t("chrome.palette")}</span>
      {keys !== undefined && (
        <span className="titlebar-keys" data-nr-part="keycap" aria-hidden="true">
          {keys}
        </span>
      )}
    </button>
  );
}

/** The row of the settings at the foot of the dense sidebar (the title bar has the button when the sidebar is not docked). */
export function SidebarSettingsRow({ onOpen }: { onOpen(): void }) {
  const t = useT();
  const keys = useDenseKeys("settings.open");
  return (
    <button
      type="button"
      className="sidebar-settings"
      data-nr-part="sidebar-settings"
      aria-label={t("titleBar.settings")}
      title={t("titleBar.settings")}
      onClick={onOpen}
    >
      <Settings size={12} aria-hidden="true" />
      <span className="sidebar-settings-text" aria-hidden="true">
        {t("titleBar.settings").toLowerCase()}
      </span>
      {keys !== undefined && (
        <span className="sidebar-settings-keys" data-nr-part="keycap" aria-hidden="true">
          {keys}
        </span>
      )}
    </button>
  );
}

interface SidebarAgentsProps {
  workspace: Pick<Workspace, "spaces">;
  /** The person chose an agent: the caller goes to its space, tab and pane. */
  onPick(row: AgentRow): void;
}

/**
 * The agents of every space, at the foot of the dense sidebar: a diamond in the color of what the
 * agent is doing, its name, and how it is and for how long. The ones that wait for the person come
 * first (the order of the agents panel). Nothing is drawn while no agent runs.
 */
export function SidebarAgents({ workspace, onPick }: SidebarAgentsProps) {
  const t = useT();
  const rows = useAgentRows(workspace);
  if (rows.length === 0) return null;
  return (
    <section
      className="sidebar-agents"
      data-nr-part="sidebar-agents"
      aria-label={t("agents.label")}
    >
      <h2 className="sidebar-agents-title" aria-hidden="true">
        {t("agents.label")}
      </h2>
      <ul className="sidebar-agents-list" aria-label={t("agents.list")}>
        {rows.map((row) => {
          const where = t("agents.where", { tab: row.itemTitle, space: row.spaceName });
          const short =
            row.state === "waiting"
              ? t("agents.waitingShort")
              : row.state === "working"
                ? t("agents.state.working")
                : t("agents.state.idle");
          return (
            <li key={row.paneId}>
              <button
                type="button"
                className="sidebar-agent"
                data-nr-part="sidebar-agent"
                data-nr-agent-state={row.state}
                aria-label={t("agents.rowShort", {
                  name: row.agentId,
                  state: short,
                  elapsed: row.elapsed,
                  where,
                })}
                title={where}
                onClick={() => onPick(row)}
              >
                <span className="sidebar-agent-mark" aria-hidden="true" />
                {/* The spaces between the parts are not drawn (they are flex items), but they keep the
                    words of one part from running into the next in the text a tool reads. */}
                <span className="sidebar-agent-name" aria-hidden="true">
                  {row.agentId}
                </span>{" "}
                <span className="sidebar-agent-state" aria-hidden="true">
                  {short} {row.elapsed}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface StatusBarProps {
  /** The active space: its name and color lead the bar. */
  space: { name: string; color: string };
  /** What the pane in focus says about itself (its folder and branch); none for a pane that is not a terminal. */
  focused: PaneBarInfo | undefined;
  /** How many panes the tab on screen holds. */
  panes: number;
  workspace: Pick<Workspace, "spaces">;
}

/**
 * The bar at the foot of the dense window: the space (in its color), the folder and the branch of the
 * pane in focus, the agents that wait for the person and, at the right end, how many panes the tab
 * holds. What the design also shows (the version of the runtime, the load of the machine, the clock) is
 * not something the app knows, so it is not drawn.
 */
export function StatusBar({ space, focused, panes, workspace }: StatusBarProps) {
  const t = useT();
  const waiting = useAgentRows(workspace).filter((row) => row.state === "waiting").length;
  return (
    <div
      className="status-bar"
      data-nr-part="status-bar"
      role="group"
      aria-label={t("statusBar.label")}
      style={{ "--nr-space-color": space.color } as CSSProperties}
    >
      <span className="status-space" data-nr-part="status-space">
        {space.name}
      </span>
      {focused !== undefined && focused.folder !== "" && (
        <span
          className="status-cell status-folder"
          data-nr-part="status-folder"
          {...(focused.cwd !== undefined ? { title: focused.cwd } : {})}
        >
          {focused.folder}
        </span>
      )}
      {focused?.branch !== undefined && (
        <span
          className="status-cell status-branch"
          data-nr-part="status-branch"
          title={t("tree.branch", { name: focused.branch })}
        >
          <GitBranch size={11} aria-hidden="true" />
          <span className="status-text">{focused.branch}</span>
        </span>
      )}
      {waiting > 0 && (
        <span className="status-cell status-agents" data-nr-part="status-agents">
          <span aria-hidden="true">◆ </span>
          {waiting === 1
            ? t("statusBar.waiting.one")
            : t("statusBar.waiting.other", { count: waiting })}
        </span>
      )}
      <span className="status-fill" />
      <span className="status-cell status-panes" data-nr-part="status-panes">
        {paneCount(panes)}
      </span>
    </div>
  );
}
