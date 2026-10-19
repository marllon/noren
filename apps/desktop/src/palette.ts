// The pure parts of the command palette: the entries it can list (tabs of every space, spaces,
// registry actions with their chord, shell profiles, recent folders and themes), the prefixes that
// narrow the list and the fuzzy match that orders it. The palette itself (`CommandPalette.tsx`)
// only draws what this returns.

import type { Id, ShellProfile, Workspace } from "@noren/model";
import { itemTitle } from "./favorites";
import { ACTIONS } from "./keybindings";
import type { ActionDef, ChordMap } from "./keybindings";
import { shortCwd, summarizeItem } from "./pane-info";
import { formatChord } from "./shortcuts-screen";
import type { SpaceThemeOption } from "./space-theme";
import type { Theme } from "./theme";
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

/** "New <profile> tab": a tab in the active space that starts this shell profile. */
export interface ProfileEntry extends EntryBase {
  kind: "profile";
  profileId: string;
}

/** A folder a shell reported through OSC 7: a new tab there, with the profile of the space. */
export interface FolderEntry extends EntryBase {
  kind: "folder";
  /** The folder as the shell reported it. */
  path: string;
}

/** A theme to apply, or (`themeId` null) the choice to follow the system again. */
export interface ThemeEntry extends EntryBase {
  kind: "theme";
  themeId: string | null;
  /** This is the choice in force. */
  current: boolean;
}

/**
 * A theme for the active space (`themeId` null: use the global theme again). Only listed in the
 * palette opened by "Set theme for this space", never in the general list.
 */
export interface SpaceThemeEntry extends EntryBase {
  kind: "space-theme";
  themeId: string | null;
  current: boolean;
}

export type PaletteEntry =
  TabEntry | SpaceEntry | ActionEntry | ProfileEntry | FolderEntry | ThemeEntry | SpaceThemeEntry;
export type EntryKind = PaletteEntry["kind"];

/**
 * Which entries the query asks for: everything, or what one prefix limits it to. `action` is the
 * command group: the registry actions, the profiles, the recent folders and the themes.
 */
export type Scope = "all" | "tab" | "space" | "action";

/** The kinds of entry each scope lists. */
const SCOPE_KINDS: Readonly<Record<Exclude<Scope, "all">, readonly EntryKind[]>> = {
  tab: ["tab"],
  space: ["space"],
  action: ["action", "profile", "folder", "theme", "space-theme"],
};

export const PREFIXES: Readonly<Record<string, Exclude<Scope, "all">>> = {
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
  /** The shell profiles the machine has (empty or left out: no profile entries). */
  profiles?: readonly ShellProfile[];
  /** The folders shells reported, most recent first (empty or left out: no folder entries). */
  folders?: readonly string[];
  /** The themes on offer and the id in force, `null` while the theme follows the system. */
  themes?: { list: readonly Theme[]; choice: string | null };
  /**
   * The AI is on for the space on screen. Without it (the default) no entry of the AI is listed:
   * where the AI is off nothing offers it.
   */
  aiOn?: boolean;
}

/** The list of "Set theme for this space": one entry per option, `Use global theme` last. */
export function buildSpaceThemeEntries(
  spaceName: string,
  options: readonly SpaceThemeOption[],
): SpaceThemeEntry[] {
  return options.map((option) => ({
    kind: "space-theme",
    id: option.themeId === null ? "space-theme:global" : `space-theme:${option.themeId}`,
    title: option.label,
    detail: option.current
      ? `In use in ${spaceName}`
      : option.themeId === null
        ? "Follow the global theme"
        : `For ${spaceName}`,
    keywords: [spaceName, "theme", "space"],
    themeId: option.themeId,
    current: option.current,
  }));
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
  const aiOn = sources.aiOn === true;
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
  const actions = ACTIONS.filter(
    (action) => action.command.kind !== "palette" && (aiOn || action.command.kind !== "ask-toggle"),
  ).map((action): ActionEntry => {
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
  });
  const where = workspace.spaces.find((space) => space.id === workspace.activeSpaceId)?.name ?? "";
  const profiles = (sources.profiles ?? []).map((profile): ProfileEntry => ({
    kind: "profile",
    id: `profile:${profile.id}`,
    title: `New ${profile.name} tab`,
    detail: where !== "" ? `in ${where}` : "",
    keywords: [profile.id, "shell", "profile", ...(where !== "" ? [where] : [])],
    profileId: profile.id,
  }));
  const folders = (sources.folders ?? []).map((path): FolderEntry => {
    const short = shortCwd(path, home);
    return {
      kind: "folder",
      id: `folder:${path}`,
      title: short !== "" ? short : path,
      detail: "Recent folder · new tab",
      keywords: [path, "recent", "folder"],
      path,
    };
  });
  const themes: ThemeEntry[] = [];
  if (sources.themes !== undefined) {
    const { list, choice } = sources.themes;
    for (const theme of list) {
      themes.push({
        kind: "theme",
        id: `theme:${theme.id}`,
        title: `Theme: ${theme.name}`,
        detail: `${theme.kind === "dark" ? "Dark" : "Light"}${choice === theme.id ? " · in use" : ""}`,
        keywords: [theme.name, theme.kind, "theme"],
        themeId: theme.id,
        current: choice === theme.id,
      });
    }
    themes.push({
      kind: "theme",
      id: "theme:system",
      title: "Follow system theme",
      detail: choice === null ? "In use" : "Light or dark, as the system",
      keywords: ["theme", "system", "auto", "light", "dark"],
      themeId: null,
      current: choice === null,
    });
  }
  return [...tabs, ...spaces, ...actions, ...profiles, ...folders, ...themes];
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

const KIND_ORDER: readonly EntryKind[] = [
  "tab",
  "space",
  "action",
  "profile",
  "folder",
  "theme",
  "space-theme",
];

/**
 * The entries the query asks for. A prefix limits the kinds (`>` lists everything that is not a tab
 * or a space); the rest of the text is matched fuzzily and the best match comes first within each
 * kind (ties keep the order of `entries`, so recent folders stay most recent first). The kinds stay
 * in the order tabs, spaces, actions, profiles, folders, themes. With nothing to search for,
 * everything of the scope is listed in its own order.
 */
export function searchEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const { scope, term } = parseQuery(query);
  const result: PaletteEntry[] = [];
  for (const kind of KIND_ORDER) {
    if (scope !== "all" && !SCOPE_KINDS[scope].includes(kind)) continue;
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
  profile: "Profiles",
  folder: "Recent folders",
  theme: "Themes",
  "space-theme": "Theme for this space",
};
