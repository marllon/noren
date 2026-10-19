import { useSyncExternalStore } from "react";
import { backend } from "./boot";
import { QuickShortcutSync } from "./quick-shortcut";
import type { QuickShortcutStatus } from "./quick-shortcut";

/** The quick terminal's global shortcut of this window, shared by the shell and the settings screen. */
export const quickShortcut = new QuickShortcutSync(backend);

/** What the system holds for the quick terminal's shortcut, following the changes. */
export function useQuickShortcutStatus(): QuickShortcutStatus {
  return useSyncExternalStore(
    (onChange) => quickShortcut.subscribe(onChange),
    () => quickShortcut.status,
  );
}
