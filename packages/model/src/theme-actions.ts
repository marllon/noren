import { parseTheme } from "./theme";
import type { ParseThemeResult, Theme } from "./theme";
import { claimIdentity, cleanName, reservedThemeIds } from "./theme-derive";

// What a person does with a theme of the gallery of the settings screen that changes the theme
// itself: make a copy of it under a name of their own, and give one of theirs another name. Both
// answer a theme that went through `ThemeSchema` again, so what is written to `themes/` is a valid
// theme whatever came in. Pure; writing the file is the caller's job (`saveUserTheme`).

/** The longest name a theme has: the limit of the schema. */
export const MAX_THEME_NAME = 60;

/**
 * A copy of `theme` called `name`, with an id that collides with nothing: the built-in themes,
 * `system` and `takenIds` (the ids of every theme the window has). The id is the slug of the name,
 * and when it is taken a number is added (`-2`, `-3`, ...) to it and ` (2)` to the name. Nothing
 * else changes, so the copy looks exactly like the original until it is edited. The copy is a new
 * object: changing it never changes `theme`. A name with no letter or digit gives the id `theme`.
 */
export function duplicateTheme(
  theme: Theme,
  name: string,
  takenIds: Iterable<string>,
): ParseThemeResult {
  const taken = reservedThemeIds();
  for (const id of takenIds) taken.add(id);
  const identity = claimIdentity(name, "theme", taken);
  return parseTheme({ ...theme, id: identity.id, name: identity.name });
}

/**
 * `theme` under another name. The id stays, so the file, the choice of the settings and the theme
 * of a space that name it keep working. The name is cleaned as an imported one is (control
 * characters out, blanks folded, trimmed); one that is empty after that, or longer than
 * `MAX_THEME_NAME`, is refused with a sentence and the theme is not changed.
 */
export function renameTheme(theme: Theme, name: string): ParseThemeResult {
  // The name as `cleanName` reads it, before it cuts it to the limit: a longer one is refused, not cut.
  const folded = name
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (folded === "") return { ok: false, errors: ["name: A theme needs a name"] };
  if (folded.length > MAX_THEME_NAME) {
    return { ok: false, errors: [`name: At most ${MAX_THEME_NAME} characters`] };
  }
  return parseTheme({ ...theme, name: cleanName(folded) });
}
