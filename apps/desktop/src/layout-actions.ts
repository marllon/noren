import type { Config, ConfigChange, ConfigManager } from "@noren/model";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, layoutOf } from "./layout";
import type { Layout } from "./layout";
import {
  SETTING_PATHS,
  WIDTH_PROBLEM,
  compactAvailable,
  keepOpenAvailable,
} from "./settings-screen";

// The layout modes as actions of the registry (palette and shortcuts screen). Pure: a layout
// command and the settings in force give the change to write into `config.jsonc`, or the reason
// there is nothing to write. `App.tsx` hands the changes to `ConfigManager.update`, the same call
// as the settings screen, so a comment of the file stays and the interface follows the file.

/** The settings a layout action flips. */
export type LayoutToggle = "side" | "density" | "compact" | "keepOpen" | "tabs";

/** What a layout action asks for: flip one mode, or move the sidebar width by `delta` pixels. */
export type LayoutCommand =
  { kind: "layout"; toggle: LayoutToggle } | { kind: "layout-width"; delta: number };

/** The answer: the changes to write, or the notice that says why none is made. */
export type LayoutPlan = { changes: ConfigChange[] } | { refusal: string };

const OTHER_SIDE: Record<Layout["side"], Layout["side"]> = { left: "right", right: "left" };
const OTHER_DENSITY: Record<Layout["density"], Layout["density"]> = {
  comfortable: "compact",
  compact: "comfortable",
};
const OTHER_TABS: Record<Layout["tabs"], Layout["tabs"]> = { sidebar: "top", top: "sidebar" };

/** A width is usable when it is whole pixels from 180 to 480. */
export function widthInRange(width: number): boolean {
  return Number.isInteger(width) && width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH;
}

/** The layout change for `value` on `key`, written at the place of that setting in the file. */
function change(key: keyof Layout, value: string | number | boolean): LayoutPlan {
  return { changes: [{ path: SETTING_PATHS[key], value }] };
}

/** Plans the width: a value out of the range is refused, never clamped into one. */
export function planWidth(width: number): LayoutPlan {
  if (!widthInRange(width)) return { refusal: WIDTH_PROBLEM };
  return change("width", width);
}

/**
 * Plans a layout command against the settings in force. Each command changes only its own setting.
 * Compact mode and keeping the sidebar open mean nothing with top tabs (the sidebar always hides)
 * or, for the second, without compact mode; as in the settings screen they are refused there.
 */
export function planLayoutCommand(config: Config, command: LayoutCommand): LayoutPlan {
  const layout = layoutOf(config);
  if (command.kind === "layout-width") {
    const wanted = layout.width + command.delta;
    if (widthInRange(wanted)) return change("width", wanted);
    if (command.delta > 0 && layout.width < MAX_SIDEBAR_WIDTH) {
      return change("width", MAX_SIDEBAR_WIDTH);
    }
    if (command.delta < 0 && layout.width > MIN_SIDEBAR_WIDTH) {
      return change("width", MIN_SIDEBAR_WIDTH);
    }
    return {
      refusal:
        command.delta > 0
          ? `The sidebar is already as wide as it goes (${MAX_SIDEBAR_WIDTH} px).`
          : `The sidebar is already as narrow as it goes (${MIN_SIDEBAR_WIDTH} px).`,
    };
  }
  switch (command.toggle) {
    case "side":
      return change("side", OTHER_SIDE[layout.side]);
    case "density":
      return change("density", OTHER_DENSITY[layout.density]);
    case "tabs":
      return change("tabs", OTHER_TABS[layout.tabs]);
    case "compact":
      if (!compactAvailable(layout)) {
        return {
          refusal: "Compact mode has no effect with top tabs: the sidebar is always hidden.",
        };
      }
      return change("compact", !layout.compact);
    case "keepOpen":
      if (!keepOpenAvailable(layout)) {
        return {
          refusal: "Keeping the sidebar open needs compact mode, and it is not used with top tabs.",
        };
      }
      return change("keepOpen", !layout.keepOpen);
  }
}

/**
 * Carries out a layout command: plans it against the settings in force and writes the change into
 * the file through `ConfigManager.update` (the settings screen's own call, so comments stay and the
 * interface follows the file). Resolves to the notice to show when the command is refused, the file
 * has a problem of its own or the write fails; `undefined` when it worked.
 */
export async function runLayoutCommand(
  manager: Pick<ConfigManager, "state" | "update">,
  command: LayoutCommand,
): Promise<string | undefined> {
  const plan = planLayoutCommand(manager.state.config, command);
  if ("refusal" in plan) return plan.refusal;
  const result = await manager.update(plan.changes);
  return result.ok ? undefined : result.message;
}
