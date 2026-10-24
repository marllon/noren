import { emit } from "@tauri-apps/api/event";
import { insideTauri } from "./backend";
import { perfMark } from "./perf-probe";

/** The event the page emits once every pane has had its shell (the Rust side then ends what no pane claimed). */
export const RESTORE_SETTLED_EVENT = "restore-settled";

let appReady = false;
let settled = false;
let sent = false;

function sendWhenBoth(): void {
  if (!appReady || !settled || sent) return;
  sent = true;
  perfMark("restore-settled");
  if (!insideTauri) return;
  emit(RESTORE_SETTLED_EVENT).catch(() => undefined);
}

/**
 * Notes that the restore is over: the shell of every terminal pane is started or taken back from the
 * session daemon. The sessions the daemon still holds then belong to no pane (see
 * `AppState::reap_orphans`); the app side is told once the page is up too, so asking the daemon for
 * its sessions never comes before the terminal on screen. Outside the app nothing is sent.
 */
export function reportRestoreSettled(): void {
  settled = true;
  sendWhenBoth();
}

/** Notes that the page is up (`app-ready` was emitted). */
export function noteAppReady(): void {
  appReady = true;
  sendWhenBoth();
}
