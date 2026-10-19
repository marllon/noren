import { importColorSchemes, serializeTheme } from "@noren/model";
import type { Backend, Theme } from "@noren/model";

// Importing a color scheme from a file the person picked: the text goes through the importers of
// `@noren/model` (which tell the format from what is in the file), each theme is written as a file
// of `themes/` through the backend and then added to the list, and the answer is a sentence for the
// notice. Nothing is written when the file is not a scheme, and a theme that could not be written is
// not added. The wording speaks of file formats, never of a product.

/** The part of a `File` the import reads. */
export interface PickedFile {
  name: string;
  size: number;
  text(): Promise<string>;
}

/** A file bigger than this is not a color scheme (the real ones are a few kilobytes). */
export const MAX_SCHEME_FILE_BYTES = 1_000_000;

export interface SchemeImportDeps {
  backend: Pick<Backend, "saveUserTheme">;
  /** The themes of the user now, so an imported id never takes one of theirs. */
  existing: readonly Theme[];
  /** Called with the themes that were written, to put them in the list. */
  added(themes: readonly Theme[]): void;
}

/** `Lagoon.itermcolors` as `Lagoon`; a name with no extension stays as it is. */
export function nameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

/** `"A", "B" and "C"`, or the first three and a count. */
function namesOf(themes: readonly Theme[]): string {
  const shown = themes.slice(0, 3).map((theme) => `"${theme.name}"`);
  const rest = themes.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

function failure(file: PickedFile, reason: string): string {
  return `Could not import "${file.name}": ${reason}`;
}

/** The sentence to show once a theme is on the list: how to use it. */
function importedNotice(themes: readonly Theme[], left: string[]): string {
  const first = themes[0];
  const main =
    themes.length === 1 && first !== undefined
      ? `Imported color scheme "${first.name}". Pick it with "Theme: ${first.name}" in the command palette.`
      : `Imported ${themes.length} color schemes: ${namesOf(themes)}. Pick one with "Theme: ..." in the command palette.`;
  return left.length === 0 ? main : `${main} Left out: ${left[0] ?? ""}`;
}

/**
 * Imports the color schemes in `file`. Resolves to the sentence to show: what was imported, or why
 * nothing was. Never rejects.
 */
export async function importSchemeFile(file: PickedFile, deps: SchemeImportDeps): Promise<string> {
  if (file.size > MAX_SCHEME_FILE_BYTES) {
    return failure(file, "the file is too large to be a color scheme.");
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    return failure(file, "the file could not be read.");
  }
  const result = importColorSchemes(text, {
    name: nameFromFile(file.name),
    takenIds: deps.existing.map((theme) => theme.id),
  });
  if (!result.ok) {
    const more = result.errors.length - 1;
    return failure(
      file,
      `${result.errors[0] ?? "it is not a color scheme."}${more > 0 ? ` (and ${more} more)` : ""}`,
    );
  }

  const saved: Theme[] = [];
  try {
    for (const theme of result.themes) {
      await deps.backend.saveUserTheme(theme.id, serializeTheme(theme));
      saved.push(theme);
    }
  } catch (error) {
    // What was written stays, and is on the list; the rest is not.
    if (saved.length > 0) deps.added(saved);
    const reason = error instanceof Error ? error.message : String(error);
    return `Could not save the color scheme "${result.themes[saved.length]?.name ?? file.name}": ${reason}`;
  }
  deps.added(saved);
  return importedNotice(saved, result.warnings);
}
