import type { Unsubscribe } from "./backend";

/**
 * Terminal output of one session. A session starts printing before the caller knows its id and
 * can subscribe, so chunks are held until the first subscriber arrives and then delivered in order.
 */
export class OutputStream {
  #listeners = new Set<(data: Uint8Array) => void>();
  #held: Uint8Array[] = [];

  push(data: Uint8Array): void {
    if (this.#listeners.size === 0) {
      this.#held.push(data);
      return;
    }
    for (const listener of [...this.#listeners]) listener(data);
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
