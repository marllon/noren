import { FakeBackend } from "@noren/model";

/** Key of `state.json` in the browser's storage (web mode only). */
export const WEB_STATE_KEY = "noren.web.state";

export type StateStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * The in-memory backend with `state.json` kept in `localStorage`, so a reload in web mode finds
 * the workspace again. Sessions stay fake and in memory. The unit tests keep using `FakeBackend`.
 */
export class WebBackend extends FakeBackend {
  readonly #storage: StateStorage;

  constructor(storage: StateStorage) {
    super();
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

  /** Keeps the broken text under a key of its own and leaves `state.json` for the next save. */
  override async quarantineState(): Promise<string> {
    const text = this.#storage.getItem(WEB_STATE_KEY);
    if (text === null) throw new Error("there is no state file to quarantine");
    const key = `${WEB_STATE_KEY}.broken-${Date.now()}`;
    this.#storage.setItem(key, text);
    return key;
  }
}
