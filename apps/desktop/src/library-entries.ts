import {
  formatRestoreTime,
  isScrollbackPaneId,
  layoutPanes,
  snapshotSearchText,
} from "@noren/model";
import type { Backend } from "@noren/model";
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
  /** The panes that say they have a saved output (the files the search of its text reads). */
  outputPaneIds: Id[];
  /** Only in the result of `filterLibrary`: the short piece of output that made the tab match. */
  snippet?: string;
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
    outputPaneIds: layoutPanes(raw.item.layout)
      .filter((pane) => pane.scrollbackRef !== undefined && isScrollbackPaneId(pane.id))
      .map((pane) => pane.id),
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

/** The saved output of a tab, as the search reads it: the text, and the same in lower case. */
export interface LibraryText {
  /** Printable text and line breaks, no colors and no escapes (`snapshotSearchText`). */
  text: string;
  /** `text` in lower case, made once so each key typed does not make it again. */
  lower: string;
}

/** The searchable form of text that is already plain. */
export function libraryText(text: string): LibraryText {
  return { text, lower: text.toLowerCase() };
}

/** The longest snippet shown, in characters. */
export const SNIPPET_LENGTH = 100;

/** How much of the line before the match a snippet keeps when the line is cut. */
const SNIPPET_LEAD = 30;

/** The line that made `words` match, shortened around the first word, with blanks collapsed. */
function snippetOf(text: LibraryText, words: readonly string[]): string | undefined {
  const lines = text.text.split("\n");
  const lowerLines = text.lower.split("\n");
  // A line with every word is the best answer; else the first line that has the first word.
  let at = lowerLines.findIndex((line) => words.every((word) => line.includes(word)));
  if (at < 0) at = lowerLines.findIndex((line) => line.includes(words[0] ?? ""));
  const line = lines[at];
  const lower = lowerLines[at];
  if (line === undefined || lower === undefined) return undefined;
  const found = Math.max(0, lower.indexOf(words[0] ?? ""));
  const from = Math.max(0, found - SNIPPET_LEAD);
  const piece = line.slice(from, from + SNIPPET_LENGTH).replace(/\s+/g, " ");
  const snippet = `${from > 0 ? "…" : ""}${piece.trim()}${from + SNIPPET_LENGTH < line.length ? "…" : ""}`;
  return snippet === "" ? undefined : snippet;
}

/**
 * The entries that match the query: every word of it (split at blanks, case ignored) must be found
 * in the title, in the folder or in the saved output of the tab (`texts`, by item id; a tab with no
 * text there is searched by title and folder alone). An empty query matches everything. An entry
 * that matched only because of its output comes back as a copy with `snippet`: the line that has
 * the words, shortened. The snippet is plain text, to be drawn as text and never as markup.
 */
export function filterLibrary(
  entries: readonly LibraryEntry[],
  query: string,
  texts?: ReadonlyMap<Id, LibraryText>,
): LibraryEntry[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return [...entries];
  const found: LibraryEntry[] = [];
  for (const entry of entries) {
    const head = `${entry.title}\n${entry.cwd ?? ""}`.toLowerCase();
    const outputOnly = words.filter((word) => !head.includes(word));
    if (outputOnly.length === 0) {
      found.push(entry);
      continue;
    }
    const text = texts?.get(entry.itemId);
    if (text === undefined || !outputOnly.every((word) => text.lower.includes(word))) continue;
    const snippet = snippetOf(text, outputOnly);
    found.push(snippet !== undefined ? { ...entry, snippet } : entry);
  }
  return found;
}

/** How many saved outputs are read at once. */
const READ_AT_ONCE = 4;

/**
 * Reads the saved output of the tabs of `entries`, one text per tab (its panes' outputs, in order,
 * one under the other), cleaned like any snapshot that comes from disk. `onText` hears each one as
 * soon as it is read, so the search can use what is there while the rest loads; a tab with no
 * output, an unreadable file or an output that cleans to nothing is skipped. Stops starting new
 * reads when `signal` aborts. Never rejects.
 */
export async function loadLibraryTexts(
  backend: Pick<Backend, "loadScrollback">,
  entries: readonly LibraryEntry[],
  onText: (itemId: Id, text: LibraryText) => void,
  signal?: AbortSignal,
): Promise<void> {
  const queue = entries.filter((entry) => entry.outputPaneIds.length > 0);
  const readEntry = async (entry: LibraryEntry) => {
    const parts: string[] = [];
    for (const paneId of entry.outputPaneIds) {
      try {
        const raw = await backend.loadScrollback(paneId);
        const text = raw === null ? "" : snapshotSearchText(raw);
        if (text !== "") parts.push(text);
      } catch {
        // A file that cannot be read is not searched; the tab still matches by title and folder.
      }
    }
    if (parts.length > 0 && signal?.aborted !== true)
      onText(entry.itemId, libraryText(parts.join("\n")));
  };
  const worker = async () => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      if (signal?.aborted === true) return;
      await readEntry(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, queue.length) }, worker));
}
