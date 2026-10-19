import { FakeBackend } from "@noren/model";
import type { ShellProfile } from "@noren/model";

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

export type StateStorage = Pick<Storage, "getItem" | "setItem">;

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
 */
export class WebBackend extends FakeBackend {
  readonly #storage: StateStorage;

  constructor(storage: StateStorage) {
    const profiles = seededProfiles(storage);
    super(profiles !== undefined ? { profiles } : {});
    this.#storage = storage;
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

  /** Keeps the broken text under a key of its own and leaves `state.json` for the next save. */
  override async quarantineState(): Promise<string> {
    const text = this.#storage.getItem(WEB_STATE_KEY);
    if (text === null) throw new Error("there is no state file to quarantine");
    const key = `${WEB_STATE_KEY}.broken-${Date.now()}`;
    this.#storage.setItem(key, text);
    return key;
  }
}
