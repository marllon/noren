import type { ModFile } from "@noren/model";

// What the settings screen and the menu of a space list about mods: the files of the mods folder,
// and the names a list turns on that the folder does not have (a file that was deleted or renamed).
// Pure; the screens only draw it.

/** One row of the mods in the settings screen. */
export interface ModRow {
  readonly name: string;
  /** Turned on for every space. */
  readonly on: boolean;
  /** Turned on but there is no such file in the folder: it is ignored, and the row lets it go. */
  readonly missing: boolean;
}

/**
 * The rows of the settings screen: the mods that are on, in the order they apply, then the other
 * files of the folder by name. A name that is on and has no file stays a row, marked `missing`,
 * so it can be turned off.
 */
export function settingsModRows(files: readonly ModFile[], enabled: readonly string[]): ModRow[] {
  const present = new Set(files.map((file) => file.name));
  const on = new Set(enabled);
  return [
    ...enabled.map((name) => ({ name, on: true, missing: !present.has(name) })),
    ...files
      .filter((file) => !on.has(file.name))
      .map((file) => ({ name: file.name, on: false, missing: false })),
  ];
}

/** One mod in the menu of a space. */
export interface SpaceModOption {
  readonly name: string;
  /** Turned on for this space: by the global list or by the list of the space. */
  readonly on: boolean;
  /** It is on for every space, which this menu cannot change (the settings screen does). */
  readonly global: boolean;
  /** The space turns it on but the folder has no such file. */
  readonly missing: boolean;
}

/**
 * The options of the menu of a space: every file of the folder by name, then the names the space
 * turns on that the folder lacks, so a stale one can be turned off.
 */
export function spaceModOptions(
  files: readonly ModFile[],
  global: readonly string[],
  spaceMods: readonly string[],
): SpaceModOption[] {
  const everywhere = new Set(global);
  const own = new Set(spaceMods);
  const present = new Set(files.map((file) => file.name));
  return [
    ...files.map((file) => ({
      name: file.name,
      on: everywhere.has(file.name) || own.has(file.name),
      global: everywhere.has(file.name),
      missing: false,
    })),
    ...spaceMods
      .filter((name) => !present.has(name))
      .map((name) => ({ name, on: true, global: everywhere.has(name), missing: true })),
  ];
}
