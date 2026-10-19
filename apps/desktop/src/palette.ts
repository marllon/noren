// The pure parts of the command palette: the entries it can list (tabs of every space, spaces,
// registry actions with their chord), the prefixes that narrow the list and the fuzzy match that
// orders it. The palette itself (`CommandPalette.tsx`) only draws what this returns.

import type { Id, Workspace } from "@noren/model";
import { itemTitle } from "./favorites";
import { ACTIONS } from "./keybindings";
import type { ActionDef, ChordMap } from "./keybindings";
import { shortCwd, summarizeItem } from "./pane-info";
import { formatChord } from "./shortcuts-screen";
import { spaceItemIds } from "./workspace-store";

interface EntryBase {
  /** Unique across kinds (the list key and the value `cmdk` reports on selection). */
  id: string;
  title: string;
  /** The second line: space and folder of a tab, tab count of a space, category of an action. */
  detail: string;
  /** Other text the search reads (space name, full folder, chord), weighed below the title. */
  keywords: string[];
}

export interface TabEntry extends EntryBase {
  kind: "tab";
  spaceId: Id;
  itemId: Id;
  spaceName: string;
  spaceColor: string;
  /** The folder of the focused pane (short form), when known. */
  cwd?: string;
}

export interface SpaceEntry extends EntryBase {
  kind: "space";
  spaceId: Id;
  spaceColor: string;
  active: boolean;
}

export interface ActionEntry extends EntryBase {
  kind: "action";
  action: ActionDef;
  /** The chord in force, as the user reads it (`Ctrl+Shift+D`); absent for an action without a key. */
  chord?: string;
}

export type PaletteEntry = TabEntry | SpaceEntry | ActionEntry;
export type EntryKind = PaletteEntry["kind"];

/** Which entries the query asks for: everything, or what one prefix limits it to. */
export type Scope = "all" | EntryKind;

export const PREFIXES: Readonly<Record<string, EntryKind>> = {
  ">": "action",
  "@": "tab",
  "#": "space",
};

export interface ParsedQuery {
  scope: Scope;
  /** What is left to search for, without the prefix and the blanks around it. */
  term: string;
}

/** Splits the leading prefix (`>` actions, `@` tabs, `#` spaces) from the text to search. */
export function parseQuery(query: string): ParsedQuery {
  const text = query.trimStart();
  const kind = PREFIXES[text.charAt(0)];
  if (kind === undefined) return { scope: "all", term: text.trim() };
  return { scope: kind, term: text.slice(1).trim() };
}

export interface EntrySources {
  workspace: Pick<Workspace, "spaces" | "activeSpaceId">;
  /** The chord of every action in force (preset and overrides laid together). */
  chords: ChordMap;
  /** The home folder, for the short form of a folder. */
  home?: string | undefined;
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/**
 * Everything the palette can run, in the order it lists them: the tabs of every space (pinned
 * first, as the space orders them), the spaces, then the actions of the registry. "Open palette"
 * is left out: running it from the palette would only open it again.
 */
export function buildEntries(sources: EntrySources): PaletteEntry[] {
  const { workspace, chords, home } = sources;
  const tabs: TabEntry[] = [];
  const spaces: SpaceEntry[] = [];
  for (const space of workspace.spaces) {
    const itemIds = spaceItemIds(space);
    for (const itemId of itemIds) {
      const item = space.items[itemId];
      if (item === undefined) continue;
      const title = itemTitle(space, itemId);
      const folder = summarizeItem(item, space.defaults.cwd).cwd;
      const short = folder !== undefined ? shortCwd(folder, home) : "";
      tabs.push({
        kind: "tab",
        id: `tab:${itemId}`,
        title,
        detail: short !== "" ? `${space.name} · ${short}` : space.name,
        keywords: [space.name, ...(folder !== undefined ? [folder] : [])],
        spaceId: space.id,
        itemId,
        spaceName: space.name,
        spaceColor: space.color,
        ...(short !== "" ? { cwd: short } : {}),
      });
    }
    const folder = space.defaults.cwd;
    const short = folder !== undefined ? shortCwd(folder, home) : "";
    const count = plural(itemIds.length, "tab");
    spaces.push({
      kind: "space",
      id: `space:${space.id}`,
      title: space.name,
      detail: short !== "" ? `${count} · ${short}` : count,
      keywords: folder !== undefined ? [folder] : [],
      spaceId: space.id,
      spaceColor: space.color,
      active: space.id === workspace.activeSpaceId,
    });
  }
  const actions = ACTIONS.filter((action) => action.command.kind !== "palette").map(
    (action): ActionEntry => {
      const raw = chords[action.id];
      const chord = raw !== undefined ? formatChord(raw) : undefined;
      return {
        kind: "action",
        id: `action:${action.id}`,
        title: action.title,
        detail: action.category,
        keywords: [action.category, ...(chord !== undefined ? [chord] : [])],
        action,
        ...(chord !== undefined ? { chord } : {}),
      };
    },
  );
  return [...tabs, ...spaces, ...actions];
}

/**
 * How well `text` holds the word `word` (both already lower case): a run of the word scores above
 * letters spread out in order, a hit at the start of the text or of a word scores above one inside
 * it. `loose` also accepts the letters spread out in order. `undefined` when there is no match.
 */
function wordScore(word: string, text: string, loose: boolean): number | undefined {
  const at = text.indexOf(word);
  if (at >= 0) {
    const boundary = at === 0 || /[\s/\\._:+-]/.test(text.charAt(at - 1));
    return 1000 - Math.min(at, 200) + (boundary ? 100 : 0);
  }
  // Letters spread out in order only count in the title: in a long folder path they match anything.
  if (!loose) return undefined;
  let position = -1;
  let spread = 0;
  for (const letter of word) {
    const next = text.indexOf(letter, position + 1);
    if (next < 0) return undefined;
    if (position >= 0) spread += next - position - 1;
    position = next;
  }
  return Math.max(1, 400 - spread);
}

/**
 * The fuzzy score of an entry for the words of the term: every word must match the title or one
 * of the keywords (a title hit counts double). `undefined` when some word matches neither.
 */
export function entryScore(entry: PaletteEntry, term: string): number | undefined {
  const words = term
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return 0;
  const title = entry.title.toLowerCase();
  const keywords = entry.keywords.map((keyword) => keyword.toLowerCase());
  let total = 0;
  for (const word of words) {
    const inTitle = wordScore(word, title, true);
    const inKeywords = keywords
      .map((keyword) => wordScore(word, keyword, false))
      .filter((score): score is number => score !== undefined);
    const best = Math.max(
      inTitle !== undefined ? inTitle * 2 : 0,
      inKeywords.length > 0 ? Math.max(...inKeywords) : 0,
    );
    if (best === 0) return undefined;
    total += best;
  }
  return total / words.length;
}

const KIND_ORDER: readonly EntryKind[] = ["tab", "space", "action"];

/**
 * The entries the query asks for. A prefix limits the kind; the rest of the text is matched fuzzily
 * and the best match comes first within each kind (ties keep the order of `entries`). The kinds
 * stay in the order tabs, spaces, actions. With nothing to search for, everything of the scope is
 * listed in its own order.
 */
export function searchEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const { scope, term } = parseQuery(query);
  const result: PaletteEntry[] = [];
  for (const kind of KIND_ORDER) {
    if (scope !== "all" && scope !== kind) continue;
    const scored = entries
      .filter((entry) => entry.kind === kind)
      .map((entry, order) => ({ entry, order, score: entryScore(entry, term) }))
      .filter(
        (hit): hit is { entry: PaletteEntry; order: number; score: number } =>
          hit.score !== undefined,
      );
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    result.push(...scored.map((hit) => hit.entry));
  }
  return result;
}

/** The heading each kind of entry is listed under. */
export const KIND_HEADINGS: Readonly<Record<EntryKind, string>> = {
  tab: "Tabs",
  space: "Spaces",
  action: "Actions",
};
