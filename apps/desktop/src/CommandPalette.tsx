import { commandRequestOf } from "@noren/model";
import { Command } from "cmdk";
import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ContextMenu, menuPoint } from "./ContextMenu";
import type { MenuEntry } from "./ContextMenu";
import { useT } from "./i18n";
import { kindHeading, searchEntries } from "./palette";
import type { EntryKind, PaletteEntry } from "./palette";
import type { MenuPoint } from "./SpaceMenu";

/** The small menu a row of the palette can open: its name and its lines. */
export interface EntryMenu {
  label: string;
  entries: MenuEntry[];
}

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
  /**
   * What a right click on a row opens (the menu key and Shift+F10 do the same for the highlighted
   * one): a small menu, or nothing for a row that has none. It opens inside the palette, which stays
   * open, and the keyboard goes back to the search box when it closes.
   */
  entryMenu?(entry: PaletteEntry): EntryMenu | undefined;
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
  entryMenu,
}: CommandPaletteProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<(EntryMenu & { point: MenuPoint }) | null>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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

  const closeMenu = () => {
    setMenu(null);
    inputRef.current?.focus();
  };

  /** Opens the menu of a row at the point, when the row has one. Returns whether it did. */
  const openMenu = (entry: PaletteEntry, point: MenuPoint): boolean => {
    const model = entryMenu?.(entry);
    if (model === undefined) return false;
    setMenu({ ...model, point });
    return true;
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
        ref={paletteRef}
        className="palette"
        data-nr-part="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.label")}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          // The menu key and Shift+F10 raise this on the search box (a pointer on a row was handled by
          // the row, and the pointer button of a right click is 2): they act on the highlighted row, at
          // the place the row is. It is this event and not the key that opens the menu, because the
          // browser raises it after the key, and the menu would close on it once the focus is inside.
          if (event.defaultPrevented || menu !== null || event.button === 2) return;
          const wanted = highlighted.trim().toLowerCase();
          const entry = results.find((candidate) => candidate.id.toLowerCase() === wanted);
          const row = paletteRef.current?.querySelector('[cmdk-item][data-selected="true"]');
          const box = row?.getBoundingClientRect();
          if (entry !== undefined && openMenu(entry, { x: box?.left ?? 0, y: box?.top ?? 0 })) {
            event.preventDefault();
          }
        }}
      >
        <Command
          shouldFilter={false}
          loop
          label={t("palette.label")}
          value={highlighted}
          onValueChange={onValueChange}
        >
          <Command.Input
            ref={inputRef}
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
                      onContextMenu={(event) => {
                        if (openMenu(entry, menuPoint(event))) event.preventDefault();
                      }}
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
        {menu !== null && (
          <ContextMenu
            label={menu.label}
            point={menu.point}
            entries={menu.entries.map((line) => ({
              ...line,
              onSelect: () => {
                closeMenu();
                line.onSelect();
              },
            }))}
            onClose={closeMenu}
          />
        )}
      </div>
    </div>
  );
}
