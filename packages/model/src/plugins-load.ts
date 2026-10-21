import { parsePluginManifest } from "./plugins";
import type { PluginManifest } from "./plugins";

// Plugins, the loading side that needs no disk and no DOM (NOR-F18-01b): `Backend.listPlugins`
// answers what the folder `plugins/` holds, one entry per folder, and `checkPluginFolders` sorts it
// into the plugins that can run and the folders that cannot, each with the reason. Running the
// code is not here (NOR-F18-01c).

/**
 * One folder of `plugins/` as the backend lists it: the text of its `plugin.json` and of the file
 * `main` names, exactly as the files hold them, or a short sentence about why the folder could not
 * be read as a plugin (no `plugin.json`, a `main` that leaves the folder, a file that is too large
 * or not UTF-8 text, ...). The text is not yet checked: `checkPluginFolders` does that.
 */
export type PluginFolder =
  | { folder: string; manifest: string; main: string; error?: undefined }
  | { folder: string; error: string; manifest?: undefined; main?: undefined };

/** A plugin whose manifest is valid and whose id is the name of its folder. */
export interface LoadedPlugin {
  folder: string;
  manifest: PluginManifest;
  /** The source of the main file. */
  main: string;
}

/** A folder that is not a plugin that can run, and why, in a sentence for the person. */
export interface RejectedPlugin {
  folder: string;
  reason: string;
}

export interface PluginFolderCheck {
  valid: LoadedPlugin[];
  invalid: RejectedPlugin[];
}

const BOM = String.fromCharCode(0xfeff);
const withoutBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text);

/**
 * Checks every folder: one the backend could not read is invalid with the backend's sentence; the
 * others must hold a `plugin.json` that is JSON and fits `pluginManifestSchema`, and whose `id` is
 * the name of the folder (so two plugins never share an id, and the folder says what is inside).
 * Both lists keep the order they came in. Never throws.
 */
export function checkPluginFolders(folders: readonly PluginFolder[]): PluginFolderCheck {
  const valid: LoadedPlugin[] = [];
  const invalid: RejectedPlugin[] = [];
  for (const entry of folders) {
    if (entry.error !== undefined) {
      invalid.push({ folder: entry.folder, reason: entry.error });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(withoutBom(entry.manifest));
    } catch {
      invalid.push({ folder: entry.folder, reason: "plugin.json is not valid JSON" });
      continue;
    }
    const parsed = parsePluginManifest(json);
    if (!parsed.ok) {
      invalid.push({ folder: entry.folder, reason: parsed.errors.join("; ") });
      continue;
    }
    if (parsed.manifest.id !== entry.folder) {
      invalid.push({
        folder: entry.folder,
        reason: `id "${parsed.manifest.id}" must be the name of the folder, "${entry.folder}"`,
      });
      continue;
    }
    valid.push({ folder: entry.folder, manifest: parsed.manifest, main: entry.main });
  }
  return { valid, invalid };
}
