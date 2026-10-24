// What the app does before it leaves: the one save that closing the window runs (`closeSave` in
// `boot.ts`: the scrollback snapshots, the state, and the push of `sync.pushOnClose` when it is on).
// The installer of an update ends the app without going through the close of the window (on Windows
// the plugin starts the installer and exits the process), so the screen of the update runs this
// first, and installs only after it (NOR-F20-02b). `boot.ts` sets it once the
// workspace exists; before that there is nothing to save.

let save: (() => Promise<void>) | undefined;

/** Sets the save the app runs before it leaves. It resolves when done, when it fails, or when it gives up on time. */
export function setExitSave(next: (() => Promise<void>) | undefined): void {
  save = next;
}

/** Runs the save of closing; resolves with nothing to save when the app has not started yet. Never rejects. */
export async function saveBeforeExit(): Promise<void> {
  try {
    await save?.();
  } catch {
    // Closing goes on when a save fails; so does an update.
  }
}
