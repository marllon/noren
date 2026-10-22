import type { FavoriteLink, FavoriteLinkRef, Space, Workspace } from "./types";

// The profiles and project actions of the Favorites bar (`Workspace.favoriteLinks`): what names one,
// why one is refused, and the three changes the reducer makes to the list. Pure.

/** The links of the bar, in the order they were added; none for a state that never had any. */
export function favoriteLinksOf(ws: Pick<Workspace, "favoriteLinks">): readonly FavoriteLink[] {
  return ws.favoriteLinks ?? [];
}

/** What tells two links apart: a profile by its id, an action by its space and its id in the file. */
export function favoriteLinkKey(link: FavoriteLinkRef): string {
  return link.kind === "profile"
    ? `profile:${link.profileId}`
    : `action:${link.spaceId}\u0000${link.actionId}`;
}

/** The part of a link that names its target, without the name it was shown under. */
export function favoriteLinkRef(link: FavoriteLink): FavoriteLinkRef {
  return link.kind === "profile"
    ? { kind: "profile", profileId: link.profileId }
    : { kind: "action", spaceId: link.spaceId, actionId: link.actionId };
}

const isBlank = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";

/**
 * Why `link` cannot be in the bar, or `undefined` when it can: it is not a link, it has no name or
 * no id, or it is an action of a space the workspace does not have. Whether the profile exists on
 * this computer and whether the file still declares the action are not asked here: they change
 * without the workspace changing, and the tile says so when they do.
 */
export function favoriteLinkProblem(
  link: unknown,
  spaces: readonly Pick<Space, "id">[],
): string | undefined {
  if (typeof link !== "object" || link === null) return "it is not a link";
  const { kind, label, profileId, spaceId, actionId } = link as Record<string, unknown>;
  if (isBlank(label)) return "it has no name";
  if (kind === "profile") return isBlank(profileId) ? "it names no profile" : undefined;
  if (kind !== "action") return `"${String(kind)}" is not a kind of link`;
  if (isBlank(actionId)) return "it names no action";
  if (isBlank(spaceId) || !spaces.some((space) => space.id === spaceId)) {
    return `space ${String(spaceId)} is not in the workspace`;
  }
  return undefined;
}

/**
 * The workspace with the link at the end of the list. A link that is refused (`favoriteLinkProblem`)
 * or already there changes nothing, and the same workspace comes back.
 */
export function addFavoriteLink(ws: Workspace, link: FavoriteLink): Workspace {
  if (favoriteLinkProblem(link, ws.spaces) !== undefined) return ws;
  const links = favoriteLinksOf(ws);
  const key = favoriteLinkKey(link);
  if (links.some((other) => favoriteLinkKey(other) === key)) return ws;
  const label = link.label.trim();
  const kept: FavoriteLink =
    link.kind === "profile"
      ? { kind: "profile", profileId: link.profileId, label }
      : { kind: "action", spaceId: link.spaceId, actionId: link.actionId, label };
  return { ...ws, favoriteLinks: [...links, kept] };
}

/** The workspace without the link `ref` names; the same workspace when it is not in the list. */
export function removeFavoriteLink(ws: Workspace, ref: FavoriteLinkRef): Workspace {
  const links = favoriteLinksOf(ws);
  const key = favoriteLinkKey(ref);
  if (!links.some((link) => favoriteLinkKey(link) === key)) return ws;
  return { ...ws, favoriteLinks: links.filter((link) => favoriteLinkKey(link) !== key) };
}

/**
 * The workspace without the actions of a space that is gone (the profiles stay): a space leaves
 * through `space/delete` and when a window that was made for a tab is closed, and the bar must not
 * keep a tile for either. The same workspace when every action still has its space.
 */
export function settleFavoriteLinks(ws: Workspace): Workspace {
  const links = favoriteLinksOf(ws);
  const gone = (link: FavoriteLink): boolean =>
    link.kind === "action" && !ws.spaces.some((space) => space.id === link.spaceId);
  if (!links.some(gone)) return ws;
  return { ...ws, favoriteLinks: links.filter((link) => !gone(link)) };
}
