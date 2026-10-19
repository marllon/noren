import type { ProjectAction } from "./actions-file";
import { parseActionsFile } from "./actions-file";
import type { Backend } from "./backend";
import type { Clock } from "./clock";

/** How often the actions file of a folder is read again, in milliseconds. */
export const ACTIONS_POLL_MS = 2000;

/** What the actions file of a folder is right now. */
export type ActionsFileState =
  /** There is no `.noren/actions.json` in the folder. */
  | { status: "missing" }
  /** The file is there and valid. */
  | { status: "ok"; actions: ProjectAction[] }
  /** The file is there but refused as a whole; `reason` says where. */
  | { status: "invalid"; reason: string }
  /** The file could not be read (for example a folder in its place). */
  | { status: "unreadable"; reason: string };

export interface WatchActionsFileOptions {
  backend: Pick<Backend, "readActionsFile">;
  /** Default folder of the space. */
  cwd: string;
  /** Time source for the polling. */
  clock: Clock;
  /** Defaults to `ACTIONS_POLL_MS`. */
  intervalMs?: number;
  /** Called with the first state, then again only when the file changes. */
  onChange(state: ActionsFileState): void;
}

export interface ActionsFileWatcher {
  /** Stops the polling for good. A read still in flight is dropped. */
  dispose(): void;
}

/** What a read gave, before parsing. */
type Reading =
  { kind: "text"; text: string } | { kind: "missing" } | { kind: "error"; reason: string };

/** Two readings with the same key are the same file as far as the interface can tell. */
const keyOf = (reading: Reading): string =>
  reading.kind === "text"
    ? `text:${reading.text}`
    : reading.kind === "error"
      ? `error:${reading.reason}`
      : "missing";

const toState = (reading: Reading): ActionsFileState => {
  if (reading.kind === "missing") return { status: "missing" };
  if (reading.kind === "error") return { status: "unreadable", reason: reading.reason };
  const parsed = parseActionsFile(reading.text);
  return parsed.ok
    ? { status: "ok", actions: parsed.actions }
    : { status: "invalid", reason: parsed.reason };
};

/**
 * Keeps up with the `.noren/actions.json` of a folder: reads it now, then again every interval,
 * and calls `onChange` with the first state and after that only when the text changed (the file
 * appearing, disappearing, or turning valid or invalid included). A change that leaves the text
 * as it was, and a read that fails the same way twice, are not reported again.
 *
 * The next read is scheduled only after the previous one ended, so reads never pile up. A failed
 * read is reported as `unreadable` and polling goes on. Nothing is read once `dispose` was called.
 */
export function watchActionsFile(options: WatchActionsFileOptions): ActionsFileWatcher {
  const { backend, cwd, clock, onChange } = options;
  const intervalMs = options.intervalMs ?? ACTIONS_POLL_MS;
  let disposed = false;
  let cancelTimer: (() => void) | undefined;
  let lastKey: string | undefined;

  const read = async (): Promise<Reading> => {
    try {
      const text = await backend.readActionsFile(cwd);
      return text === null ? { kind: "missing" } : { kind: "text", text };
    } catch (error) {
      return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const poll = async (): Promise<void> => {
    cancelTimer = undefined;
    const reading = await read();
    if (disposed) return;
    try {
      const key = keyOf(reading);
      if (key !== lastKey) {
        lastKey = key;
        onChange(toState(reading));
      }
    } finally {
      if (!disposed) cancelTimer = clock.setTimer(() => void poll(), intervalMs);
    }
  };

  void poll();

  return {
    dispose() {
      disposed = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}
