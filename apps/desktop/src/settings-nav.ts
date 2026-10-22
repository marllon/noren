// The column of sections and the search of the settings screen (NOR-F20-10a): which sections there
// are and in what order, what a search keeps, which section a scroll position is in, and where the
// arrow keys move in the column. Pure: the screen draws what these answer.

/** The sections of the settings screen, in the order of the column on its left. */
export const SETTINGS_SECTIONS = [
  "appearance",
  "themes",
  "window",
  "background",
  "terminal",
  "profiles",
  "shortcuts",
  "notifications",
  "archive",
  "ai",
  "mods",
  "gallery",
  "sync",
  "updates",
  "import",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Whether a text read from the page (a `data-` attribute) names a section of the screen. */
export function isSettingsSection(value: string | undefined): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section === value);
}

/** The `data-nr-part` of a section of the screen, which the tests and `pnpm shot` look for. */
export const sectionPart = (section: SettingsSection): string => `settings-${section}`;

/** The `data-nr-part` of the button of a section in the column. */
export const navPart = (section: SettingsSection): string => `settings-nav-${section}`;

/**
 * A text as a search compares it: lower case, accents off, one space between words. "Sincronização"
 * is found by "sincronizacao", and "Same as the system" by "SYSTEM".
 */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a search; none for an empty one (and then nothing is filtered). */
export function searchWords(query: string): readonly string[] {
  const folded = foldText(query);
  return folded === "" ? [] : folded.split(" ");
}

/** Whether every word of the search is somewhere in the texts (in any of them, in any order). */
export function matchesWords(words: readonly string[], texts: readonly string[]): boolean {
  if (words.length === 0) return true;
  const haystack = texts.map(foldText).join(" ");
  return words.every((word) => haystack.includes(word));
}

/**
 * What a search keeps of a section. A section whose own title has every word shows all its rows
 * ("terminal" shows the Terminal section whole); otherwise a row shows when its texts, with the
 * title, have every word ("terminal cursor" shows the cursor rows of Terminal and nothing else).
 * `rows` are the texts of each row; the answer says, row by row, whether it shows.
 */
export function visibleRows(
  words: readonly string[],
  title: string,
  rows: readonly (readonly string[])[],
): boolean[] {
  if (words.length === 0 || matchesWords(words, [title])) return rows.map(() => true);
  return rows.map((texts) => matchesWords(words, [title, ...texts]));
}

/**
 * The section a scroll position is in: the last one whose top is at or above the top of the visible
 * part (with `slack` pixels of room, so a section scrolled to the top by a click counts as the one
 * on screen). `tops` are the distances of the tops of the shown sections from the start of the
 * content, in order; the first section stands for a position above all of them.
 */
export function currentSection(tops: readonly number[], scrollTop: number, slack = 8): number {
  let found = 0;
  tops.forEach((top, index) => {
    if (top <= scrollTop + slack) found = index;
  });
  return found;
}

/**
 * Where a key moves in a column of `count` items from item `index`: Arrow down and up go to the
 * next and the previous (and stop at the ends), Home and End to the first and the last. `undefined`
 * for any other key, which is not the column's.
 */
export function columnMove(index: number, key: string, count: number): number | undefined {
  if (count <= 0) return undefined;
  switch (key) {
    case "ArrowDown":
      return Math.min(count - 1, index + 1);
    case "ArrowUp":
      return Math.max(0, index - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}
