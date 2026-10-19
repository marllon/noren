import { FakeBackend, archiveSettingsOf } from "@noren/model";
import type { Backend, Clock, Id } from "@noren/model";
import { AutoArchiver } from "./auto-archiver";
import { configManager } from "./config-store";
import { realClock } from "./real-clock";
import type { WorkspaceStore } from "./workspace-store";

// The auto-archive while the app runs: the archiver (see `auto-archiver.ts`) checks every minute,
// reading the `archive` settings of the file at each check, and the terminals tell here that a
// pane printed. Putting a tab away is `item/archive`; the scrollback service writes its output as
// that action ends, as it does for a tab that closes.

let archiver: AutoArchiver | undefined;

/** A pane printed something: its tab is alive. */
export function noteArchiveActivity(paneId: Id): void {
  archiver?.noteActivity(paneId);
}

/** The archiver that is running, for tests and diagnostics. */
export function currentAutoArchiver(): AutoArchiver | undefined {
  return archiver;
}

/**
 * The clock of the checks. In the app it is the real one. In web mode it is the clock the fake shell
 * runs on, which the tests move by hand (`advanceClock`): the timers are its own, and the time it
 * tells is the real time plus what the tests moved it by, so a test that advances it by an hour
 * finds every tab an hour older, and the tabs made by the page (stamped with the real time) agree
 * with it.
 */
export function archiveClock(backend: Backend): Clock {
  if (!(backend instanceof FakeBackend)) return realClock;
  const manual = backend.clock;
  return {
    now: () => realClock.now() + manual.now(),
    setTimer: (callback, delayMs) => manual.setTimer(callback, delayMs),
  };
}

export interface AutoArchiveServiceOptions {
  store: WorkspaceStore;
  clock: Clock;
  onError?(error: unknown): void;
}

/** Starts the checks of the auto-archive. Starting again replaces the archiver that was running. */
export function startAutoArchive(options: AutoArchiveServiceOptions): AutoArchiver {
  archiver?.stop();
  const { store } = options;
  const started = new AutoArchiver({
    clock: options.clock,
    workspace: () => store.getState().workspace,
    settings: () => archiveSettingsOf(configManager.state.config.archive),
    dispatch: (action) => store.getState().dispatch(action),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  archiver = started;
  started.start();
  return started;
}
