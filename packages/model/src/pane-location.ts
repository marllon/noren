import type { GitInfo } from "./backend";
import { sameFolder } from "./deep-link";
import { ShellIntegrationParser } from "./shell-integration";
import type { ShellEvent } from "./shell-integration";

/** Where the shell of a pane is: its folder and the git branch of that folder. */
export interface PaneLocation {
  /**
   * The folder to record for the pane. Absent while the shell is still in the folder it started
   * in and the app never chose one (see {@link PaneLocationTracker}): the pane keeps the folder it
   * has, which is none.
   */
  cwd?: string;
  /** The branch (or the short commit of a detached `HEAD`); absent outside a git repository. */
  gitBranch?: string;
}

export interface PaneLocationTrackerOptions {
  /** Reads the git facts of a folder (`Backend.gitInfo`). A failed lookup counts as no repository. */
  gitInfo(cwd: string): Promise<GitInfo | null>;
  /** Called with the location of the shell, at every prompt and every time the folder changes. */
  onLocation(location: PaneLocation): void;
  /**
   * The folder the pane has before the shell reports anything (a restored pane, or one started in
   * a chosen folder). A pane without one started in the default folder of its shell, which the app
   * does not know until the shell says so.
   */
  cwd?: string;
}

/** What one lookup of the branch answers for: a folder, and whether it goes on the pane. */
interface Lookup {
  cwd: string;
  placed: boolean;
}

/**
 * Turns the output of one session into the location of its pane. It owns the parser of that
 * session: feed it every chunk of output, in order. The folder comes from OSC 7 (or OSC 9;9 in
 * cmd); the branch is read again for it each time the shell shows a prompt (OSC 133;A) or a command
 * ends (OSC 133;D), because a command such as `git switch` changes the branch without changing the
 * folder.
 *
 * A pane that started without a folder is not given the one the shell first reports: that is where
 * the shell happened to start, not a place the user went to, and restoring the pane without a
 * folder starts it there again. The branch of that folder is still reported, and the folder is
 * recorded from the moment the shell leaves it (and from then on, even if it comes back).
 *
 * A chunk that holds several of these gives one lookup, not several. Only one lookup is in flight
 * at a time: requests that come meanwhile are replaced by the newest one, so a flood of prompts
 * cannot pile up reads.
 */
export class PaneLocationTracker {
  readonly #options: PaneLocationTrackerOptions;
  readonly #parser = new ShellIntegrationParser();
  #cwd: string | undefined;
  /** The pane has a folder of its own: it started with one, or the shell moved away from its start. */
  #placed: boolean;
  /** The first folder reported by a pane that had none. */
  #origin: string | undefined;
  #inFlight = false;
  /** What to look up when the lookup in flight ends; only the newest request is kept. */
  #queued: Lookup | undefined;

  constructor(options: PaneLocationTrackerOptions) {
    this.#options = options;
    this.#cwd = options.cwd;
    this.#placed = options.cwd !== undefined;
  }

  /** The folder the shell reported last (or the one given at the start); `undefined` if none. */
  get cwd(): string | undefined {
    return this.#cwd;
  }

  /** Reads a chunk of the session output. */
  feed(chunk: Uint8Array | string): void {
    this.#handle(this.#parser.feed(chunk));
  }

  #handle(events: readonly ShellEvent[]): void {
    let refresh = false;
    for (const event of events) {
      if (event.kind === "cwd") {
        this.#follow(event.path);
        refresh = true;
      } else if (event.kind === "prompt-start" || event.kind === "command-end") {
        refresh = true;
      }
    }
    if (refresh && this.#cwd !== undefined) {
      this.#request({ cwd: this.#cwd, placed: this.#placed });
    }
  }

  #follow(path: string): void {
    this.#cwd = path;
    if (this.#placed) return;
    if (this.#origin === undefined) this.#origin = path;
    else if (!sameFolder(this.#origin, path)) this.#placed = true;
  }

  #request(lookup: Lookup): void {
    if (this.#inFlight) {
      this.#queued = lookup;
      return;
    }
    this.#inFlight = true;
    void this.#run(lookup);
  }

  async #run({ cwd, placed }: Lookup): Promise<void> {
    let gitBranch: string | undefined;
    try {
      const info = await this.#options.gitInfo(cwd);
      if (info !== null && info.branch !== "") gitBranch = info.branch;
    } catch {
      // No answer is no branch: a wrong one on the sidebar is worse than none.
    }
    this.#inFlight = false;
    const queued = this.#queued;
    this.#queued = undefined;
    this.#options.onLocation({
      ...(placed ? { cwd } : {}),
      ...(gitBranch !== undefined ? { gitBranch } : {}),
    });
    if (queued !== undefined) this.#request(queued);
  }
}
