import type { Backend } from "@noren/model";
import { IDLE_PHASE, canCheck, canInstall, nextPhase } from "./update-screen";
import type { UpdateEvent, UpdatePhase } from "./update-screen";

// Drives the steps of the screen of the update (NOR-F20-02b) over the `Backend`: a check, and an
// install. Both are the person's: a click on the button of the settings or the "Check for updates"
// of the palette. Nothing here starts by itself, and the install is a method of its own that only
// the Install button calls. Before the package is asked for, the app saves what closing it would
// save (`saveBeforeExit`), because the installer ends the app without the close of the window
// (finding 302). The state lives here, outside the components, so a check started from the palette
// goes on while the settings screen opens and shows it.

export type UpdateBackend = Pick<
  Backend,
  "updateStatus" | "updateCheck" | "updateInstall" | "onUpdateProgress"
>;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class UpdateController {
  readonly #backend: UpdateBackend;
  readonly #saveBeforeInstall: () => Promise<void>;
  readonly #listeners = new Set<() => void>();
  #phase: UpdatePhase = IDLE_PHASE;
  #reveal = false;

  constructor(backend: UpdateBackend, saveBeforeInstall: () => Promise<void>) {
    this.#backend = backend;
    this.#saveBeforeInstall = saveBeforeInstall;
  }

  get phase(): UpdatePhase {
    return this.#phase;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The palette opened the settings to show a check: the section scrolls itself into view once. */
  requestReveal(): void {
    this.#reveal = true;
  }

  /** Whether a reveal was asked for since the last time this was called. */
  takeReveal(): boolean {
    const wanted = this.#reveal;
    this.#reveal = false;
    return wanted;
  }

  #dispatch(event: UpdateEvent): void {
    const next = nextPhase(this.#phase, event);
    if (next === this.#phase) return;
    this.#phase = next;
    for (const listener of [...this.#listeners]) listener();
  }

  /** Asks the server whether a newer version is waiting. Does nothing while a step runs. */
  async check(): Promise<void> {
    if (!canCheck(this.#phase)) return;
    this.#dispatch({ type: "check-started" });
    try {
      const info = await this.#backend.updateCheck();
      let currentVersion = info?.currentVersion;
      if (info === null) {
        // The version that runs is only said when nothing newer was found; failing to read it
        // does not turn a good answer into an error.
        currentVersion = await this.#backend.updateStatus().then(
          (status) => status.currentVersion,
          () => undefined,
        );
      }
      this.#dispatch({ type: "check-done", info, currentVersion });
    } catch (error) {
      this.#dispatch({ type: "check-failed", message: reasonOf(error) });
    }
  }

  /**
   * Installs the update the check found: saves what closing would save, then downloads, checks the
   * signature and hands the package to the installer (the backend does the last three). Only the
   * Install button calls this, and only on an update that was found.
   */
  async install(): Promise<void> {
    if (!canInstall(this.#phase)) return;
    this.#dispatch({ type: "save-started" });
    await this.#saveBeforeInstall();
    this.#dispatch({ type: "download-started" });
    const stop = this.#backend.onUpdateProgress((progress) =>
      this.#dispatch({ type: "progress", progress }),
    );
    try {
      await this.#backend.updateInstall();
      this.#dispatch({ type: "install-done" });
    } catch (error) {
      this.#dispatch({ type: "install-failed", message: reasonOf(error) });
    } finally {
      stop();
    }
  }
}
