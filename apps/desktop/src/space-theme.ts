import type { Theme } from "./theme";

// The choices a space offers for its own theme: the themes of the build, and "Use global theme" to
// take the space's own theme back. The menu of the space and the list of the palette draw these.

/** One choice: a theme, or (`themeId` null) the global theme again. */
export interface SpaceThemeOption {
  /** The id to give the space, or `null` for `space/set-theme` to clear it. */
  themeId: string | null;
  label: string;
  /** This is the space's choice now. */
  current: boolean;
}

export const USE_GLOBAL_THEME = "Use global theme";

/**
 * The options in the order of `themes`, then "Use global theme" last. The current one is the theme
 * the space names; a space with no theme, or one this build does not have, uses the global theme.
 */
export function spaceThemeOptions(
  spaceThemeId: string | undefined,
  themes: readonly Theme[],
): SpaceThemeOption[] {
  const own = themes.some((theme) => theme.id === spaceThemeId) ? spaceThemeId : undefined;
  return [
    ...themes.map((theme) => ({
      themeId: theme.id,
      label: theme.name,
      current: theme.id === own,
    })),
    { themeId: null, label: USE_GLOBAL_THEME, current: own === undefined },
  ];
}
