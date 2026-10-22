import { useMemo, useSyncExternalStore } from "react";
import type { SpaceBackground } from "@noren/model";
import { useAppearancePreview } from "./appearance-preview";
import { pictureUrl, usePicture } from "./background-image-store";
import { useConfigState } from "./config-store";
import { useInterfaceStyle } from "./layout-store";
import { useTheme } from "./use-theme";
import { windowAppearance } from "./window-appearance";
import type { WindowAppearance } from "./window-appearance";
import { useAppliedWindowEffect } from "./window-effect-store";
import { activeSpaceOf } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

// The look of the window as the interface sees it: the settings, the theme in force, the effect the
// window has and the picture of the active space, put together (`window-appearance.ts`). Switching
// space switches the picture at once, like the theme and the mods of a space.

const listeners = new Set<() => void>();
/** The `background` of the active space. The object of the space itself, replaced when it changes. */
let spaceBackground: SpaceBackground | undefined;
let stopFollowing: (() => void) | undefined;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/**
 * Follows the picture of the active space in `store`: the window shows it while that space is
 * active. Follows one store at a time; a second call replaces the first.
 */
export function followActiveSpaceBackground(
  store: Pick<WorkspaceStore, "getState" | "subscribe">,
): void {
  stopFollowing?.();
  const read = () => {
    const next = activeSpaceOf(store.getState().workspace).background;
    if (next === spaceBackground) return;
    spaceBackground = next;
    notify();
  };
  read();
  stopFollowing = store.subscribe(read);
}

/** Stops following the store and forgets the picture of the space, so a test starts from nothing. */
export function resetSpaceBackground(): void {
  stopFollowing?.();
  stopFollowing = undefined;
  spaceBackground = undefined;
}

/** The picture of the active space; the component renders again when it changes. */
export function useSpaceBackground(): SpaceBackground | undefined {
  return useSyncExternalStore(subscribe, () => spaceBackground);
}

/**
 * The look of the window as the settings and the theme make it, without the picture of the space: the
 * numbers the sliders of the settings screen start from (and the ones its preview has already moved).
 */
export function useSettingsAppearance(): WindowAppearance {
  const config = useConfigState().config;
  const theme = useTheme();
  const applied = useAppliedWindowEffect();
  const preview = useAppearancePreview();
  const pictureShown = pictureUrl(usePicture()) !== null;
  const glass = useInterfaceStyle() === "glass";
  return useMemo(
    () => windowAppearance({ config, theme, applied, pictureShown, glass, preview }),
    [config, theme, applied, pictureShown, glass, preview],
  );
}

/**
 * The look of the window now: the settings, the theme, the space and what a screen is trying out
 * with a slider (`appearance-preview.ts`). A picture that is on screen, not one that is only wanted,
 * is what lets the panels through.
 */
export function useWindowAppearance(): WindowAppearance {
  const config = useConfigState().config;
  const theme = useTheme();
  const applied = useAppliedWindowEffect();
  const own = useSpaceBackground();
  const preview = useAppearancePreview();
  const pictureShown = pictureUrl(usePicture()) !== null;
  const glass = useInterfaceStyle() === "glass";
  return useMemo(
    () =>
      windowAppearance({
        config,
        theme,
        applied,
        spaceBackground: own,
        pictureShown,
        glass,
        preview,
      }),
    [config, theme, applied, own, pictureShown, glass, preview],
  );
}
