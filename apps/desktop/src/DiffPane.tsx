import { sideBySideRows } from "@noren/model";
import type { DiffCell, DiffRow, GitDiffFile, Pane } from "@noren/model";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  MAX_DIFF_ROWS_SHOWN,
  contentOf,
  fileKey,
  fileNote,
  loadDiff,
  statusLetter,
  statusText,
} from "./diff-view";
import type { DiffContent, DiffReader, DiffState } from "./diff-view";
import { useT } from "./i18n";

interface DiffPaneProps {
  backend: DiffReader;
  pane: Pane;
  /**
   * True while the pane is on screen (its tab and its space are shown and no other pane is zoomed
   * over it). The diff is read when the pane first is, and again each time it comes back.
   */
  visible: boolean;
}

/** The folder is on top with the refresh button; under it the files of the diff and the selected one side by side. */
interface DiffViewProps {
  cwd: string;
  content: DiffContent;
  /** The key (`fileKey`) of the file whose rows are drawn; the first file when absent or unknown. */
  selected: string | undefined;
  onSelect(key: string): void;
  onRefresh(): void;
  /** The file whose rows are all drawn, past the cap. */
  expanded: string | undefined;
  onExpand(key: string): void;
}

/** An empty line still takes a row of its own, so a cell that holds one is not empty: a no-break space. */
const BLANK_LINE = String.fromCharCode(0xa0);

/** One cell of the text of a side: its sign for a changed line, the text, and a note for the end of the file. */
/** What a cell of a row holds: nothing, a line both files have, a deleted line or an added one. */
function cellKind(
  cell: DiffCell | undefined,
  side: "old" | "new",
  kind: "context" | "change",
): "empty" | "context" | "del" | "add" {
  if (cell === undefined) return "empty";
  if (kind === "context") return "context";
  return side === "old" ? "del" : "add";
}

function TextCell({
  cell,
  side,
  kind,
}: {
  cell: DiffCell | undefined;
  side: "old" | "new";
  kind: "context" | "change";
}) {
  const t = useT();
  if (cell === undefined) {
    return <td className="diff-text" data-nr-side={side} data-nr-kind="empty" />;
  }
  const sign = kind === "context" ? " " : side === "old" ? "-" : "+";
  return (
    <td className="diff-text" data-nr-side={side} data-nr-kind={cellKind(cell, side, kind)}>
      <span className="diff-sign" aria-hidden="true">
        {sign}
      </span>
      {cell.text === "" ? BLANK_LINE : cell.text}
      {cell.noEol === true && (
        <span className="diff-noeol" data-nr-part="diff-noeol">
          {t("diff.noEol")}
        </span>
      )}
    </td>
  );
}

function NumberCell({
  cell,
  side,
  kind,
}: {
  cell: DiffCell | undefined;
  side: "old" | "new";
  kind: "context" | "change";
}) {
  // The kind comes before the side here, and after it in a text cell: a test can tell them apart.
  return (
    <td className="diff-no" data-nr-kind={cellKind(cell, side, kind)} data-nr-side={side}>
      {cell?.no}
    </td>
  );
}

function RowView({ row }: { row: DiffRow }) {
  if (row.kind === "hunk") {
    return (
      <tr className="diff-row diff-hunk" data-nr-row="hunk">
        <td colSpan={4}>
          {row.label}
          {row.heading !== "" ? ` ${row.heading}` : ""}
        </td>
      </tr>
    );
  }
  const oldCell = row.old;
  const newCell = row.new;
  const kind = row.kind;
  return (
    <tr className="diff-row" data-nr-row={kind}>
      <NumberCell cell={oldCell} side="old" kind={kind} />
      <TextCell cell={oldCell} side="old" kind={kind} />
      <NumberCell cell={newCell} side="new" kind={kind} />
      <TextCell cell={newCell} side="new" kind={kind} />
    </tr>
  );
}

/** The rows of one file, side by side: the old file on the left and the new one on the right. */
function FileView({
  file,
  expanded,
  onExpand,
}: {
  file: GitDiffFile;
  expanded: boolean;
  onExpand(): void;
}) {
  const t = useT();
  const rows = useMemo(() => sideBySideRows(file), [file]);
  const shown = expanded ? rows : rows.slice(0, MAX_DIFF_ROWS_SHOWN);
  const note = fileNote(file);
  return (
    <>
      <div className="diff-file-head" data-nr-part="diff-file-head">
        <span className="diff-file-title" data-nr-part="diff-file-title">
          {file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="diff-file-status">{statusText(file.status)}</span>
        {file.similarity !== undefined && (
          <span className="diff-file-status">
            {t("diff.similarity", { percent: file.similarity })}
          </span>
        )}
      </div>
      {note !== undefined && (
        <p className="diff-note" data-nr-part="diff-note">
          {note}
        </p>
      )}
      {file.hunks.length > 0 && (
        <table className="diff-table" data-nr-part="diff-table">
          <caption className="sr-only">{t("diff.content", { name: file.path })}</caption>
          <colgroup>
            <col className="diff-col-no" />
            <col className="diff-col-text" />
            <col className="diff-col-no" />
            <col className="diff-col-text" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" colSpan={2}>
                {t("diff.side.old")}
              </th>
              <th scope="col" colSpan={2}>
                {t("diff.side.new")}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <RowView key={index} row={row} />
            ))}
          </tbody>
        </table>
      )}
      {shown.length < rows.length && (
        <p className="diff-note" data-nr-part="diff-more">
          {t("diff.more", { shown: shown.length, total: rows.length })}{" "}
          <button type="button" className="diff-more-button" onClick={onExpand}>
            {t("diff.showAll")}
          </button>
        </p>
      )}
    </>
  );
}

/**
 * What a diff pane shows, from the content already decided. Drawn as React elements only: the text
 * of a file is a text node in a table cell, so nothing a file holds becomes markup.
 */
export function DiffView({
  cwd,
  content,
  selected,
  onSelect,
  onRefresh,
  expanded,
  onExpand,
}: DiffViewProps) {
  const t = useT();
  let body;
  switch (content.type) {
    case "loading":
      body = (
        <p className="diff-note" role="status" data-nr-part="diff-note">
          {t("diff.loading")}
        </p>
      );
      break;
    case "clean":
      body = (
        <p className="diff-note" data-nr-part="diff-clean">
          {t("diff.clean")}
        </p>
      );
      break;
    case "refused":
    case "failed":
      body = (
        <p
          className="diff-note diff-problem"
          role="alert"
          data-nr-part="diff-problem"
          data-nr-reason={content.type === "refused" ? content.reason : "failed"}
        >
          {content.message}
        </p>
      );
      break;
    case "files": {
      const file = content.files.find((f) => fileKey(f) === selected) ?? content.files[0];
      body = (
        <div className="diff-body" data-nr-part="diff-body">
          <ul className="diff-files" data-nr-part="diff-files" aria-label={t("diff.files")}>
            {content.files.map((entry) => {
              const key = fileKey(entry);
              const current = file !== undefined && fileKey(file) === key;
              return (
                <li key={key}>
                  <button
                    type="button"
                    className="diff-file-button"
                    data-nr-part="diff-file"
                    data-nr-status={entry.status}
                    data-nr-path={entry.path}
                    aria-current={current ? "true" : undefined}
                    onClick={() => onSelect(key)}
                  >
                    <span className="diff-letter" aria-hidden="true">
                      {statusLetter(entry.status)}
                    </span>
                    <span className="sr-only">{statusText(entry.status)}: </span>
                    <span className="diff-file-name" title={entry.path}>
                      {entry.path}
                    </span>
                    <span className="diff-counts" aria-hidden="true">
                      {entry.binary ? t("diff.binary") : `+${entry.added} −${entry.removed}`}
                    </span>
                    <span className="sr-only">
                      {entry.binary
                        ? t("diff.binary")
                        : t("diff.counts", { added: entry.added, removed: entry.removed })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div
            className="diff-file"
            data-nr-part="diff-content"
            // The rows scroll, so the keyboard must be able to reach them.
            tabIndex={0}
            role="region"
            aria-label={t("diff.content", { name: file?.path ?? "" })}
          >
            {file !== undefined && (
              <FileView
                key={fileKey(file)}
                file={file}
                expanded={expanded === fileKey(file)}
                onExpand={() => onExpand(fileKey(file))}
              />
            )}
          </div>
        </div>
      );
      break;
    }
  }
  return (
    <div
      className="diff-pane"
      data-nr-part="diff-pane"
      data-nr-kind={content.type}
      role="group"
      aria-label={t("diff.pane")}
    >
      <div className="diff-head" data-nr-part="diff-head">
        <span className="diff-path" data-nr-part="diff-path" title={cwd}>
          <span className="sr-only">{t("diff.folder")}: </span>
          {cwd}
        </span>
        <button
          type="button"
          className="diff-refresh"
          data-nr-part="diff-refresh"
          aria-label={t("diff.refresh")}
          title={t("diff.refresh")}
          onClick={onRefresh}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      {body}
    </div>
  );
}

/**
 * A pane that shows the git diff of a folder: the folder on top, the files that changed in a list
 * and the one picked side by side. The diff is read when the pane first is on screen, again each time
 * it comes back to the screen, when the folder changes and when the refresh button is pressed, so
 * what shows is what git says then. The pane owns no session and starts no shell.
 */
export function DiffPane({ backend, pane, visible }: DiffPaneProps) {
  const cwd = pane.cwd ?? "";
  const [read, setRead] = useState<{ cwd: string; state: DiffState } | undefined>(undefined);
  const [reloads, setReloads] = useState(0);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!visible) return undefined;
    let current = true;
    void loadDiff(backend, cwd).then((state) => {
      if (current) setRead({ cwd, state });
    });
    return () => {
      current = false;
    };
  }, [backend, cwd, visible, reloads]);
  // The answer of an earlier folder is not the answer for this one.
  const state: DiffState = read?.cwd === cwd ? read.state : { status: "loading" };
  const content = useMemo(() => contentOf(state), [state]);
  return (
    <DiffView
      cwd={cwd}
      content={content}
      selected={selected}
      onSelect={setSelected}
      onRefresh={() => setReloads((count) => count + 1)}
      expanded={expanded}
      onExpand={setExpanded}
    />
  );
}
