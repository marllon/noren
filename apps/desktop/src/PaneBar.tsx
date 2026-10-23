import { Bot, Columns2, Folder, GitBranch, Maximize, Minimize, Rows2 } from "lucide-react";
import { useT } from "./i18n";
import { commandWords, exitText, folderParts } from "./pane-info";
import type { PaneBarInfo } from "./pane-info";
import { ariaShortcutOf, useChord } from "./shortcut-keys";
import { formatChord } from "./shortcuts-screen";
import type { SplitDir } from "./TreeMenus";

/**
 * The header of a terminal pane under the glass style: the folder, the git branch, the command, the
 * badge of an agent that waits for you, and at the right end the buttons that split the pane and
 * zoom it. It is a strip of fixed height, so what it says changing never moves the terminal under it.
 * The dense style draws none of it (the page asks; its split buttons are the hover corner).
 */

interface PaneBarProps {
  info: PaneBarInfo;
  /** An agent in the pane waits for the person: the badge says so. */
  waiting: boolean;
  /** Only a tab with several panes has something to zoom. */
  zoomable: boolean;
  zoomed: boolean;
  /** False when the tab already holds as many panes as it may: the split buttons are off. */
  canSplit: boolean;
  /** Splits the pane; a page that cannot (a window of a space) leaves it out and has no split buttons. */
  onSplit?(dir: SplitDir): void;
  onZoom(): void;
}

/** The title of a button with the shortcut of its action: `Split right (Ctrl+Shift+D)`. */
function titled(label: string, chord: string | undefined): string {
  return chord === undefined ? label : `${label} (${formatChord(chord)})`;
}

/** The folder, the last segment in a heavier weight so it is the part that stays readable when the rest is cut. */
function FolderPath({ info }: { info: PaneBarInfo }) {
  const t = useT();
  const { head, tail } = folderParts(info.folder === "" ? t("pane.title") : info.folder);
  return (
    <span
      className="pane-bar-folder"
      data-nr-part="pane-folder"
      {...(info.cwd !== undefined ? { title: info.cwd } : {})}
    >
      <Folder size={15} aria-hidden="true" />
      <span className="pane-bar-path">
        {head !== "" && <span className="pane-bar-head">{head}</span>}
        <b className="pane-bar-tail">{tail}</b>
      </span>
    </span>
  );
}

/** The command the pane runs, or the last one that ended; nothing when the shell never told one. */
function Command({ info }: { info: PaneBarInfo }) {
  const t = useT();
  const command = info.command;
  if (command === undefined) return null;
  // A command that ended and whose line the shell never told has nothing to show but its code.
  const ended = command.state === "done" || command.state === "failed";
  if (ended && command.text === undefined) return null;
  const words = commandWords(command);
  const text = command.text ?? (command.state === "running" ? t("pane.runningSome") : "");
  return (
    <span
      className="pane-bar-chip pane-bar-command"
      data-nr-part="pane-command"
      data-nr-state={command.state}
      title={words}
    >
      <span className="pane-bar-dot" aria-hidden="true" />
      <span className="pane-bar-chip-text" aria-hidden="true">
        {text}
      </span>
      {command.state === "failed" && command.exitCode !== undefined && (
        <span className="pane-bar-code" aria-hidden="true">
          {exitText(command)}
        </span>
      )}
      <span className="sr-only">{words}</span>
    </span>
  );
}

/** The buttons at the right end of the bar: split right, split down and, in a split tab, zoom. */
function Actions({
  zoomable,
  zoomed,
  canSplit,
  onSplit,
  onZoom,
}: Pick<PaneBarProps, "zoomable" | "zoomed" | "canSplit" | "onSplit" | "onZoom">) {
  const t = useT();
  const splitRight = useChord("pane.split-right");
  const splitDown = useChord("pane.split-below");
  const zoom = useChord("pane.zoom");
  if (onSplit === undefined && !zoomable) return null;
  const zoomLabel = zoomed ? t("pane.restore") : t("pane.zoom");
  const ZoomIcon = zoomed ? Minimize : Maximize;
  return (
    <div className="pane-bar-actions" data-nr-part="pane-bar-actions">
      {onSplit !== undefined && (
        <>
          <button
            type="button"
            className="pane-bar-button"
            data-nr-part="pane-bar-split-right"
            aria-label={t("menu.splitRight")}
            title={titled(t("menu.splitRight"), splitRight)}
            {...(splitRight !== undefined
              ? { "aria-keyshortcuts": ariaShortcutOf(splitRight) }
              : {})}
            disabled={!canSplit}
            onClick={() => onSplit("row")}
          >
            <Columns2 size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="pane-bar-button"
            data-nr-part="pane-bar-split-down"
            aria-label={t("menu.splitDown")}
            title={titled(t("menu.splitDown"), splitDown)}
            {...(splitDown !== undefined ? { "aria-keyshortcuts": ariaShortcutOf(splitDown) } : {})}
            disabled={!canSplit}
            onClick={() => onSplit("column")}
          >
            <Rows2 size={16} aria-hidden="true" />
          </button>
        </>
      )}
      {zoomable && (
        <button
          type="button"
          className="pane-bar-button"
          data-nr-part="pane-bar-zoom"
          aria-label={zoomLabel}
          title={titled(zoomLabel, zoom)}
          {...(zoom !== undefined ? { "aria-keyshortcuts": ariaShortcutOf(zoom) } : {})}
          onClick={onZoom}
        >
          <ZoomIcon size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function PaneBar({
  info,
  waiting,
  zoomable,
  zoomed,
  canSplit,
  onSplit,
  onZoom,
}: PaneBarProps) {
  const t = useT();
  return (
    <div className="pane-bar" data-nr-part="pane-bar">
      <div className="pane-bar-info">
        <FolderPath info={info} />
        {info.branch !== undefined && (
          <span
            className="pane-bar-chip pane-bar-branch"
            data-nr-part="pane-branch"
            title={t("tree.branch", { name: info.branch })}
          >
            <GitBranch size={13} aria-hidden="true" />
            <span className="pane-bar-chip-text" aria-hidden="true">
              {info.branch}
            </span>
            <span className="sr-only">{t("tree.branch", { name: info.branch })}</span>
          </span>
        )}
        <Command info={info} />
        {waiting && (
          <span
            className="pane-bar-chip pane-bar-agent"
            data-nr-part="pane-agent-badge"
            aria-hidden="true"
          >
            <Bot size={13} aria-hidden="true" />
            <span className="pane-bar-chip-text">{t("pane.agentWaitingBadge")}</span>
          </span>
        )}
      </div>
      <Actions
        zoomable={zoomable}
        zoomed={zoomed}
        canSplit={canSplit}
        {...(onSplit !== undefined ? { onSplit } : {})}
        onZoom={onZoom}
      />
    </div>
  );
}
