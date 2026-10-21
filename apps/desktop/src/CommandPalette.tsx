import { commandRequestOf } from "@noren/model";
import { Command } from "cmdk";
import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { useT } from "./i18n";
import { kindHeading, searchEntries } from "./palette";
import type { EntryKind, PaletteEntry } from "./palette";

interface CommandPaletteProps {
  entries: readonly PaletteEntry[];
  /** The user picked an entry (Enter or a click). The caller runs it and closes the palette. */
  onRun(entry: PaletteEntry): void;
  /** Escape or a click outside. */
  onClose(): void;
  /**
   * The highlighted entry changed (the arrows, the pointer, or a new search), or nothing is
   * highlighted (`undefined`). A theme entry shows its theme at once, unsaved.
   */
  onHighlight?(entry: PaletteEntry | undefined): void;
  /**
   * "? text": the person asks for a command in words. Given only where the AI is on: without it a
   * query that starts with `?` is a search like any other and nothing offers the AI. The caller
   * closes the palette and shows what will be sent; nothing is sent from here.
   */
  onAskCommand?(request: string): void;
  /** Replaces the hint in the search box (the list of "Set theme for this space" has its own). */
  placeholder?: string;
}

/** The entries of one kind, in the order `searchEntries` gave them. */
function ofKind(entries: readonly PaletteEntry[], kind: EntryKind): PaletteEntry[] {
  return entries.filter((entry) => entry.kind === kind);
}

const KINDS: readonly EntryKind[] = [
  "tab",
  "space",
  "action",
  "profile",
  "folder",
  "theme",
  "plugin",
  "space-theme",
];

/**
 * The command palette: a search box over the tabs of every space, the spaces, the actions, the shell
 * profiles, the recent folders and the themes.
 * `cmdk` draws the list and moves the selection; the matching is `searchEntries` (so `cmdk` does
 * not filter on its own). The prefixes `>`, `@` and `#` limit the list to commands (the actions,
 * profiles, folders and themes), tabs or spaces.
 */
export function CommandPalette({
  entries,
  onRun,
  onClose,
  onHighlight,
  onAskCommand,
  placeholder,
}: CommandPaletteProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  // The highlighted entry is controlled: `cmdk` only reports a change of it when it is.
  const [highlighted, setHighlighted] = useState("");
  // A query that starts with `?` asks for a command, where the AI is on; the list gives way to it.
  const request = onAskCommand === undefined ? undefined : commandRequestOf(query);
  const results = useMemo(
    () => (request !== undefined ? [] : searchEntries(entries, query)),
    [entries, query, request],
  );

  // `cmdk` hands back the value it was given (the id), trimmed and, in some versions, lower-cased.
  const onValueChange = (value: string) => {
    setHighlighted(value);
    const wanted = value.trim().toLowerCase();
    onHighlight?.(results.find((entry) => entry.id.toLowerCase() === wanted));
  };

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
        aria-label={t("palette.label")}
        onKeyDown={onKeyDown}
      >
        <Command
          shouldFilter={false}
          loop
          label={t("palette.label")}
          value={highlighted}
          onValueChange={onValueChange}
        >
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={
              placeholder ??
              (onAskCommand !== undefined ? t("palette.placeholderAsk") : t("palette.placeholder"))
            }
          />
          <Command.List>
            {request !== undefined ? (
              request === "" ? (
                <p className="palette-hint" data-nr-part="palette-ask-hint">
                  {t("palette.askHint")}
                </p>
              ) : (
                <Command.Item
                  key="ask-command"
                  value="ask-command"
                  data-nr-kind="ask-command"
                  onSelect={() => onAskCommand?.(request)}
                >
                  <span className="palette-title">{t("palette.askItem", { request })}</span>
                  <span className="palette-detail">{t("palette.askDetail")}</span>
                </Command.Item>
              )
            ) : (
              <Command.Empty>{t("palette.empty")}</Command.Empty>
            )}
            {KINDS.map((kind) => {
              const group = ofKind(results, kind);
              if (group.length === 0) return null;
              return (
                <Command.Group key={kind} heading={kindHeading(kind)}>
                  {group.map((entry) => (
                    <Command.Item
                      key={entry.id}
                      value={entry.id}
                      data-nr-kind={entry.kind}
                      onSelect={() => onRun(entry)}
                    >
                      {(entry.kind === "tab" || entry.kind === "space") && (
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
