import { favoriteLinkRef } from "@noren/model";
import type {
  ActionsFileState,
  FavoriteLink,
  FavoriteLinkRef,
  Id,
  ProjectAction,
  ShellProfile,
  Space,
} from "@noren/model";
import { t } from "./i18n";
import { spaceItemIds } from "./workspace-store";

// The global favorites as the sidebar bar shows them: the favorite tabs, then the profiles and project
// actions kept next to them. Pure: the bar only draws what this returns.

/** The name of a tab: its title, else a placeholder counted in the order of its space. */
export function itemTitle(space: Space, itemId: Id): string {
  const item = space.items[itemId];
  return item?.title ?? t("tree.tabDefault", { n: spaceItemIds(space).indexOf(itemId) + 1 });
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

/** One tile of the bar: a favorite tab, a shell profile or a project action. */
export type BarTile =
  | {
      kind: "tab";
      key: string;
      favorite: ResolvedFavorite;
    }
  | {
      kind: "profile";
      key: string;
      ref: Extract<FavoriteLinkRef, { kind: "profile" }>;
      /** The name the profile has now, else the one it had when it was added. */
      title: string;
      /** Why a click does nothing, when the profile is not on this computer any more. */
      unavailable?: string;
    }
  | {
      kind: "action";
      key: string;
      ref: Extract<FavoriteLinkRef, { kind: "action" }>;
      spaceName: string;
      spaceColor: string;
      /** The label the file gives the action now, else the one it had when it was added. */
      title: string;
      /** The action the file declares under the id, when it was read and has it. */
      action?: ProjectAction;
      /** The tab of the action has a session alive: a click shows the tab. */
      running: boolean;
      /** Why a click runs nothing, when the file no longer declares the action. */
      unavailable?: string;
    };

export interface BarSources {
  spaces: readonly Space[];
  /** The favorite tabs (`Workspace.favorites`). */
  favorites: readonly Id[];
  /** The profiles and actions (`Workspace.favoriteLinks`). */
  links: readonly FavoriteLink[];
  /** The shell profiles of this computer now (`useProfiles`). */
  profiles: readonly ShellProfile[];
  /** The latest reading of the actions file of each space with an action in the bar; a space not read yet is left out. */
  actionFiles: ReadonlyMap<Id, ActionsFileState>;
  isRunning(spaceId: Id, action: ProjectAction): boolean;
}

/**
 * What a reading of the actions file of a space says about an action in the bar: the action the file
 * declares under its id, or the reason it cannot run (`problem`). Neither when the file has not been
 * read yet. Only the id picks the action.
 */
export function resolveFavoriteAction(
  space: Space,
  link: Extract<FavoriteLink, { kind: "action" }>,
  file: ActionsFileState | undefined,
): { problem?: string; action?: ProjectAction } {
  if (space.defaults.cwd === undefined) {
    return { problem: t("favorites.actionNoFolder", { space: space.name }) };
  }
  if (file === undefined) return {};
  switch (file.status) {
    case "missing":
      return { problem: t("favorites.actionNoFile", { space: space.name }) };
    case "invalid":
      return { problem: t("favorites.actionInvalid", { space: space.name }) };
    case "unreadable":
      return { problem: t("favorites.actionUnreadable", { space: space.name }) };
    case "ok": {
      // Only the id picks the action: a file that no longer declares it leaves the tile unavailable,
      // and nothing else of the file is ever run in its place.
      const action = file.actions.find((candidate) => candidate.id === link.actionId);
      return action === undefined
        ? { problem: t("favorites.actionGone", { name: link.label, space: space.name }) }
        : { action };
    }
  }
}

/**
 * The tiles of the Favorites bar, in order: the favorite tabs as they were added, then the profiles
 * and project actions as they were added. A profile that is not on this computer and an action the
 * file of its space no longer declares stay in the bar, unavailable and with the reason, so a click
 * says what is wrong instead of doing something else.
 */
export function resolveBar(sources: BarSources): BarTile[] {
  const tabs = resolveFavorites(sources.spaces, sources.favorites).map((favorite): BarTile => ({
    kind: "tab",
    key: `tab:${favorite.id}`,
    favorite,
  }));
  const links = sources.links.flatMap((link): BarTile[] => {
    const ref = favoriteLinkRef(link);
    if (link.kind === "profile") {
      const profile = sources.profiles.find((candidate) => candidate.id === link.profileId);
      return [
        {
          kind: "profile",
          key: `profile:${link.profileId}`,
          ref: { kind: "profile", profileId: link.profileId },
          title: profile?.name ?? link.label,
          ...(profile === undefined
            ? { unavailable: t("favorites.profileGone", { name: link.label }) }
            : {}),
        },
      ];
    }
    const space = sources.spaces.find((candidate) => candidate.id === link.spaceId);
    if (space === undefined || ref.kind !== "action") return [];
    const { problem, action } = resolveFavoriteAction(
      space,
      link,
      sources.actionFiles.get(space.id),
    );
    return [
      {
        kind: "action",
        key: `action:${link.spaceId}:${link.actionId}`,
        ref,
        spaceName: space.name,
        spaceColor: space.color,
        title: action?.label ?? link.label,
        ...(action !== undefined ? { action } : {}),
        running: action !== undefined && sources.isRunning(space.id, action),
        ...(problem !== undefined ? { unavailable: problem } : {}),
      },
    ];
  });
  return [...tabs, ...links];
}

/**
 * The action a click on the tile of an action runs: the one the file of its space declares under its
 * id. A tile that has not seen the file yet (it was clicked before the first reading) reads it now
 * with `read`. `problem` says why there is no action to run; with neither, the space is gone and
 * there is nothing to do. Never another action: the id is the only way in.
 */
export async function actionToRun(
  tile: Extract<BarTile, { kind: "action" }>,
  space: Space | undefined,
  read: (cwd: string) => Promise<ActionsFileState>,
): Promise<{ action?: ProjectAction; problem?: string }> {
  if (tile.unavailable !== undefined) return { problem: tile.unavailable };
  if (tile.action !== undefined) return { action: tile.action };
  if (space === undefined) return {};
  const cwd = space.defaults.cwd;
  const file = cwd === undefined ? undefined : await read(cwd);
  const link = { ...tile.ref, label: tile.title };
  return resolveFavoriteAction(space, link, file);
}
