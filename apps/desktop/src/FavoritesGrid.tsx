import type { CSSProperties } from "react";
import type { Id } from "@noren/model";
import { menuPoint } from "./ContextMenu";
import { useT } from "./i18n";
import type { ResolvedFavorite } from "./favorites";
import type { MenuPoint } from "./SpaceMenu";
import { useOutsideDrop } from "./TreeDnd";

interface FavoritesGridProps {
  /** The favorites to show; the grid is not rendered at all when there are none. */
  favorites: readonly ResolvedFavorite[];
  /** The tab on screen, as `spaceId` and `itemId`, which lights its tile. */
  active: { spaceId: Id; itemId: Id | undefined };
  /** Click or Enter on a tile: show the space that owns the tab, then the tab. */
  onOpen(favorite: ResolvedFavorite): void;
  /** Right click (or the menu key) on a tile. */
  onMenu(favorite: ResolvedFavorite, point: MenuPoint): void;
}

/**
 * The global favorites as a grid of tiles at the top of the sidebar, shown in every space. It is
 * also where a tab dragged from the tree becomes a favorite. It must sit inside the `TreeDnd`.
 */
export function FavoritesGrid({ favorites, active, onOpen, onMenu }: FavoritesGridProps) {
  const t = useT();
  const drop = useOutsideDrop({ kind: "favorites" });
  return (
    <section
      ref={drop.ref}
      className="favorites"
      data-nr-part="favorites"
      data-nr-state={drop.over ? "over" : undefined}
      aria-label={t("favorites.label")}
    >
      <ul className="favorites-grid">
        {favorites.map((favorite) => {
          const isActive = favorite.spaceId === active.spaceId && favorite.id === active.itemId;
          return (
            <li key={favorite.id}>
              <button
                type="button"
                className="favorite-button"
                data-nr-part="favorite"
                data-nr-state={isActive ? "active" : undefined}
                data-nr-space={favorite.spaceId}
                aria-label={favorite.title}
                aria-current={isActive ? "true" : undefined}
                title={favorite.title}
                style={{ "--nr-favorite-color": favorite.spaceColor } as CSSProperties}
                onClick={() => onOpen(favorite)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onMenu(favorite, menuPoint(event));
                }}
              >
                <span className="favorite-initial" aria-hidden="true">
                  {favorite.initial}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
