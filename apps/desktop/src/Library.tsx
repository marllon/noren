import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Backend, Id, Workspace } from "@noren/model";
import { ConfirmDialog } from "./ConfirmDialog";
import { useT } from "./i18n";
import {
  LIBRARY_SECTIONS,
  filterLibrary,
  libraryEntries,
  loadLibraryTexts,
} from "./library-entries";
import type { LibraryEntry, LibrarySection, LibraryText } from "./library-entries";

interface LibraryProps {
  workspace: Workspace;
  /** Where the saved output of the tabs is read from, for the search to look in it. */
  backend: Pick<Backend, "loadScrollback">;
  /** The home folder, for the short form of a folder. */
  home?: string | undefined;
  /** The section shown first. Default the archive. */
  initialSection?: LibrarySection;
  /** The person asked for a tab back (Enter or a click). The caller restores it and closes the library. */
  onRestore(entry: LibraryEntry): void;
  /** The person confirmed deleting a tab for good. */
  onDelete(entry: LibraryEntry): void;
  /** Escape or a click outside. */
  onClose(): void;
}

/**
 * The library: the archive and the recently closed tabs, one section at a time, with a box that
 * narrows the list by title, folder and saved output (read in the background, so the list shows at
 * once and the search reaches further as the files come in). Up and Down move the selection, Enter restores the selected
 * tab, Escape closes. Deleting asks first, since the saved output goes with the tab.
 */
export function Library({
  workspace,
  backend,
  home,
  initialSection = "archive",
  onRestore,
  onDelete,
  onClose,
}: LibraryProps) {
  const t = useT();
  const [section, setSection] = useState<LibrarySection>(initialSection);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState<LibraryEntry | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const counts = useMemo(
    () => ({ archive: workspace.archive.length, closed: workspace.closed.length }),
    [workspace.archive.length, workspace.closed.length],
  );
  const all = useMemo(() => libraryEntries(workspace, section, home), [workspace, section, home]);
  const [texts, setTexts] = useState<ReadonlyMap<Id, LibraryText>>(() => new Map());
  const rows = useMemo(() => filterLibrary(all, query, texts), [all, query, texts]);
  const current = Math.min(selected, rows.length - 1);
  const currentRow = rows[current];

  // The saved output of the tabs of the section on screen is read after the first frame, a few files
  // at a time, and each one that arrives is searchable at once. A tab is read once while the library
  // is open; closing it stops what has not started.
  const abort = useRef<AbortController | null>(null);
  const requested = useRef(new Set<Id>());
  useEffect(() => {
    abort.current = new AbortController();
    const asked = requested.current;
    return () => {
      abort.current?.abort();
      asked.clear();
    };
  }, []);
  useEffect(() => {
    const signal = abort.current?.signal;
    const fresh = all.filter((entry) => !requested.current.has(entry.itemId));
    if (signal === undefined || fresh.length === 0) return;
    for (const entry of fresh) requested.current.add(entry.itemId);
    void loadLibraryTexts(
      backend,
      fresh,
      (itemId, text) => setTexts((previous) => new Map(previous).set(itemId, text)),
      signal,
    );
  }, [all, backend]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-nr-state="selected"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [current, rows]);

  const move = (delta: number) => {
    if (rows.length > 0) setSelected((current + delta + rows.length) % rows.length);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    // The arrows and Enter drive the list from the search box; on a button they keep their meaning.
    if (event.target !== input.current) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (currentRow !== undefined) onRestore(currentRow);
    }
  };

  let status = "";
  if (rows.length === 0) {
    if (query.trim() !== "") status = t("library.noMatches");
    else if (section === "archive") status = t("library.emptyArchive");
    else status = t("library.emptyClosed");
  }

  return (
    <>
      <div
        className="dialog-backdrop library-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          className="library"
          data-nr-part="library"
          role="dialog"
          aria-modal="true"
          aria-label={t("library.label")}
          onKeyDown={onKeyDown}
        >
          <div className="library-head">
            <div className="library-sections" role="tablist" aria-label={t("library.sections")}>
              {LIBRARY_SECTIONS.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  className="library-section"
                  aria-selected={name === section}
                  data-nr-state={name === section ? "active" : undefined}
                  onClick={() => {
                    setSection(name);
                    setSelected(0);
                    input.current?.focus();
                  }}
                >
                  {t(`library.section.${name}`)}
                  <span className="library-count" aria-hidden="true">
                    {counts[name]}
                  </span>
                </button>
              ))}
            </div>
            <input
              ref={input}
              autoFocus
              type="text"
              className="library-input"
              aria-label={t("library.search")}
              placeholder={t("library.placeholder")}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
            />
          </div>
          <ul ref={listRef} className="library-list" aria-label={t(`library.section.${section}`)}>
            {rows.map((entry, index) => (
              <li
                key={entry.itemId}
                className="library-row"
                data-nr-part="library-row"
                data-nr-state={index === current ? "selected" : undefined}
                data-nr-item-id={entry.itemId}
                onMouseMove={() => setSelected(index)}
              >
                <button
                  type="button"
                  className="library-open"
                  aria-label={[
                    t("library.restore", { title: entry.title }),
                    entry.cwdShort ?? "",
                    `${entry.spaceName} · ${entry.when}`,
                    entry.snippet ?? "",
                  ]
                    .filter((part) => part !== "")
                    .join(" ")}
                  onClick={() => onRestore(entry)}
                >
                  <span
                    className="library-dot"
                    aria-hidden="true"
                    style={{ background: entry.spaceColor }}
                  />
                  {/* The spaces between the parts are not drawn (they are flex items), but they keep the
                      words of one part from running into the next in the text a tool reads. */}
                  <span className="library-title">{entry.title}</span>{" "}
                  <span className="library-cwd" data-nr-part="library-cwd">
                    {entry.cwdShort ?? ""}
                  </span>{" "}
                  <span className="library-meta">
                    {entry.spaceName} · {entry.when}
                  </span>{" "}
                  {entry.snippet !== undefined && (
                    <span className="library-snippet" data-nr-part="library-snippet">
                      {entry.snippet}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="library-delete"
                  aria-label={t("library.delete", { title: entry.title })}
                  onClick={() => setPending(entry)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {status !== "" && (
            <div className="library-status" role="status">
              {status}
            </div>
          )}
        </div>
      </div>
      {pending !== null && (
        <ConfirmDialog
          title={t("library.confirmTitle")}
          message={t("library.confirmMessage", { title: pending.title })}
          confirmLabel={t("library.confirmDelete")}
          onCancel={() => {
            setPending(null);
            input.current?.focus();
          }}
          onConfirm={() => {
            onDelete(pending);
            setPending(null);
            input.current?.focus();
          }}
        />
      )}
    </>
  );
}
