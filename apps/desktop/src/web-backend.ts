import { FakeBackend } from "@noren/model";
import {
  WINDOW_EFFECT_LABELS,
  benchHardwareOf,
  decodeGitDiff,
  isWindowEffect,
  parseGalleryIndex,
} from "@noren/model";
import type {
  BenchHardware,
  GalleryDownload,
  GalleryIndex,
  GitDiffRefusal,
  GitInfo,
  PluginFolder,
  ShellProfile,
  WindowEffect,
  Worktree,
} from "@noren/model";

/** Key of `state.json` in the browser's storage (web mode only). */
export const WEB_STATE_KEY = "noren.web.state";

/**
 * Key of the `.noren/actions.json` texts in web mode: a JSON object from folder to file text. The
 * e2e tests seed it before the page loads, and change it to see the file reload.
 */
export const WEB_ACTIONS_KEY = "noren.web.actions";

/**
 * Key of the shell profiles in web mode: a JSON list of `{ id, name, default }`. Without it (or
 * with a value that is not a usable list) the one fake shell is the only profile. The e2e tests
 * seed it before the page loads, to have more than one shell to pick.
 */
export const WEB_PROFILES_KEY = "noren.web.profiles";

/**
 * Key of the fake git repositories in web mode: a JSON object from the folder that holds a
 * repository to its branch (`{ "/proj": "main" }`), or to `{ "branch": "abc1234", "detached": true }`.
 * It is read at every lookup, so a test can change the branch while the page runs. Without it no
 * folder is in a repository.
 */
export const WEB_GIT_KEY = "noren.web.git";

/**
 * Key of the text of `config.jsonc` in web mode. The e2e tests seed it before the page loads, and
 * the `setConfig` hook rewrites it, as an edit of the file by another program would.
 */
export const WEB_CONFIG_KEY = "noren.web.config";

/**
 * Key of the theme files of the user in web mode (`themes/<id>.json` of the real app): a JSON
 * object from the theme id to the text of its file. The e2e tests can seed it before the page
 * loads; saving a theme writes it, so a reload finds the theme again.
 */
export const WEB_THEMES_KEY = "noren.web.themes";

/**
 * Key of the mod files of the user in web mode (`mods/<name>.css` of the real app): a JSON object
 * from the file name to its text. The e2e tests can seed it before the page loads; a file placed
 * with the `setMod` hook is kept here, so a reload finds it again.
 */
export const WEB_MODS_KEY = "noren.web.mods";
/**
 * Plugin folders for a test (NOR-F18-01c): a JSON list of `{ folder, manifest, main }` (text) or
 * `{ folder, error }` that `listPlugins` answers instead of the example plugin.
 */
export const WEB_PLUGINS_KEY = "noren.web.plugins";

/**
 * The gallery for a test (NOR-F18-02a): a JSON object `{ index, downloads }`, where `index` is a
 * gallery index (`parseGalleryIndex` must accept it) and `downloads` goes from an item id to
 * `{ text, sha256 }`, the file its address serves and the sha256 of its bytes. It replaces the
 * fixture `galleryIndex` answers, so a test can serve a gallery of its own.
 */
export const WEB_GALLERY_KEY = "noren.web.gallery";

/**
 * Key of the scrollback snapshots in web mode (`scrollback/<paneId>.txt` of the real app): a JSON
 * object from the pane id to the text of its file. Saving a snapshot writes it, so a reload finds it
 * again; the e2e tests can seed it before the page loads.
 */
export const WEB_SCROLLBACK_KEY = "noren.web.scrollback";

/**
 * Key of the window effects this page pretends the system can paint, in web mode: a JSON list of
 * effect names (`["mica"]`). A browser paints none, so without it every effect falls back to an
 * opaque window with a reason, as the desktop app does on a system without the effect. The e2e
 * tests seed it before the page loads, to see what a window with an effect looks like.
 */
export const WEB_WINDOW_EFFECTS_KEY = "noren.web.window-effects";

/**
 * Key of the picture files in web mode (the files a background path can name in the desktop app):
 * a JSON object from the path to the base64 of the file. The e2e tests seed it before the page
 * loads, with a fixture picture; a file placed with the `setImage` hook is kept here too.
 */
export const WEB_IMAGES_KEY = "noren.web.images";

/**
 * Key of the files and folders a preview pane can read in web mode (what `readFilePreview` finds at
 * a full path): a JSON object from the path to the base64 of the file, or to `null` for a folder.
 * The e2e tests seed it before the page loads with fixture files; a file placed with the `setFile`
 * hook is kept here too, so a reload finds it again.
 */
export const WEB_FILES_KEY = "noren.web.files";

/**
 * Key of the git diffs a diff pane can read in web mode (what `readGitDiff` answers for a repository):
 * a JSON object from the folder of the repository to the text of its diff, or to `{ "reason": ... }`
 * (a refusal of `GIT_DIFF_REFUSALS`, with an optional `"detail"`). The e2e tests seed it before the
 * page loads with fixture diffs; a diff placed with the `setGitDiff` hook is kept here too, so a
 * reload finds it again. A folder with no entry here is in no repository.
 */
export const WEB_GIT_DIFFS_KEY = "noren.web.git-diffs";

/**
 * Key of the models of the Ollama this page pretends to have installed, in web mode: a JSON list of
 * model names (`["llama3"]`). Without it there is no Ollama here, which is what most computers are.
 * The e2e tests seed it before the page loads.
 */
export const WEB_AI_OLLAMA_KEY = "noren.web.ai-ollama";

/**
 * Key of the bench result files in web mode: a JSON object from the file name (`2026-10-20-120000.json`)
 * to the run, written as the text of the file or as the JSON object itself. The e2e tests seed it
 * before the page loads; the bench screen reads them as it reads the ones in the data folder of the
 * app (a file that is not a valid run is skipped). Without it there are no results.
 */
export const WEB_BENCH_RESULTS_KEY = "noren.web.bench-results";

/**
 * Key of the memory of the computer this page pretends to have, in web mode: a JSON object
 * `{ "ramBytes": 8589934592, "vramBytes": null }` (`vramBytes` is `null` for a computer whose video
 * memory is not known). The e2e tests seed it before the page loads; the recommended models are
 * chosen for it. Without it, or with a value that is not a memory, the page knows nothing of its
 * computer, which is what a browser really knows.
 */
export const WEB_HARDWARE_KEY = "noren.web.hardware";

/** What web mode needs of the browser storage. */
export type StateStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The mod files seeded under `WEB_MODS_KEY` (name to text), or `undefined` when there is no usable seed. */
export function seededMods(storage: Pick<Storage, "getItem">): Record<string, string> | undefined {
  try {
    const raw = storage.getItem(WEB_MODS_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const files: Record<string, string> = {};
    for (const [name, text] of Object.entries(value)) {
      if (typeof text === "string") files[name] = text;
    }
    return files;
  } catch {
    return undefined;
  }
}

/** The plugin folders seeded under `WEB_PLUGINS_KEY`, or `undefined` when there is no usable seed. */
export function seededPlugins(storage: Pick<Storage, "getItem">): PluginFolder[] | undefined {
  try {
    const raw = storage.getItem(WEB_PLUGINS_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return undefined;
    const folders: PluginFolder[] = [];
    for (const entry of value as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const { folder, manifest, main, error } = entry as Record<string, unknown>;
      if (typeof folder !== "string") continue;
      if (typeof manifest === "string" && typeof main === "string") {
        folders.push({ folder, manifest, main });
      } else if (typeof error === "string") folders.push({ folder, error });
    }
    return folders;
  } catch {
    return undefined;
  }
}

/** The gallery seeded under `WEB_GALLERY_KEY`, or `undefined` when there is no usable seed. */
export function seededGallery(
  storage: Pick<Storage, "getItem">,
): { index: GalleryIndex; downloads: Record<string, GalleryDownload> } | undefined {
  try {
    const raw = storage.getItem(WEB_GALLERY_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const parsed = parseGalleryIndex((value as Record<string, unknown>)["index"]);
    if (!parsed.ok) return undefined;
    const downloads: Record<string, GalleryDownload> = {};
    const served = (value as Record<string, unknown>)["downloads"];
    if (typeof served === "object" && served !== null && !Array.isArray(served)) {
      for (const [id, entry] of Object.entries(served)) {
        if (typeof entry !== "object" || entry === null) continue;
        const { text, sha256 } = entry as Record<string, unknown>;
        if (typeof text === "string" && typeof sha256 === "string")
          downloads[id] = { text, sha256 };
      }
    }
    return { index: parsed.index, downloads };
  } catch {
    return undefined;
  }
}

/** The theme files seeded under `WEB_THEMES_KEY` (id to text), or `undefined` when there is no usable seed. */
export function seededUserThemes(
  storage: Pick<Storage, "getItem">,
): Record<string, string> | undefined {
  try {
    const raw = storage.getItem(WEB_THEMES_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const files: Record<string, string> = {};
    for (const [id, text] of Object.entries(value)) {
      if (typeof text === "string") files[id] = text;
    }
    return files;
  } catch {
    return undefined;
  }
}

/**
 * The git diffs seeded under `WEB_GIT_DIFFS_KEY` (folder of the repository to the text of the diff,
 * or to a refusal), or `undefined` when there is no usable seed. An entry that is neither is left out.
 */
export function seededGitDiffs(
  storage: Pick<Storage, "getItem">,
): Record<string, string | GitDiffRefusal> | undefined {
  try {
    const raw = storage.getItem(WEB_GIT_DIFFS_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const diffs: Record<string, string | GitDiffRefusal> = {};
    for (const [folder, entry] of Object.entries(value)) {
      if (typeof entry === "string") {
        diffs[folder] = entry;
      } else if (typeof entry === "object" && entry !== null) {
        try {
          const answer = decodeGitDiff({ kind: "refused", ...entry });
          if (answer.kind === "refused") diffs[folder] = answer;
        } catch {
          // Not a refusal: that entry is left out.
        }
      }
    }
    return diffs;
  } catch {
    return undefined;
  }
}

/** The snapshots seeded under `WEB_SCROLLBACK_KEY` (pane id to text), or `undefined` when there is no usable seed. */
export function seededScrollback(
  storage: Pick<Storage, "getItem">,
): Record<string, string> | undefined {
  try {
    const raw = storage.getItem(WEB_SCROLLBACK_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const files: Record<string, string> = {};
    for (const [paneId, text] of Object.entries(value)) {
      if (typeof text === "string") files[paneId] = text;
    }
    return files;
  } catch {
    return undefined;
  }
}

/** The window effects seeded under `WEB_WINDOW_EFFECTS_KEY`; none when there is no usable seed. */
export function seededWindowEffects(storage: Pick<Storage, "getItem">): WindowEffect[] {
  try {
    const raw = storage.getItem(WEB_WINDOW_EFFECTS_KEY);
    if (raw === null) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? (value as unknown[]).filter(isWindowEffect) : [];
  } catch {
    return [];
  }
}

function bytesOfBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64OfBytes(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** The picture files seeded under `WEB_IMAGES_KEY` (path to bytes), or `undefined` when there is no usable seed. */
export function seededImages(
  storage: Pick<Storage, "getItem">,
): Record<string, Uint8Array> | undefined {
  try {
    const raw = storage.getItem(WEB_IMAGES_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const files: Record<string, Uint8Array> = {};
    for (const [path, text] of Object.entries(value)) {
      if (typeof text !== "string") continue;
      try {
        files[path] = bytesOfBase64(text);
      } catch {
        // Not base64: that file is left out.
      }
    }
    return files;
  } catch {
    return undefined;
  }
}

/**
 * The files seeded under `WEB_FILES_KEY` (path to bytes, or `"directory"`), or `undefined` when
 * there is no usable seed.
 */
export function seededFiles(
  storage: Pick<Storage, "getItem">,
): Record<string, Uint8Array | "directory"> | undefined {
  try {
    const raw = storage.getItem(WEB_FILES_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const files: Record<string, Uint8Array | "directory"> = {};
    for (const [path, entry] of Object.entries(value)) {
      if (entry === null) {
        files[path] = "directory";
      } else if (typeof entry === "string") {
        try {
          files[path] = bytesOfBase64(entry);
        } catch {
          // Not base64: that file is left out.
        }
      }
    }
    return files;
  } catch {
    return undefined;
  }
}

/** The models seeded under `WEB_AI_OLLAMA_KEY`, or `undefined` when there is no usable seed (no Ollama). */
export function seededOllamaModels(storage: Pick<Storage, "getItem">): string[] | undefined {
  try {
    const raw = storage.getItem(WEB_AI_OLLAMA_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return undefined;
    return (value as unknown[]).filter((name): name is string => typeof name === "string");
  } catch {
    return undefined;
  }
}

/** The bench result files seeded under `WEB_BENCH_RESULTS_KEY` (name to text), or `undefined` when there is no usable seed. */
export function seededBenchResults(
  storage: Pick<Storage, "getItem">,
): Record<string, string> | undefined {
  try {
    const raw = storage.getItem(WEB_BENCH_RESULTS_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const files: Record<string, string> = {};
    for (const [name, content] of Object.entries(value)) {
      if (typeof content === "string") files[name] = content;
      else if (typeof content === "object" && content !== null && !Array.isArray(content)) {
        files[name] = JSON.stringify(content, null, 2);
      }
    }
    return files;
  } catch {
    return undefined;
  }
}

/**
 * The memory seeded under `WEB_HARDWARE_KEY`, or `undefined` when there is no usable seed. The
 * reading goes through `benchHardwareOf`, the rule of the page for every backend: a RAM that is not
 * a whole number above 0 is no reading, and a VRAM that is not one is `null`.
 */
export function seededHardware(storage: Pick<Storage, "getItem">): BenchHardware | undefined {
  try {
    const raw = storage.getItem(WEB_HARDWARE_KEY);
    if (raw === null) return undefined;
    return benchHardwareOf(JSON.parse(raw)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The text seeded under `WEB_CONFIG_KEY`, or `null` when there is none or the storage is blocked. */
export function seededConfig(storage: Pick<Storage, "getItem">): string | null {
  try {
    return storage.getItem(WEB_CONFIG_KEY);
  } catch {
    return null;
  }
}

/** The repositories seeded under `WEB_GIT_KEY`, or `undefined` when there is no usable seed. */
export function seededGitRepos(
  storage: Pick<Storage, "getItem">,
): Record<string, GitInfo> | undefined {
  try {
    const raw = storage.getItem(WEB_GIT_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const repos: Record<string, GitInfo> = {};
    for (const [folder, entry] of Object.entries(value)) {
      if (typeof entry === "string" && entry !== "") {
        repos[folder] = { branch: entry, detached: false };
      } else if (typeof entry === "object" && entry !== null) {
        const { branch, detached } = entry as Record<string, unknown>;
        if (typeof branch === "string" && branch !== "") {
          repos[folder] = { branch, detached: detached === true };
        }
      }
    }
    return repos;
  } catch {
    return undefined;
  }
}

/** The profiles seeded under `WEB_PROFILES_KEY`, or `undefined` for the fake backend's own. */
export function seededProfiles(storage: Pick<Storage, "getItem">): ShellProfile[] | undefined {
  try {
    const raw = storage.getItem(WEB_PROFILES_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return undefined;
    const profiles: ShellProfile[] = [];
    for (const entry of value as unknown[]) {
      if (typeof entry !== "object" || entry === null) return undefined;
      const { id, name, default: isDefault } = entry as Record<string, unknown>;
      if (typeof id !== "string" || typeof name !== "string") return undefined;
      profiles.push({ id, name, default: isDefault === true });
    }
    return profiles.length > 0 ? profiles : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The in-memory backend with `state.json` kept in `localStorage`, so a reload in web mode finds
 * the workspace again. Sessions stay fake and in memory. The unit tests keep using `FakeBackend`.
 * `listMonospaceFonts` is the fake one's: a browser cannot list the fonts of its visitor (the Local
 * Font Access API asks the visitor for permission), so it answers the families the terminal falls
 * back to.
 */
export class WebBackend extends FakeBackend {
  readonly #storage: StateStorage;

  constructor(storage: StateStorage) {
    const profiles = seededProfiles(storage);
    const userThemes = seededUserThemes(storage);
    const mods = seededMods(storage);
    const images = seededImages(storage);
    const files = seededFiles(storage);
    const gitDiffs = seededGitDiffs(storage);
    const scrollback = seededScrollback(storage);
    const ollamaModels = seededOllamaModels(storage);
    const benchResults = seededBenchResults(storage);
    const hardware = seededHardware(storage);
    super({
      ...(profiles !== undefined ? { profiles } : {}),
      ...(userThemes !== undefined ? { userThemes } : {}),
      ...(mods !== undefined ? { mods } : {}),
      ...(images !== undefined ? { images } : {}),
      ...(files !== undefined ? { files } : {}),
      ...(gitDiffs !== undefined ? { gitDiffs } : {}),
      ...(scrollback !== undefined ? { scrollback } : {}),
      ...(ollamaModels !== undefined ? { ollamaModels } : {}),
      ...(benchResults !== undefined ? { benchResults } : {}),
      ...(hardware !== undefined ? { hardware } : {}),
      windowEffects: seededWindowEffects(storage),
      config: seededConfig(storage),
    });
    this.#storage = storage;
    const plugins = seededPlugins(storage);
    if (plugins !== undefined) this.setPlugins(plugins);
    const gallery = seededGallery(storage);
    if (gallery !== undefined) this.setGalleryIndex(gallery.index, gallery.downloads);
  }

  /** A browser window has no effect of its own to paint; the desktop app does. */
  protected override windowEffectReason(effect: WindowEffect): string {
    return `${WINDOW_EFFECT_LABELS[effect]} needs the desktop app: a browser window has no window effects.`;
  }

  /** Like the fake one, and kept under `WEB_IMAGES_KEY` so a reload finds the same files. */
  protected override putImage(path: string, bytes: Uint8Array | null): void {
    try {
      const others = Object.entries(seededImages(this.#storage) ?? {}).filter(
        ([known]) => known !== path,
      );
      const files = Object.fromEntries(
        [...others, ...(bytes === null ? [] : [[path, bytes] as const])].map(([name, data]) => [
          name,
          base64OfBytes(data),
        ]),
      );
      this.#storage.setItem(WEB_IMAGES_KEY, JSON.stringify(files));
    } catch {
      // Storage is blocked or full: the memory copy still serves this page load.
    }
    super.putImage(path, bytes);
  }

  /** Like the fake one, and kept under `WEB_FILES_KEY` so a reload finds the same files. */
  protected override putFile(path: string, entry: Uint8Array | "directory" | undefined): void {
    try {
      const others = Object.entries(seededFiles(this.#storage) ?? {}).filter(
        ([known]) => known !== path,
      );
      const files = Object.fromEntries(
        [...others, ...(entry === undefined ? [] : [[path, entry] as const])].map(
          ([name, data]) => [name, data === "directory" ? null : base64OfBytes(data)],
        ),
      );
      this.#storage.setItem(WEB_FILES_KEY, JSON.stringify(files));
    } catch {
      // Storage is blocked or full: the memory copy still serves this page load.
    }
    super.putFile(path, entry);
  }

  /** Like the fake one, and kept under `WEB_GIT_DIFFS_KEY` so a reload finds the same diffs. */
  protected override putGitDiff(folder: string, entry: string | GitDiffRefusal | null): void {
    try {
      const others = Object.entries(seededGitDiffs(this.#storage) ?? {}).filter(
        ([known]) => known !== folder,
      );
      const diffs = Object.fromEntries(
        [...others, ...(entry === null ? [] : [[folder, entry] as const])].map(([name, value]) => [
          name,
          value,
        ]),
      );
      this.#storage.setItem(WEB_GIT_DIFFS_KEY, JSON.stringify(diffs));
    } catch {
      // Storage is blocked or full: the memory copy still serves this page load.
    }
    super.putGitDiff(folder, entry);
  }

  /** Like the fake one, and kept under `WEB_THEMES_KEY` so a reload finds the same files. */
  protected override putUserTheme(id: string, text: string | null): void {
    try {
      const others = Object.entries(seededUserThemes(this.#storage) ?? {}).filter(
        ([known]) => known !== id,
      );
      const files = Object.fromEntries(text === null ? others : [...others, [id, text]]);
      this.#storage.setItem(WEB_THEMES_KEY, JSON.stringify(files));
    } catch {
      // Storage is blocked or full: the memory copy still serves this page load.
    }
    super.putUserTheme(id, text);
  }

  /** Like the fake one, and kept under `WEB_SCROLLBACK_KEY` so a reload finds the same files. */
  protected override putScrollback(paneId: string, text: string | null): void {
    try {
      const others = Object.entries(seededScrollback(this.#storage) ?? {}).filter(
        ([known]) => known !== paneId,
      );
      const files = Object.fromEntries(text === null ? others : [...others, [paneId, text]]);
      if (Object.keys(files).length === 0) this.#storage.removeItem(WEB_SCROLLBACK_KEY);
      else this.#storage.setItem(WEB_SCROLLBACK_KEY, JSON.stringify(files));
    } catch {
      // Storage is blocked or full: the memory copy still serves this page load.
    }
    super.putScrollback(paneId, text);
  }

  /** Like the fake one, and kept under `WEB_MODS_KEY` so a reload finds the same files. */
  protected override putMod(name: string, text: string | null): void {
    try {
      const others = Object.entries(seededMods(this.#storage) ?? {}).filter(
        ([known]) => known !== name,
      );
      const files = Object.fromEntries(text === null ? others : [...others, [name, text]]);
      this.#storage.setItem(WEB_MODS_KEY, JSON.stringify(files));
    } catch {
      // Storage is blocked or full: the memory copy still serves this page load.
    }
    super.putMod(name, text);
  }

  /** Like the fake one, and kept under `WEB_CONFIG_KEY` so a reload finds the same file. */
  override setConfig(text: string | null): void {
    try {
      if (text === null) this.#storage.removeItem(WEB_CONFIG_KEY);
      else this.#storage.setItem(WEB_CONFIG_KEY, text);
    } catch {
      // Storage is blocked or full: the memory copy still serves this page load.
    }
    super.setConfig(text);
  }

  override async loadState(): Promise<string | null> {
    try {
      const text = this.#storage.getItem(WEB_STATE_KEY);
      if (text !== null) return text;
    } catch {
      // Storage is blocked: the state lives in memory for this page load.
    }
    return super.loadState();
  }

  override async saveState(content: string): Promise<void> {
    await super.saveState(content);
    try {
      this.#storage.setItem(WEB_STATE_KEY, content);
    } catch {
      // Storage is blocked or full: the memory copy still serves this page load.
    }
  }

  /** The text seeded under `WEB_ACTIONS_KEY` for the folder, else the in-memory file. */
  override async readActionsFile(cwd: string): Promise<string | null> {
    const inMemory = await super.readActionsFile(cwd);
    try {
      const raw = this.#storage.getItem(WEB_ACTIONS_KEY);
      if (raw !== null) {
        const files: unknown = JSON.parse(raw);
        if (typeof files === "object" && files !== null && !Array.isArray(files)) {
          const text = (files as Record<string, unknown>)[cwd];
          if (typeof text === "string") return text;
        }
      }
    } catch {
      // Storage is blocked or the seed is not JSON: fall back to the in-memory file.
    }
    return inMemory;
  }

  /** Reads the repositories seeded under `WEB_GIT_KEY` (now, so they can change) into the fake ones. */
  #readSeededRepos(): void {
    const seeded = seededGitRepos(this.#storage);
    if (seeded !== undefined) this.replaceGitRepos(seeded);
  }

  /** The repositories seeded under `WEB_GIT_KEY` (read now, so they can change), else none. */
  override async gitInfo(cwd: string): Promise<GitInfo | null> {
    this.#readSeededRepos();
    return super.gitInfo(cwd);
  }

  // The worktrees are over the same seeded repositories.
  override async listWorktrees(cwd: string): Promise<Worktree[]> {
    this.#readSeededRepos();
    return super.listWorktrees(cwd);
  }

  override async createWorktree(cwd: string, branch: string): Promise<Worktree> {
    this.#readSeededRepos();
    return super.createWorktree(cwd, branch);
  }

  override async removeWorktree(cwd: string, path: string): Promise<void> {
    this.#readSeededRepos();
    return super.removeWorktree(cwd, path);
  }

  /** Keeps the broken text under a key of its own and leaves `state.json` for the next save. */
  override async quarantineState(): Promise<string> {
    const text = this.#storage.getItem(WEB_STATE_KEY);
    if (text === null) throw new Error("there is no state file to quarantine");
    const key = `${WEB_STATE_KEY}.broken-${Date.now()}`;
    this.#storage.setItem(key, text);
    return key;
  }
}
