import type { Backend, Unsubscribe } from "./backend";
import { describeConfigError, parseConfigText } from "./config";
import type { Config, ConfigError } from "./config";
import { editConfigText } from "./config-edit";
import type { ConfigChange } from "./config-edit";

// Keeps the settings in force. The text of `config.jsonc` arrives from the backend (once at start,
// then every time the file changes); a valid text replaces the settings at once, an invalid one
// changes nothing but the errors, so a typo in the middle of an edit never throws the settings
// away. It also writes: `update` edits the text of the file (keeping its comments) and saves it
// through the backend. Pure: it knows nothing of React or of the files.

/** What the backend must offer the manager. */
export type ConfigSource = Pick<Backend, "loadConfig" | "watchConfig" | "saveConfig">;

/** What `update` did: the text was saved (or already said it), or why nothing was written. */
export type ConfigUpdateResult =
  { ok: true; written: boolean } | { ok: false; message: string; errors: readonly ConfigError[] };

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
  /** The file being followed, which `update` reads and writes. */
  #source: ConfigSource | undefined;
  /** The updates run one after the other, each reading the file the one before it wrote. */
  #updates: Promise<unknown> = Promise.resolve();
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
    this.#source = source;
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
    this.#source = undefined;
  }

  /**
   * Makes `changes` in the file: reads its text now, edits only those settings (its comments, its
   * order and its trailing commas stay) and saves the result, which then applies at once. Nothing
   * is written when the file has a problem of its own (the edit could not be trusted) or when the
   * result would not be valid (a value out of its range); the answer says why. A text that already
   * says what the changes ask for is not written again. Calls queue up, so two quick updates both
   * land. Never rejects.
   */
  update(changes: readonly ConfigChange[]): Promise<ConfigUpdateResult> {
    const run = this.#updates.then(() => this.#update(changes));
    this.#updates = run.catch(() => undefined);
    return run;
  }

  async #update(changes: readonly ConfigChange[]): Promise<ConfigUpdateResult> {
    const source = this.#source;
    if (source === undefined) {
      return { ok: false, message: "The settings are not available.", errors: [] };
    }
    let text: string | null;
    try {
      text = await source.loadConfig();
    } catch (error) {
      return { ok: false, message: `Could not read config.jsonc: ${reasonOf(error)}`, errors: [] };
    }
    const current = parseConfigText(text ?? "");
    if (!current.ok) {
      const first = current.errors[0];
      return {
        ok: false,
        message:
          `The settings file has a problem, so nothing was saved. ${first ? describeConfigError(first) : ""}`.trim(),
        errors: current.errors,
      };
    }
    let next: string;
    try {
      next = editConfigText(text, changes);
    } catch (error) {
      return { ok: false, message: `Could not edit config.jsonc: ${reasonOf(error)}`, errors: [] };
    }
    if (next === (text ?? "")) {
      this.apply(text);
      return { ok: true, written: false };
    }
    const result = parseConfigText(next);
    if (!result.ok) {
      // The place in the text that was never written is no help; the setting and the reason are.
      const first = result.errors[0];
      const what = first && (first.path !== "" ? `${first.path}: ${first.message}` : first.message);
      return {
        ok: false,
        message: `Those settings are not valid, so nothing was saved. ${what ?? ""}`.trim(),
        errors: result.errors,
      };
    }
    try {
      await source.saveConfig(next);
    } catch (error) {
      return { ok: false, message: `Could not write config.jsonc: ${reasonOf(error)}`, errors: [] };
    }
    // The file will report its own change a moment later; the same text is ignored then.
    this.apply(next);
    return { ok: true, written: true };
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
