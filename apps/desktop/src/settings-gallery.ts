import { compareWithInstalled, parseTheme, parseUserThemes } from "@noren/model";
import type { GalleryIndex, GalleryKind, GalleryStatus, InstalledGalleryItem } from "@noren/model";

// What the gallery section of the settings screen shows (NOR-F18-02b): one row for each item of the
// index, set against what is installed, and the check of a theme once it is in the themes folder.
// Pure; the panel only draws it and asks the backend.

/** What the button of a row does: there is none for an item that is up to date. */
export type GalleryAction = "install" | "update";

/** One row of the gallery in the settings screen. */
export interface GalleryRow {
  readonly id: string;
  readonly kind: GalleryKind;
  readonly name: string;
  /** The version the index offers. */
  readonly indexVersion: string;
  /** The version installed, when there is one. */
  readonly installedVersion?: string;
  readonly status: GalleryStatus;
  /** `install` for a new item, `update` for one the index has a newer version of, none for the rest. */
  readonly action?: GalleryAction;
}

const ACTIONS: Readonly<Record<GalleryStatus, GalleryAction | undefined>> = {
  new: "install",
  update: "update",
  current: undefined,
};

/** The rows, in the order of the index. */
export function galleryRows(
  index: GalleryIndex,
  installed: readonly InstalledGalleryItem[],
): GalleryRow[] {
  return compareWithInstalled(index, installed).map(({ item, status, installedVersion }) => {
    const action = ACTIONS[status];
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      indexVersion: item.version,
      ...(installedVersion !== undefined ? { installedVersion } : {}),
      status,
      ...(action !== undefined ? { action } : {}),
    };
  });
}

/**
 * Why the theme `id` is not usable now that it sits in the themes folder, or `undefined` when it is.
 * The core installs a theme once its hash matches, without reading what is in it, so
 * this is where its content is held to the whole schema: `texts` are the theme files as the backend
 * lists them. A file that is not JSON cannot be told from another file, so it is not blamed here.
 */
export function installedThemeProblem(texts: readonly string[], id: string): string | undefined {
  for (const text of texts) {
    let value: unknown;
    try {
      value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || (value as { id?: unknown }).id !== id) {
      continue;
    }
    const parsed = parseTheme(value);
    if (!parsed.ok) return parsed.errors[0] ?? "it is not a valid theme";
    // A valid theme can still be left out of the list: it takes the id of a built-in theme.
    const listed = parseUserThemes([text]);
    if (listed.themes.length === 0) {
      return listed.ignored[0] ?? "it is left out of the list of themes";
    }
    return undefined;
  }
  return "the file installed has no theme with this id";
}
