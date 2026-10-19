import type { Backend } from "@noren/model";
import { formatChord } from "./shortcuts-screen";

// The global shortcut of the quick terminal is registered with the system by the Rust side. The chord
// is the interface's to choose (the shortcuts screen records it), so this side tells Rust each time
// the chord in force changes and keeps what came of it, for the settings screen to show.

/** The id of the action in the registry of `keybindings.ts`. */
export const QUICK_TOGGLE_ACTION = "quick.toggle";

/** What the system holds for the quick terminal. */
export type QuickShortcutStatus =
  /** Nothing asked yet. */
  | { kind: "unknown" }
  /** The user took the key off the action: no global shortcut. */
  | { kind: "off" }
  | { kind: "registered"; chord: string }
  /** The system refused the chord (another program holds it, or it is not allowed); the one before stays. */
  | { kind: "refused"; chord: string; reason: string };

type Listener = () => void;

/**
 * Follows the chord of the quick terminal and has the backend register it. Asks are served one at a
 * time, in order, so a quick succession of changes ends with the last chord registered; the same
 * chord asked twice in a row is registered once. It never throws: a refusal is the status.
 */
export class QuickShortcutSync {
  readonly #backend: Pick<Backend, "setQuickShortcut">;
  readonly #listeners = new Set<Listener>();
  #status: QuickShortcutStatus = { kind: "unknown" };
  #asked: string | undefined | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(backend: Pick<Backend, "setQuickShortcut">) {
    this.#backend = backend;
  }

  get status(): QuickShortcutStatus {
    return this.#status;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Registers `chord` (`undefined`: the action has no key, so no global shortcut). Resolves with the status. */
  sync(chord: string | undefined): Promise<QuickShortcutStatus> {
    if (this.#asked === chord) return this.#queue.then(() => this.#status);
    this.#asked = chord;
    const run = this.#queue.then(async () => {
      try {
        await this.#backend.setQuickShortcut(chord ?? null);
        this.#set(chord === undefined ? { kind: "off" } : { kind: "registered", chord });
      } catch (error) {
        // The system refused; whatever it held before still works, and the status says so.
        const reason = error instanceof Error ? error.message : String(error);
        // Asking again for the same chord is worth a try (the other program may have let go).
        if (this.#asked === chord) this.#asked = null;
        this.#set({ kind: "refused", chord: chord ?? "", reason });
      }
    });
    this.#queue = run;
    return run.then(() => this.#status);
  }

  #set(status: QuickShortcutStatus): void {
    this.#status = status;
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * The line of the settings screen about the quick terminal's shortcut: the chord in force and what
 * the system made of it. `chord` is the effective chord of the action (`undefined`: no key).
 */
export function quickShortcutLine(chord: string | undefined, status: QuickShortcutStatus): string {
  if (chord === undefined) {
    return "Quick terminal: no shortcut. Record one in Keyboard shortcuts.";
  }
  const shown = formatChord(chord);
  if (status.kind === "refused" && status.chord === chord) {
    return `Quick terminal: ${shown} is not available (${status.reason}). Pick another in Keyboard shortcuts.`;
  }
  return `Quick terminal: ${shown} shows and hides it from any program. Change it in Keyboard shortcuts.`;
}
