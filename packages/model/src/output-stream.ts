import type { Unsubscribe } from "./backend";

/**
 * Terminal output of one session. A session starts printing before the caller knows its id and
 * can subscribe, so chunks are held until the first subscriber arrives and then delivered in order.
 */
export class OutputStream {
  #listeners = new Set<(data: Uint8Array) => void>();
  #taps = new Set<(data: Uint8Array) => void>();
  #held: Uint8Array[] = [];

  push(data: Uint8Array): void {
    for (const tap of [...this.#taps]) tap(data);
    if (this.#listeners.size === 0) {
      this.#held.push(data);
      return;
    }
    for (const listener of [...this.#listeners]) listener(data);
  }

  /**
   * Hears everything the stream carries, without being the subscriber: what is held for the first
   * subscriber is heard now (and stays held), and every chunk after that is heard as it arrives,
   * whether or not anyone subscribed. A tap takes nothing from a subscriber and is not the "first
   * subscriber" the held chunks wait for. For something that reads all sessions (the tail of the
   * local API) and must not steal what a terminal view is still to be given.
   */
  tap(listener: (data: Uint8Array) => void): Unsubscribe {
    for (const data of [...this.#held]) listener(data);
    this.#taps.add(listener);
    return () => {
      this.#taps.delete(listener);
    };
  }

  subscribe(listener: (data: Uint8Array) => void): Unsubscribe {
    this.#listeners.add(listener);
    while (this.#held.length > 0) {
      const data = this.#held.shift();
      if (data) listener(data);
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
