import { layoutPanes } from "@noren/model";
import type { AgentSettings, Backend, Clock, Id, Workspace } from "@noren/model";

// Looks at the process tree of the sessions on an interval and tells which pane has an agent under
// its shell. The look itself is the backend's (`scanAgents`: in the app a command that reads the
// list of processes off the thread of the interface), so a slow look never holds the page; the
// scanner only keeps one look in flight, so a slow machine is asked again after the answer and not
// on top of it. Everything it needs is handed in, so the rules are tested with a manual clock and
// the fake backend.
//
// - With `agents.enabled` off, nothing is asked and the panes have no agent from the tree.
// - Only panes with a live session are asked about. A pane that exited, or has no session yet, is
//   left out, and so is the pane of a session the backend no longer knows.
// - The settings are read at every look, so a changed file applies at once, interval included.

export interface AgentScannerOptions {
  clock: Clock;
  backend: Pick<Backend, "scanAgents">;
  /** The workspace now. */
  workspace(): Workspace;
  /** The settings now: on or off, the catalog and the interval. */
  settings(): AgentSettings;
  /** Receives the agent under each pane's shell, after every look. */
  onResult(agents: ReadonlyMap<Id, string>): void;
  onError?(error: unknown): void;
}

export class AgentScanner {
  readonly #options: AgentScannerOptions;
  #cancel: (() => void) | undefined;
  #running = false;
  #inFlight: Promise<void> | undefined;

  constructor(options: AgentScannerOptions) {
    this.#options = options;
  }

  /** Starts looking: once now, then after each interval. Starting a scanner that is running changes nothing. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.scan();
    this.#schedule();
  }

  /** Stops the looks. A look that is under way still ends. */
  stop(): void {
    this.#running = false;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  /**
   * Looks now. Never rejects; a failure goes to `onError` and leaves the last answer as it was. A
   * look that is already under way is the answer to this one.
   */
  scan(): Promise<void> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const look = this.#look().finally(() => {
      this.#inFlight = undefined;
    });
    this.#inFlight = look;
    return look;
  }

  #schedule(): void {
    const delay = this.#options.settings().scanIntervalMs;
    this.#cancel = this.#options.clock.setTimer(() => {
      // The next one is set first, so the cadence does not depend on how long a look takes.
      if (!this.#running) return;
      this.#schedule();
      void this.scan();
    }, delay);
  }

  async #look(): Promise<void> {
    const options = this.#options;
    try {
      const settings = options.settings();
      const sessions = new Map<number, Id>();
      if (settings.enabled && settings.catalog.length > 0) {
        for (const space of options.workspace().spaces) {
          for (const item of Object.values(space.items)) {
            for (const pane of layoutPanes(item.layout)) {
              if (pane.sessionId === undefined || pane.status === "exited") continue;
              sessions.set(Number(pane.sessionId), pane.id);
            }
          }
        }
      }
      const found = new Map<Id, string>();
      if (sessions.size > 0) {
        const hits = await options.backend.scanAgents([...sessions.keys()], settings.catalog);
        for (const hit of hits) {
          const paneId = sessions.get(hit.sessionId);
          if (paneId !== undefined) found.set(paneId, hit.agentId);
        }
      }
      options.onResult(found);
    } catch (error) {
      options.onError?.(error);
    }
  }
}
