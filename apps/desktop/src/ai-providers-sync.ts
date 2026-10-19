import type { AiBackend, AiProviderConfig, Unsubscribe } from "@noren/model";
import type { ConfigState } from "@noren/model";

// Hands the providers of `ai.providers` in `config.jsonc` to the backend (`ai.configure`), because
// the Rust side is the only one that talks to a provider and it knows only what it was given. It
// runs once when the settings are first in force and again whenever the file changes the list (an
// edit of the file by hand, the settings screen, a reload): a change to any other setting hands
// nothing over. The calls go one after the other, so an older list never lands after a newer one.
// A list the backend refuses is told, with its reason, and never stops the app; the backend then
// keeps the providers it had. A key is no part of any of it: it travels only in `ai.setKey`.

/** What the sync needs of the settings manager. */
export interface ConfigFollowed {
  readonly state: ConfigState;
  subscribe(listener: () => void): Unsubscribe;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AiProvidersSync {
  readonly #listeners = new Set<() => void>();
  #stop: Unsubscribe | undefined;
  /** The list queued last, as text; `undefined` while none is, or after the backend refused the last. */
  #queued: string | undefined;
  #chain: Promise<void> = Promise.resolve();
  #error: string | undefined;

  /** Why the last list was refused, `undefined` when the backend has the list of the file. */
  get error(): string | undefined {
    return this.#error;
  }

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Hands over the providers now, and follows `manager` from here on. Following again replaces the
   * earlier follow. Returns the function that stops it.
   */
  follow(manager: ConfigFollowed, ai: Pick<AiBackend, "configure">): Unsubscribe {
    this.#stop?.();
    this.#queued = undefined;
    const push = () => this.#push(manager.state.config.ai?.providers ?? [], ai);
    push();
    const stopListening = manager.subscribe(push);
    const stop = () => {
      stopListening();
      if (this.#stop === stop) this.#stop = undefined;
    };
    this.#stop = stop;
    return stop;
  }

  /** Resolves once every list handed over so far has been taken or refused. Never rejects. */
  settled(): Promise<void> {
    return this.#chain;
  }

  #push(providers: readonly AiProviderConfig[], ai: Pick<AiBackend, "configure">): void {
    const text = JSON.stringify(providers);
    if (text === this.#queued) return;
    this.#queued = text;
    this.#chain = this.#chain.then(async () => {
      try {
        await ai.configure(providers);
        this.#setError(undefined);
      } catch (error) {
        // Not remembered, so the next change of the file tries the list again.
        if (this.#queued === text) this.#queued = undefined;
        this.#setError(`The providers were not handed to the AI: ${reasonOf(error)}`);
      }
    });
  }

  #setError(error: string | undefined): void {
    if (error === this.#error) return;
    this.#error = error;
    for (const listener of [...this.#listeners]) listener();
  }
}
