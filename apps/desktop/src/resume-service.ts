import { watchFirstPrompt } from "./first-prompt";

// Typing the resume command of an agent into the new shell of a pane (NOR-F14-03). Which panes get
// one, and which command, is decided before the first frame by `planAgentResume` (`@noren/model`);
// this only picks the moment. The command goes in once, when the shell shows its first prompt (the
// OSC 133 A mark of the shell integration), or, for a shell without the integration, once it has
// printed something and gone quiet: a program that starts while the shell is still loading would
// be typed over by the banner. Output the shell printed before the pane was on screen is held for
// the first listener, so a pane whose view mounts late is resumed when it mounts.
//
// The pane the person types in first is left alone: what they typed and the command would mix.

/** Milliseconds a shell without the integration must stay quiet, after its first output, for it to count as ready. */
export const RESUME_QUIET_MS = 1000;

export interface ResumeTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: ResumeTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Armed {
  send(): void;
  prompt(chunk: Uint8Array): boolean;
  timer: unknown;
}

export class ResumeService {
  readonly #armed = new Map<string, Armed>();
  readonly #timers: ResumeTimers;
  readonly #quietMs: number;

  constructor(options: { timers?: ResumeTimers; quietMs?: number } = {}) {
    this.#timers = options.timers ?? realTimers;
    this.#quietMs = options.quietMs ?? RESUME_QUIET_MS;
  }

  /** Waits for the moment to run `send` for `paneId`, once. Arming a pane again replaces the first. */
  arm(paneId: string, send: () => void): void {
    this.cancel(paneId);
    this.#armed.set(paneId, { send, prompt: watchFirstPrompt(), timer: undefined });
  }

  /** The output of the shell of `paneId`, in order. Runs `send` when the shell is ready. */
  feed(paneId: string, chunk: Uint8Array): void {
    const armed = this.#armed.get(paneId);
    if (armed === undefined) return;
    if (armed.prompt(chunk)) {
      this.#fire(paneId, armed);
      return;
    }
    if (armed.timer !== undefined) this.#timers.clear(armed.timer);
    armed.timer = this.#timers.set(() => this.#fire(paneId, armed), this.#quietMs);
  }

  /** The pane will not be resumed (the person typed in it, or it went away). */
  cancel(paneId: string): void {
    const armed = this.#armed.get(paneId);
    if (armed === undefined) return;
    if (armed.timer !== undefined) this.#timers.clear(armed.timer);
    this.#armed.delete(paneId);
  }

  /** The panes still waiting for their moment. */
  waiting(): string[] {
    return [...this.#armed.keys()];
  }

  #fire(paneId: string, armed: Armed): void {
    if (this.#armed.get(paneId) !== armed) return;
    this.cancel(paneId);
    armed.send();
  }
}

/** The one of the app. */
export const resumeService = new ResumeService();
