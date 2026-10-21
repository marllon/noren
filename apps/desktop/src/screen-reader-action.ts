import { DEFAULT_SCREEN_READER_MODE } from "@noren/model";
import type { Config, ConfigChange, ConfigManager } from "@noren/model";
import { t } from "./i18n";
import { TERMINAL_PATHS } from "./settings-sections";

// "Toggle screen reader mode" of the palette: flips `terminal.screenReaderMode` in the file through
// `ConfigManager.update`, the call the settings screen makes, so a comment of the file stays and
// the terminals that are open follow the file at once (see `TerminalView`).

/** Whether the mode is on in the settings in force. */
export function screenReaderModeOn(config: Config): boolean {
  return config.terminal?.screenReaderMode ?? DEFAULT_SCREEN_READER_MODE;
}

/** The change that flips the mode. */
export function planScreenReaderToggle(config: Config): ConfigChange {
  return { path: TERMINAL_PATHS.screenReaderMode, value: !screenReaderModeOn(config) };
}

/**
 * Flips the mode and resolves to the sentence to say: that the mode is now on or off, or the reason
 * the file could not be written (a problem of its own, a failed write).
 */
export async function runScreenReaderToggle(
  manager: Pick<ConfigManager, "state" | "update">,
): Promise<string> {
  const change = planScreenReaderToggle(manager.state.config);
  const result = await manager.update([change]);
  if (!result.ok) return result.message;
  return change.value === true ? t("screenReader.on") : t("screenReader.off");
}
