import { SYSTEM_THEME, THEMES } from "@noren/model";
import type { Config, ConfigChange, ConfigManager, Theme } from "@noren/model";

// Which theme the user picked. It is a setting of the file (`appearance.theme` in config.jsonc):
// the id of a theme, or `system` (or no value) to follow the color scheme of the operating system.
// Pure: the choice in force is read from the settings, and picking one in the palette is planned
// into a change that `ConfigManager.update` writes, the same call as the settings screen, so the
// comments of the file stay and the window follows the file.
//
// "A theme the build has" is a theme in the list given: the built-in themes by default, and the
// whole list (the themes of the user too) where the window asks.

/** The id of a known theme, or `null` to follow the system. */
export type ThemeChoice = string | null;
// The global theme is `appearance.theme` of the file. A space can have a theme of its own
// (`themeId` in `state.json`, set by `space/set-theme`); it wins while the space is active.

/** Where the choice is in the file. */
export const THEME_PATH: readonly string[] = ["appearance", "theme"];

const has = (themes: readonly Theme[], id: string): boolean =>
  themes.some((theme) => theme.id === id);

/**
 * The choice the settings make: the id of the theme they name, or `null` (follow the system) when
 * they name none, name `system`, or name a theme that is not in `themes`.
 */
export function themeChoiceOf(config: Config, themes: readonly Theme[] = THEMES): ThemeChoice {
  const id = config.appearance?.theme;
  return id !== undefined && has(themes, id) ? id : null;
}

/** What decides the theme the window shows (see `effectiveThemeChoice`). */
export interface ThemeSources {
  /** The theme highlighted in a list right now, unsaved (`choice` null: the system's theme). */
  preview?: { choice: ThemeChoice } | undefined;
  /** The `themeId` of the active space, if it has one of its own. */
  spaceThemeId?: string | undefined;
  /** The settings in force (their `appearance.theme` is the global theme). */
  config: Config;
  /** The themes the window has: the built-in ones, and the user's. Defaults to the built-in ones. */
  themes?: readonly Theme[];
}

/**
 * The theme the window shows, as an id (`null`: follow the system). In order: the preview, then the
 * theme of the active space when it is one of `themes`, then the global theme of the settings. A
 * theme id that is not in `themes`, in the space or in the settings, never gets in the way: it
 * falls to the next one in the list.
 */
export function effectiveThemeChoice({
  preview,
  spaceThemeId,
  config,
  themes = THEMES,
}: ThemeSources): ThemeChoice {
  if (preview !== undefined) return preview.choice;
  if (spaceThemeId !== undefined && has(themes, spaceThemeId)) return spaceThemeId;
  return themeChoiceOf(config, themes);
}

/** The answer: the changes to write (none when the file already says it), or why it is refused. */
export type ThemePlan = { changes: ConfigChange[] } | { refusal: string };

/**
 * Plans picking `choice`. A theme is written as its id; the system is written as `system`, but only
 * when the file says something else (a file with no choice already follows the system).
 */
export function planThemeChoice(
  config: Config,
  choice: ThemeChoice,
  themes: readonly Theme[] = THEMES,
): ThemePlan {
  const written = config.appearance?.theme;
  if (choice === null) {
    if (written === undefined || written === SYSTEM_THEME) return { changes: [] };
    return { changes: [{ path: THEME_PATH, value: SYSTEM_THEME }] };
  }
  if (!has(themes, choice)) return { refusal: `There is no theme "${choice}".` };
  if (written === choice) return { changes: [] };
  return { changes: [{ path: THEME_PATH, value: choice }] };
}

/**
 * Writes the choice into the file through `ConfigManager.update`. Resolves to the notice to show
 * when the choice is refused, the file has a problem of its own or the write fails; `undefined`
 * when it worked (or there was nothing to write).
 */
export async function runThemeChoice(
  manager: Pick<ConfigManager, "state" | "update">,
  choice: ThemeChoice,
  themes: readonly Theme[] = THEMES,
): Promise<string | undefined> {
  const plan = planThemeChoice(manager.state.config, choice, themes);
  if ("refusal" in plan) return plan.refusal;
  if (plan.changes.length === 0) return undefined;
  const result = await manager.update(plan.changes);
  return result.ok ? undefined : result.message;
}
