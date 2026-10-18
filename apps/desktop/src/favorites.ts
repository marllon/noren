import type { Id, Space } from "@noren/model";
import { spaceItemIds } from "./workspace-store";

// The global favorites as the sidebar grid shows them. Pure: the grid only draws what this returns.

/** The name of a tab: its title, else a placeholder counted in the order of its space. */
export function itemTitle(space: Space, itemId: Id): string {
  const item = space.items[itemId];
  return item?.title ?? `Tab ${spaceItemIds(space).indexOf(itemId) + 1}`;
}

/** The first letter or digit of a title, upper case, for the tile of a favorite. */
export function titleInitial(title: string): string {
  const first = Array.from(title.trim()).find((char) => /[\p{L}\p{N}]/u.test(char));
  return (first ?? Array.from(title.trim())[0] ?? "?").toUpperCase();
}

/** A favorite with the space that owns the tab, ready to draw and to open. */
export interface ResolvedFavorite {
  id: Id;
  spaceId: Id;
  spaceName: string;
  spaceColor: string;
  title: string;
  initial: string;
}

/**
 * The favorites that still exist, in the order they were added, each with its owner space. An id
 * that no space holds any more (a stale file) is left out, and so is a repeated id.
 */
export function resolveFavorites(
  spaces: readonly Space[],
  favorites: readonly Id[],
): ResolvedFavorite[] {
  const seen = new Set<Id>();
  return favorites.flatMap((id): ResolvedFavorite[] => {
    if (seen.has(id)) return [];
    const owner = spaces.find((space) => Object.hasOwn(space.items, id));
    if (!owner) return [];
    seen.add(id);
    const title = itemTitle(owner, id);
    return [
      {
        id,
        spaceId: owner.id,
        spaceName: owner.name,
        spaceColor: owner.color,
        title,
        initial: titleInitial(title),
      },
    ];
  });
}
