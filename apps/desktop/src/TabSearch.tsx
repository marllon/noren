import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { searchTabs } from "./tab-search";
import type { SearchHit, SearchTab, TabHits } from "./tab-search";

interface TabSearchProps {
  /** The text of every open tab, read when the search opened. */
  tabs: readonly SearchTab[];
  /** The user picked a line (Enter or a click). The caller goes there and closes the search. */
  onPick(tab: TabHits, hit: SearchHit): void;
  /** Escape or a click outside. */
  onClose(): void;
}

interface Row {
  tab: TabHits;
  hit: SearchHit;
}

const rowKey = (hit: SearchHit): string => `${hit.paneId}:${hit.row}`;

/** The line with the matched text marked (when the match could be placed). */
function Line({ hit }: { hit: SearchHit }) {
  if (hit.column < 0) return <>{hit.text}</>;
  const end = hit.column + hit.length;
  return (
    <>
      {hit.text.slice(0, hit.column)}
      <mark>{hit.text.slice(hit.column, end)}</mark>
      {hit.text.slice(end)}
    </>
  );
}

/**
 * The search over the output of every open tab: a box and the matching lines grouped by tab, each
 * with its line number. The matching is `searchTabs`. Up and Down move the selection, Enter (or a
 * click) picks a line, Escape closes.
 */
export function TabSearch({ tabs, onPick, onClose }: TabSearchProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchTabs(tabs, query), [tabs, query]);
  const rows = useMemo(
    (): Row[] => results.tabs.flatMap((tab) => tab.hits.map((hit) => ({ tab, hit }))),
    [results],
  );
  const indexOf = useMemo(() => new Map(rows.map((row, i) => [rowKey(row.hit), i])), [rows]);
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
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (currentRow !== undefined) onPick(currentRow.tab, currentRow.hit);
    } else if (event.key === "Tab") {
      // The search box is the only stop: the list is moved with the arrows.
      event.preventDefault();
    }
  };

  const total = rows.length;
  let status = "";
  if (query.trim() === "") status = "Type to search the output of every open tab.";
  else if (total === 0) status = "No matches";
  else if (results.truncated) status = "Showing the first matches only. Narrow the search.";

  return (
    <div
      className="dialog-backdrop palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="tab-search"
        data-nr-part="tab-search"
        role="dialog"
        aria-modal="true"
        aria-label="Search all tabs"
        onKeyDown={onKeyDown}
      >
        <input
          autoFocus
          type="text"
          className="tab-search-input"
          aria-label="Search text in all tabs"
          aria-controls="tab-search-list"
          aria-activedescendant={currentRow !== undefined ? `tab-search-${current}` : undefined}
          placeholder="Search the output of every open tab"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
        />
        <div
          ref={listRef}
          id="tab-search-list"
          className="tab-search-list"
          role="listbox"
          aria-label="Matches"
        >
          {results.tabs.map((tab) => (
            <div
              key={tab.itemId}
              className="tab-search-group"
              role="group"
              aria-label={`${tab.title}, ${tab.space}`}
            >
              <div className="tab-search-head" data-nr-part="tab-search-head">
                <span
                  className="tab-search-dot"
                  aria-hidden="true"
                  style={{ background: tab.spaceColor }}
                />
                <span className="tab-search-title">{tab.title}</span>
                <span className="tab-search-space">{tab.space}</span>
                <span className="tab-search-count">
                  {tab.hits.length}
                  {tab.truncated ? "+" : ""}
                </span>
              </div>
              {tab.hits.map((hit) => {
                const mine = indexOf.get(rowKey(hit)) ?? -1;
                return (
                  <div
                    key={rowKey(hit)}
                    id={`tab-search-${mine}`}
                    className="tab-search-row"
                    role="option"
                    aria-selected={mine === current}
                    data-nr-state={mine === current ? "selected" : undefined}
                    data-nr-item-id={tab.itemId}
                    data-nr-pane-id={hit.paneId}
                    data-nr-line={hit.row + 1}
                    onMouseMove={() => setSelected(mine)}
                    onClick={() => onPick(tab, hit)}
                  >
                    <span className="tab-search-line">{hit.row + 1}</span>
                    <span className="tab-search-text">
                      <Line hit={hit} />
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {status !== "" && (
          <div className="tab-search-status" role="status">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
