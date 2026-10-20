import { insideTauri } from "./backend";
import { tauriQuickEvents, windowPreviewEnabled, windowPreviewEvents } from "./quick";
import type { QuickEvents } from "./quick";

/**
 * How the main window reaches the pages of the other windows: the events of the app inside the
 * desktop app, the in-memory ones in a browser opened with `?window-preview` (the e2e tests), and
 * none in any other browser, where there is nowhere to show another window. `undefined` also says
 * the interface must not offer to move a tab to a window.
 */
export function windowEventsOfApp(): QuickEvents | undefined {
  if (insideTauri) return tauriQuickEvents();
  return windowPreviewEnabled ? windowPreviewEvents : undefined;
}

/** Whether this build of the page can show other windows. */
export function windowsAvailable(): boolean {
  return insideTauri || windowPreviewEnabled;
}
