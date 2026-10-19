import { useMemo, useSyncExternalStore } from "react";
import type { SpaceBackground } from "@noren/model";
import { useConfigState } from "./config-store";
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

/** The look of the window now. */
export function useWindowAppearance(): WindowAppearance {
  const config = useConfigState().config;
  const theme = useTheme();
  const applied = useAppliedWindowEffect();
  const own = useSpaceBackground();
  return useMemo(
    () => windowAppearance({ config, theme, applied, spaceBackground: own }),
    [config, theme, applied, own],
  );
}
