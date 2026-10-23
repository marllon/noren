import { Play, Terminal } from "lucide-react";
import { useId } from "react";
import type { CSSProperties } from "react";
import type { Id, Space } from "@noren/model";
import { useAgentStateOfPane } from "./agent-state-store";
import { useAgentOfPane } from "./agent-store";
import { menuPoint } from "./ContextMenu";
import { useT } from "./i18n";
import { useInterfaceStyle } from "./layout-store";
import { indicatorLabels, summarizeItem } from "./pane-info";
import type { BarTile } from "./favorites";
import type { FavoritesPlacement } from "./layout";
import type { MenuPoint } from "./SpaceMenu";
import { tabDotOf } from "./tab-dot";
import type { TabDot } from "./tab-dot";
import { useOutsideDrop } from "./TreeDnd";

interface FavoritesGridProps {
  /**
   * Where the bar is drawn: at the top of the sidebar (a grid of tiles that wraps to the width of the
   * sidebar) or in a bar of its own at the top of the window (one row of tiles). The same bar, the
   * same tiles, menus and drop place: only the box around the tiles changes.
   */
  placement?: FavoritesPlacement;
  /** The tiles to show; with none, the bar is still there and says how to add one. */
  tiles: readonly BarTile[];
  /** The tab on screen, as `spaceId` and `itemId`, which lights its tile. */
  active: { spaceId: Id; itemId: Id | undefined };
  /** The spaces, to read the state of a favorite tab (the glass style shows it as a dot on its tile). */
  spaces?: readonly Space[];
  /**
   * Click or Enter on a tile: show the tab, open a tab with the profile, or run the action. A tile
   * that is unavailable is clicked too, so the page can say why it does nothing.
   */
  onOpen(tile: BarTile): void;
  /** Right click (or the menu key) on a tile. */
  onMenu(tile: BarTile, point: MenuPoint): void;
}

/**
 * The global favorites as a bar of tiles at the top of the sidebar (or, with `placement` "top", at the
 * top of the window), shown in every space and always on screen: the favorite tabs (the first letter of the title), then the shell profiles (a terminal)
 * and the project actions (a play mark) kept next to them. With nothing in it the bar holds a line
 * that says how to add one, so the place is there to be found. It is also where a tab dragged from
 * the tree becomes a favorite, empty or not. It must sit inside the `TreeDnd`.
 */
export function FavoritesGrid({
  placement = "sidebar",
  tiles,
  active,
  spaces = [],
  onOpen,
  onMenu,
}: FavoritesGridProps) {
  const t = useT();
  const drop = useOutsideDrop({ kind: "favorites" });
  const reasonId = useId();
  const style = useInterfaceStyle();
  const glass = style === "glass";
  const dense = style === "dense";
  const agentOf = useAgentOfPane();
  const agentStateOf = useAgentStateOfPane();
  return (
    <section
      ref={drop.ref}
      className="favorites"
      data-nr-part="favorites"
      data-nr-placement={placement}
      data-nr-state={drop.over ? "over" : undefined}
      aria-label={t("favorites.label")}
    >
      {tiles.length === 0 ? (
        <p className="favorites-hint" data-nr-part="favorites-hint">
          {t("favorites.hint")}
        </p>
      ) : (
        <ul className="favorites-grid">
          {tiles.map((tile, index) => {
            const isActive =
              tile.kind === "tab" &&
              tile.favorite.spaceId === active.spaceId &&
              tile.favorite.id === active.itemId;
            const unavailable = tile.kind === "tab" ? undefined : tile.unavailable;
            const name =
              tile.kind === "tab"
                ? tile.favorite.title
                : tile.kind === "profile"
                  ? t("palette.newProfileTab", { name: tile.title })
                  : tile.running
                    ? t("favorites.showAction", { name: tile.title })
                    : t("menu.run", { name: tile.title });
            const color =
              tile.kind === "tab"
                ? tile.favorite.spaceColor
                : tile.kind === "action"
                  ? tile.spaceColor
                  : "var(--nr-accent)";
            const state = isActive
              ? "active"
              : unavailable !== undefined
                ? "unavailable"
                : tile.kind === "action" && tile.running
                  ? "running"
                  : undefined;
            const reason = `${reasonId}-${index}`;
            // The glass style puts a dot on the corner of a tile that needs the person (an agent
            // waiting) or is busy (a command or an agent working, a project action running).
            let dot: TabDot | undefined;
            let dotWords = "";
            if ((glass || dense) && tile.kind === "tab") {
              const owner = spaces.find((space) => space.id === tile.favorite.spaceId);
              const item = owner?.items[tile.favorite.id];
              if (owner !== undefined && item !== undefined) {
                const summary = summarizeItem(item, owner.defaults.cwd, agentOf, agentStateOf);
                dot = tabDotOf(summary);
                dotWords = indicatorLabels(summary).join(". ");
              }
            } else if ((glass || dense) && tile.kind === "action" && tile.running) {
              dot = "running";
            }
            const shownDot = dot === "running" || dot === "waiting" ? dot : undefined;
            const stateId = `${reasonId}-state-${index}`;
            const describedBy =
              unavailable !== undefined
                ? reason
                : shownDot !== undefined && dotWords !== ""
                  ? stateId
                  : undefined;
            return (
              <li key={tile.key}>
                <button
                  type="button"
                  className="favorite-button"
                  data-nr-part="favorite"
                  data-nr-kind={tile.kind}
                  data-nr-state={state}
                  {...(tile.kind === "tab"
                    ? { "data-nr-space": tile.favorite.spaceId }
                    : tile.kind === "action"
                      ? { "data-nr-space": tile.ref.spaceId }
                      : {})}
                  aria-label={name}
                  aria-current={isActive ? "true" : undefined}
                  aria-disabled={unavailable !== undefined ? "true" : undefined}
                  aria-describedby={describedBy}
                  title={unavailable ?? name}
                  style={{ "--nr-favorite-color": color } as CSSProperties}
                  onClick={() => onOpen(tile)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onMenu(tile, menuPoint(event));
                  }}
                >
                  {dense ? (
                    <>
                      {tile.kind === "profile" && <Terminal size={11} aria-hidden="true" />}
                      {tile.kind === "action" && <Play size={9} aria-hidden="true" />}
                      <span
                        className="favorite-label"
                        data-nr-part="favorite-label"
                        aria-hidden="true"
                      >
                        {tile.kind === "tab" ? tile.favorite.title : tile.title}
                      </span>
                    </>
                  ) : tile.kind === "tab" ? (
                    <span className="favorite-initial" aria-hidden="true">
                      {tile.favorite.initial}
                    </span>
                  ) : tile.kind === "profile" ? (
                    <Terminal size={16} aria-hidden="true" />
                  ) : (
                    <Play size={16} aria-hidden="true" />
                  )}
                  {shownDot !== undefined && (
                    <span
                      className="favorite-dot"
                      data-nr-part="favorite-dot"
                      data-nr-dot={shownDot}
                      aria-hidden="true"
                    />
                  )}
                </button>
                {unavailable !== undefined && (
                  <span id={reason} hidden>
                    {unavailable}
                  </span>
                )}
                {unavailable === undefined && shownDot !== undefined && dotWords !== "" && (
                  <span id={stateId} hidden>
                    {dotWords}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
