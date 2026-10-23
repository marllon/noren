import { Bot, Columns2, Folder, GitBranch, Maximize, Minimize, Rows2, X } from "lucide-react";
import { useT } from "./i18n";
import { commandWords, exitText, folderParts } from "./pane-info";
import type { PaneBarInfo } from "./pane-info";
import { ariaShortcutOf, useChord } from "./shortcut-keys";
import { formatChord } from "./shortcuts-screen";
import type { SplitDir } from "./TreeMenus";

/**
 * The header of a terminal pane. Under the glass style: the folder, the git branch, the command, the
 * badge of an agent that waits for you, and at the right end the buttons that split the pane and
 * zoom it. Under the dense style (`dense`): the number of the pane, what it runs (the command, else
 * the word Terminal), its folder, whether the command runs or failed, the same badge and the buttons,
 * with one more that closes the pane in a tab that holds several (the branch is in the status bar).
 * It is a strip of fixed height, so what it says changing never moves the terminal under it.
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
  /** The dense header: the place of the pane in its tab (1 is the first), written before its title. */
  number?: number;
  /** The dense header: closes the pane; a page that cannot, or a tab of one pane, leaves it out and has no button. */
  onClose?(): void;
  /** Draws the header of the dense style. */
  dense?: boolean;
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
  onClose,
  dense = false,
}: Pick<
  PaneBarProps,
  "zoomable" | "zoomed" | "canSplit" | "onSplit" | "onZoom" | "onClose" | "dense"
>) {
  const t = useT();
  const size = dense ? 12 : 16;
  const splitRight = useChord("pane.split-right");
  const splitDown = useChord("pane.split-below");
  const zoom = useChord("pane.zoom");
  if (onSplit === undefined && !zoomable && onClose === undefined) return null;
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
            <Columns2 size={size} aria-hidden="true" />
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
            <Rows2 size={size} aria-hidden="true" />
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
          <ZoomIcon size={size} aria-hidden="true" />
        </button>
      )}
      {onClose !== undefined && (
        <button
          type="button"
          className="pane-bar-button"
          data-nr-part="pane-bar-close"
          aria-label={t("pane.close")}
          title={t("pane.close")}
          onClick={onClose}
        >
          <X size={size} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** What the dense header says of the command: it runs (a filled square), or it failed with a code. */
function DenseState({ info }: { info: PaneBarInfo }) {
  const t = useT();
  const command = info.command;
  if (command === undefined) return null;
  const failed = command.state === "failed" && command.exitCode !== undefined;
  if (command.state !== "running" && !failed) return null;
  return (
    <span
      className="pane-bar-state"
      data-nr-part="pane-state"
      data-nr-state={command.state}
      aria-hidden="true"
    >
      <span className="pane-bar-dot" />
      {command.state === "running" ? t("pane.running") : exitText(command)}
    </span>
  );
}

/** The header of the dense style: the number, what runs, where, how it is, and the buttons. */
function DensePaneBar({
  info,
  waiting,
  zoomable,
  zoomed,
  canSplit,
  onSplit,
  onZoom,
  onClose,
  number,
}: PaneBarProps) {
  const t = useT();
  const command = info.command;
  const words = command !== undefined ? commandWords(command) : undefined;
  const title = command?.text ?? t("pane.title");
  return (
    <div className="pane-bar" data-nr-part="pane-bar" data-nr-style="dense">
      <div className="pane-bar-info">
        {number !== undefined && (
          <span className="pane-bar-num" data-nr-part="pane-number" aria-hidden="true">
            {number}
          </span>
        )}
        <span
          className="pane-bar-title"
          data-nr-part="pane-command"
          {...(command !== undefined ? { "data-nr-state": command.state } : {})}
          {...(words !== undefined ? { title: words } : {})}
        >
          <span aria-hidden="true">{title}</span>
          {words !== undefined && <span className="sr-only">{words}</span>}
        </span>
        {info.folder !== "" && (
          <span
            className="pane-bar-path"
            data-nr-part="pane-folder"
            {...(info.cwd !== undefined ? { title: info.cwd } : {})}
          >
            {info.folder}
          </span>
        )}
        <DenseState info={info} />
        {waiting && (
          <span className="pane-bar-agent" data-nr-part="pane-agent-badge" aria-hidden="true">
            ◆ {t("pane.agentWaitingBadge")}
          </span>
        )}
      </div>
      <Actions
        zoomable={zoomable}
        zoomed={zoomed}
        canSplit={canSplit}
        dense
        {...(onSplit !== undefined ? { onSplit } : {})}
        {...(onClose !== undefined ? { onClose } : {})}
        onZoom={onZoom}
      />
    </div>
  );
}

export function PaneBar(props: PaneBarProps) {
  if (props.dense === true) return <DensePaneBar {...props} />;
  return <GlassPaneBar {...props} />;
}

function GlassPaneBar({
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
