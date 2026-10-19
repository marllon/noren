import type { Backend, Unsubscribe } from "./backend";
import { parseConfigText } from "./config";
import type { Config, ConfigError } from "./config";

// Keeps the settings in force. The text of `config.jsonc` arrives from the backend (once at start,
// then every time the file changes); a valid text replaces the settings at once, an invalid one
// changes nothing but the errors, so a typo in the middle of an edit never throws the settings
// away. Pure: it knows nothing of React or of the files.

/** What the backend must offer the manager. */
export type ConfigSource = Pick<Backend, "loadConfig" | "watchConfig">;

export interface ConfigState {
  /** The settings in force: from the last valid text, `{}` while there was none (or no file). */
  readonly config: Config;
  /** What is wrong with the text read last; empty when it was fine. `config` is then the one before it. */
  readonly errors: readonly ConfigError[];
}

const EMPTY: ConfigState = { config: {}, errors: [] };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The settings in force and the problems with the file. `state` is replaced (never changed) when
 * something is new, so a view can compare it by identity; the listeners hear every replacement.
 */
export class ConfigManager {
  readonly #listeners = new Set<() => void>();
  #state: ConfigState = EMPTY;
  /** The text applied last, to ignore a text that is the same. `undefined`: nothing applied yet. */
  #lastText: string | null | undefined;
  #stopWatching: Unsubscribe | undefined;
  /** The watcher delivered a text, which is newer than whatever a load in flight answers. */
  #heardWatcher = false;

  /** The settings now. The same object until a new text changes them or their errors. */
  get state(): ConfigState {
    return this.#state;
  }

  /** `listener` runs after every replacement of `state`. Returns the function that stops it. */
  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Starts following the file: watches it, then reads it, and resolves once the first text is
   * applied. Never rejects: a file that cannot be read becomes an error in `state`. Calling it
   * again follows the new source and drops the old one.
   */
  async start(source: ConfigSource): Promise<void> {
    this.stop();
    this.#heardWatcher = false;
    let stopped = false;
    // Watching first, so a change made while the file is being read is not lost.
    const stopWatching = source.watchConfig((text) => {
      if (stopped) return;
      this.#heardWatcher = true;
      this.apply(text);
    });
    this.#stopWatching = () => {
      stopped = true;
      stopWatching();
    };
    try {
      const text = await source.loadConfig();
      // A change the watcher already delivered is newer than this read.
      if (!stopped && !this.#heardWatcher) this.apply(text);
    } catch (error) {
      if (!stopped && !this.#heardWatcher) {
        this.#replace({
          config: this.#state.config,
          errors: [{ message: `Could not read config.jsonc: ${reasonOf(error)}`, path: "" }],
        });
      }
    }
  }

  /** Stops following the file. The settings in force stay as they are. */
  stop(): void {
    this.#stopWatching?.();
    this.#stopWatching = undefined;
  }

  /**
   * Applies the text of the file (`null`: there is no file, so nothing is set). A text equal to the
   * one applied last changes nothing. A valid text becomes the settings; an invalid one keeps the
   * settings and reports its errors.
   */
  apply(text: string | null): void {
    if (text === this.#lastText) return;
    this.#lastText = text;
    if (text === null) {
      this.#replace(EMPTY);
      return;
    }
    const parsed = parseConfigText(text);
    this.#replace(
      parsed.ok
        ? { config: parsed.config, errors: [] }
        : { config: this.#state.config, errors: parsed.errors },
    );
  }

  #replace(next: ConfigState): void {
    this.#state = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
