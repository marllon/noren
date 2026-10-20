import { layoutPanes } from "@noren/model";
import type { Id, Item, LayoutNode, Pane } from "@noren/model";
import { t } from "./i18n";
import { browserTitle } from "./browser-address";
import { commandInfo, shortCwd } from "./pane-info";
import type { CommandInfo } from "./pane-info";

/** A pane of the thumbnail: its box inside the layout, in percent of the whole (0 to 100). */
export interface ThumbCell {
  paneId: Id;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Percent values are kept to two decimals so the markup stays stable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The boxes of a layout in order, each pane with the share of the whole it takes. A split lays its
 * children along its direction (`row` side by side, `column` stacked) by `sizes`; a size list that
 * does not match the children is read as equal shares.
 */
export function layoutThumbnail(
  layout: LayoutNode,
  box: Omit<ThumbCell, "paneId"> = { x: 0, y: 0, w: 100, h: 100 },
): ThumbCell[] {
  if (layout.kind === "pane") return [{ paneId: layout.pane.id, ...box }];
  const count = layout.children.length;
  const valid =
    layout.sizes.length === count && layout.sizes.every((s) => Number.isFinite(s) && s > 0);
  const total = valid ? layout.sizes.reduce((sum, s) => sum + s, 0) : count;
  let offset = 0;
  return layout.children.flatMap((child, index) => {
    const share =
      ((valid ? (layout.sizes[index] ?? 0) : 1) / total) * (layout.dir === "row" ? box.w : box.h);
    const at = offset;
    offset += share;
    const next =
      layout.dir === "row"
        ? { x: round(box.x + at), y: box.y, w: round(share), h: box.h }
        : { x: box.x, y: round(box.y + at), w: box.w, h: round(share) };
    return layoutThumbnail(child, next);
  });
}

/** An item shows the thumbnail and the pane list only when it holds two panes or more. */
export function isSplitItem(item: Item): boolean {
  return layoutPanes(item.layout).length >= 2;
}

/** Status of a pane as the sidebar words it: `running`, `idle` or `exit N` (`exit` with no code). */
export function paneStatusText(pane: Pane): string {
  if (pane.type === "browser") return t("pane.browser");
  if (pane.status === "running" || pane.runningCommand !== undefined) return t("pane.running");
  if (pane.status === "exited")
    return pane.exitCode === undefined
      ? t("pane.exit")
      : t("pane.exitCode", { code: pane.exitCode });
  return t("pane.idle");
}

/** The title a pane goes by: its short folder, or `Terminal` when it has none. */
export function paneTitleText(pane: Pane, defaultCwd?: string, home?: string): string {
  if (pane.type === "browser") return browserTitle(pane.url);
  const cwd = pane.cwd ?? defaultCwd;
  const short = cwd !== undefined ? shortCwd(cwd, home) : "";
  return short !== "" ? short : t("pane.title");
}

/** One line of the pane list under a split item. */
export interface PaneEntry {
  paneId: Id;
  title: string;
  status: string;
  /** The command the pane runs now, else the last one it ran. */
  command?: CommandInfo;
  /** The pane that has the keyboard in its item. */
  focused: boolean;
}

/** The panes of a split item in layout order; empty for an item with fewer than two panes. */
export function paneEntries(item: Item, defaultCwd?: string, home?: string): PaneEntry[] {
  const panes = layoutPanes(item.layout);
  if (panes.length < 2) return [];
  return panes.map((pane) => {
    const command = commandInfo(pane);
    return {
      paneId: pane.id,
      title: paneTitleText(pane, defaultCwd, home),
      status: paneStatusText(pane),
      ...(command !== undefined ? { command } : {}),
      focused: pane.id === item.focusedPaneId,
    };
  });
}
