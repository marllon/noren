import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Workspace } from "@noren/model";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  LIBRARY_SECTIONS,
  LIBRARY_SECTION_LABELS,
  filterLibrary,
  libraryEntries,
} from "./library-entries";
import type { LibraryEntry, LibrarySection } from "./library-entries";

interface LibraryProps {
  workspace: Workspace;
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
 * narrows the list by title and folder. Up and Down move the selection, Enter restores the selected
 * tab, Escape closes. Deleting asks first, since the saved output goes with the tab.
 */
export function Library({
  workspace,
  home,
  initialSection = "archive",
  onRestore,
  onDelete,
  onClose,
}: LibraryProps) {
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
  const rows = useMemo(() => filterLibrary(all, query), [all, query]);
  const current = Math.min(selected, rows.length - 1);
  const currentRow = rows[current];

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
    if (query.trim() !== "") status = "No matches";
    else if (section === "archive") status = "Nothing in the archive yet.";
    else status = "No recently closed tabs.";
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
          aria-label="Library"
          onKeyDown={onKeyDown}
        >
          <div className="library-head">
            <div className="library-sections" role="tablist" aria-label="Library sections">
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
                  {LIBRARY_SECTION_LABELS[name]}
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
              aria-label="Search the library"
              placeholder="Search by title or folder"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
            />
          </div>
          <ul ref={listRef} className="library-list" aria-label={LIBRARY_SECTION_LABELS[section]}>
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
                  aria-label={`Restore ${entry.title}`}
                  onClick={() => onRestore(entry)}
                >
                  <span
                    className="library-dot"
                    aria-hidden="true"
                    style={{ background: entry.spaceColor }}
                  />
                  <span className="library-title">{entry.title}</span>
                  <span className="library-cwd" data-nr-part="library-cwd">
                    {entry.cwdShort ?? ""}
                  </span>
                  <span className="library-meta">
                    {entry.spaceName} · {entry.when}
                  </span>
                </button>
                <button
                  type="button"
                  className="library-delete"
                  aria-label={`Delete ${entry.title}`}
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
          title="Delete from library"
          message={`Delete "${pending.title}" for good? Its saved output is deleted with it.`}
          confirmLabel="Delete"
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
