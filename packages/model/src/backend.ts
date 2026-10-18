/**
 * Provisional, minimal backend contract. The full interface (sessions, state,
 * config, git, AI) arrives in later phases; it never imports DOM or Tauri.
 */
export interface Backend {
  readonly name: string;
  ready(): Promise<void>;
}

/** In-memory backend used by tests, e2e and the web demo. */
export class FakeBackend implements Backend {
  readonly name = "fake";

  ready(): Promise<void> {
    return Promise.resolve();
  }
}
