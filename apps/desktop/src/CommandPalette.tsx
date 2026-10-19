import { Command } from "cmdk";
import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { KIND_HEADINGS, searchEntries } from "./palette";
import type { EntryKind, PaletteEntry } from "./palette";

interface CommandPaletteProps {
  entries: readonly PaletteEntry[];
  /** The user picked an entry (Enter or a click). The caller runs it and closes the palette. */
  onRun(entry: PaletteEntry): void;
  /** Escape or a click outside. */
  onClose(): void;
}

/** The entries of one kind, in the order `searchEntries` gave them. */
function ofKind(entries: readonly PaletteEntry[], kind: EntryKind): PaletteEntry[] {
  return entries.filter((entry) => entry.kind === kind);
}

const KINDS: readonly EntryKind[] = ["tab", "space", "action"];

/**
 * The command palette: a search box over the tabs of every space, the spaces and the actions.
 * `cmdk` draws the list and moves the selection; the matching is `searchEntries` (so `cmdk` does
 * not filter on its own). The prefixes `>`, `@` and `#` limit the list to actions, tabs or spaces.
 */
export function CommandPalette({ entries, onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchEntries(entries, query), [entries, query]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Tab") {
      // The search box is the only stop: the list is moved with the arrows.
      event.preventDefault();
    }
  };

  return (
    <div
      className="dialog-backdrop palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        data-nr-part="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <Command shouldFilter={false} loop label="Command palette">
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search tabs, spaces and actions  (> actions, @ tabs, # spaces)"
          />
          <Command.List>
            <Command.Empty>No results</Command.Empty>
            {KINDS.map((kind) => {
              const group = ofKind(results, kind);
              if (group.length === 0) return null;
              return (
                <Command.Group key={kind} heading={KIND_HEADINGS[kind]}>
                  {group.map((entry) => (
                    <Command.Item
                      key={entry.id}
                      value={entry.id}
                      data-nr-kind={entry.kind}
                      onSelect={() => onRun(entry)}
                    >
                      {entry.kind !== "action" && (
                        <span
                          className="palette-dot"
                          aria-hidden="true"
                          style={{ background: entry.spaceColor }}
                        />
                      )}
                      <span className="palette-title">{entry.title}</span>
                      <span className="palette-detail">{entry.detail}</span>
                      {entry.kind === "action" && entry.chord !== undefined && (
                        <kbd className="palette-chord">{entry.chord}</kbd>
                      )}
                    </Command.Item>
                  ))}
                </Command.Group>
              );
            })}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
