import { MAX_THEME_NAME, duplicateTheme, renameTheme, serializeTheme } from "@noren/model";
import type { Backend, Theme } from "@noren/model";
import { t } from "./i18n";
import { addUserThemes, allThemes, getUserThemes, setUserThemes } from "./user-themes-store";

// What the themes section of the settings screen does with a theme of the gallery: make a copy of
// it, rename one of the user's, delete it, export it. Each one writes through the backend first and
// only then changes the list of themes the window has, so the gallery never shows what is not on the
// disk, and each answers the sentence to show (in the language in force), never throwing. Using a
// theme (for the app or for a space) is the palette's own call (`chooseTheme`, `space/set-theme`)
// and picking a file to import is `importSchemeFile`; neither is here.

/** What an action says once it is done: the sentence, and whether it is a failure. */
export interface Outcome {
  ok: boolean;
  message: string;
  /** The theme that was made, for a duplicate. */
  theme?: Theme;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether `theme` is one of the user's (a file of `themes/`), and so can be renamed, exported and deleted. */
export const isUserTheme = (theme: Theme, user: readonly Theme[] = getUserThemes()): boolean =>
  user.some((own) => own.id === theme.id);

/** How an edited theme is saved: as a theme of its own that is new, or over the one it came from. */
export type SaveMode = "new" | "changes";

/** The words of a refusal of the schema (`name: ...`), in the language in force. */
export function nameProblem(name: string, errors: readonly string[]): string {
  const first = errors[0] ?? "";
  if (/At most \d+ characters/.test(first)) return t("themes.nameTooLong", { max: MAX_THEME_NAME });
  if (/needs a name/.test(first) || name.trim() === "") return t("themes.nameEmpty");
  return first;
}

/**
 * Makes a copy of `source` that is the user's own, under a name and an id nothing else has, and
 * puts it in the gallery. The name is "<name> copy" (and ` (2)` when that is taken).
 */
export async function duplicateUserTheme(
  backend: Pick<Backend, "saveUserTheme">,
  source: Theme,
): Promise<Outcome> {
  const copy = duplicateTheme(
    source,
    t("themes.copyName", { name: source.name }),
    allThemes().map((theme) => theme.id),
  );
  if (!copy.ok) {
    return {
      ok: false,
      message: t("themes.duplicateFailed", { name: source.name, reason: copy.errors[0] ?? "" }),
    };
  }
  try {
    await backend.saveUserTheme(copy.theme.id, serializeTheme(copy.theme));
  } catch (error) {
    return {
      ok: false,
      message: t("themes.duplicateFailed", { name: source.name, reason: reasonOf(error) }),
    };
  }
  addUserThemes([copy.theme]);
  return {
    ok: true,
    message: t("themes.duplicated", { name: copy.theme.name }),
    theme: copy.theme,
  };
}

/** Gives the theme of the user `theme` another name; the id, and so the file, stay. */
export async function renameUserTheme(
  backend: Pick<Backend, "saveUserTheme">,
  theme: Theme,
  name: string,
): Promise<Outcome> {
  const renamed = renameTheme(theme, name);
  if (!renamed.ok) return { ok: false, message: nameProblem(name, renamed.errors) };
  try {
    await backend.saveUserTheme(theme.id, serializeTheme(renamed.theme));
  } catch (error) {
    return {
      ok: false,
      message: t("themes.renameFailed", { name: theme.name, reason: reasonOf(error) }),
    };
  }
  addUserThemes([renamed.theme]);
  return {
    ok: true,
    message: t("themes.renamed", { name: renamed.theme.name }),
    theme: renamed.theme,
  };
}

/**
 * Deletes the file of the theme of the user `theme` and takes it out of the gallery. A theme that is
 * not one of the user's is never asked of the backend (the themes that ship with the app are not
 * files). The app and the spaces that named it fall back by themselves: a theme the window does not
 * have is skipped by whatever reads the choice.
 */
export async function deleteUserThemeFile(
  backend: Pick<Backend, "deleteUserTheme">,
  theme: Theme,
): Promise<Outcome> {
  if (!isUserTheme(theme)) {
    return {
      ok: false,
      message: t("themes.deleteFailed", {
        name: theme.name,
        reason: t("themes.notYours"),
      }),
    };
  }
  try {
    await backend.deleteUserTheme(theme.id);
  } catch (error) {
    return {
      ok: false,
      message: t("themes.deleteFailed", { name: theme.name, reason: reasonOf(error) }),
    };
  }
  setUserThemes(getUserThemes().filter((own) => own.id !== theme.id));
  return { ok: true, message: t("themes.deleted", { name: theme.name }) };
}

/** Hands the theme of the user `theme` to the person as a file, through the save chooser of the system. */
export async function exportUserThemeFile(
  backend: Pick<Backend, "exportUserTheme">,
  theme: Theme,
): Promise<Outcome> {
  try {
    const path = await backend.exportUserTheme({
      fileName: `${theme.id}.json`,
      text: serializeTheme(theme),
      title: t("themes.exportPickTitle"),
      filter: t("themes.exportPickFilter"),
    });
    if (path === null) return { ok: true, message: t("themes.exportCancelled") };
    return { ok: true, message: t("themes.exported", { name: theme.name, path }) };
  } catch (error) {
    return {
      ok: false,
      message: t("themes.exportFailed", { name: theme.name, reason: reasonOf(error) }),
    };
  }
}

/**
 * Saves a theme the editor made. `new` is a theme of its own with a new id (the slug of `name`, with a
 * number added when it is taken, checked against the built-in themes, `system` and every theme the
 * window has); `changes` keeps the id of `edited`, so the file, the choice of the settings and the
 * theme of a space that name it keep working, and the window shows the new look at once. The name is
 * held to the same rules as a rename (a name that is empty or longer than the schema allows is
 * refused, not changed), and the theme goes through the schema again before anything is written.
 * Nothing is written when it is refused, and the gallery only changes after the file is on the disk.
 */
export async function saveEditedTheme(
  backend: Pick<Backend, "saveUserTheme">,
  edited: Theme,
  name: string,
  mode: SaveMode,
): Promise<Outcome> {
  const named = renameTheme(edited, name);
  if (!named.ok) {
    // The name is refused with its own sentence; any other part of the theme with the schema's.
    const aboutName = named.errors.some((error) => error.startsWith("name:"));
    return {
      ok: false,
      message: aboutName
        ? nameProblem(name, named.errors)
        : t("themes.saveFailed", { name: name.trim(), reason: named.errors[0] ?? "" }),
    };
  }
  const made =
    mode === "new"
      ? duplicateTheme(
          named.theme,
          named.theme.name,
          allThemes().map((theme) => theme.id),
        )
      : named;
  if (!made.ok) {
    return {
      ok: false,
      message: t("themes.saveFailed", { name: named.theme.name, reason: made.errors[0] ?? "" }),
    };
  }
  try {
    await backend.saveUserTheme(made.theme.id, serializeTheme(made.theme));
  } catch (error) {
    return {
      ok: false,
      message: t("themes.saveFailed", { name: made.theme.name, reason: reasonOf(error) }),
    };
  }
  addUserThemes([made.theme]);
  return {
    ok: true,
    message: t(mode === "new" ? "themes.savedNew" : "themes.savedChanges", {
      name: made.theme.name,
    }),
    theme: made.theme,
  };
}
