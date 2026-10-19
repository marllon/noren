import { formatRestoreTime, layoutPanes } from "@noren/model";
import type { ArchivedItem, ClosedItem, Id, Item, Space, Workspace } from "@noren/model";
import { shortCwd } from "./pane-info";

// The library: the tabs that left their space, as a list to search, restore and delete. Two
// sections: the archive (the auto-archive put them there) and the recently closed (the stack Ctrl+
// Shift+Alt+T reopens from). Pure: the dialog only draws what this returns.

export type LibrarySection = "archive" | "closed";

export const LIBRARY_SECTIONS: readonly LibrarySection[] = ["archive", "closed"];

export const LIBRARY_SECTION_LABELS: Readonly<Record<LibrarySection, string>> = {
  archive: "Archive",
  closed: "Closed",
};

/** What the library calls a tab that has no title. */
export const UNTITLED_TAB = "Untitled tab";

/** One tab of the library, ready to draw. */
export interface LibraryEntry {
  section: LibrarySection;
  itemId: Id;
  title: string;
  spaceId: Id;
  /** The name of the space it came from; the space may be gone, then the text says so. */
  spaceName: string;
  spaceColor: string;
  /** The folder of its focused pane, in full; absent when the pane never reported one. */
  cwd?: string;
  /** The folder in its short form (`~/proj`), absent with `cwd`. */
  cwdShort?: string;
  /** When it was archived or closed. */
  at: number;
  /** That moment as a person reads it (`2026-10-19 14:05`). */
  when: string;
  panes: number;
}

/** The folder of the pane that had the keyboard in the item (else the first pane that has one). */
function itemCwd(item: Item): string | undefined {
  const panes = layoutPanes(item.layout);
  const focused = panes.find((pane) => pane.id === item.focusedPaneId);
  return focused?.cwd ?? panes.find((pane) => pane.cwd !== undefined)?.cwd;
}

function entryOf(
  section: LibrarySection,
  raw: ClosedItem | ArchivedItem,
  at: number,
  spaces: readonly Space[],
  home: string | undefined,
): LibraryEntry {
  const space = spaces.find((s) => s.id === raw.spaceId);
  const cwd = itemCwd(raw.item);
  const title = raw.item.title?.trim();
  return {
    section,
    itemId: raw.item.id,
    title: title !== undefined && title !== "" ? title : UNTITLED_TAB,
    spaceId: raw.spaceId,
    spaceName: space?.name ?? "Deleted space",
    spaceColor: space?.color ?? "var(--nr-muted)",
    ...(cwd !== undefined ? { cwd, cwdShort: shortCwd(cwd, home) } : {}),
    at,
    when: formatRestoreTime(at),
    panes: layoutPanes(raw.item.layout).length,
  };
}

/** The entries of a section, the one that left last first. */
export function libraryEntries(
  workspace: Workspace,
  section: LibrarySection,
  home?: string,
): LibraryEntry[] {
  const entries =
    section === "archive"
      ? workspace.archive.map((raw) =>
          entryOf(section, raw, raw.archivedAt, workspace.spaces, home),
        )
      : workspace.closed.map((raw) => entryOf(section, raw, raw.closedAt, workspace.spaces, home));
  // The lists keep the newest last; a tie keeps the later one first.
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.at - a.entry.at || b.index - a.index)
    .map(({ entry }) => entry);
}

/**
 * The entries that match the query: every word of it (split at blanks, case ignored) must be found
 * in the title or in the folder of the tab. An empty query matches everything. The text of the
 * output is searched by a later task.
 */
export function filterLibrary(entries: readonly LibraryEntry[], query: string): LibraryEntry[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const text = `${entry.title}\n${entry.cwd ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
