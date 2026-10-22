import { describe, expect, it } from "vitest";
import {
  addFavoriteLink,
  favoriteLinkKey,
  favoriteLinkProblem,
  favoriteLinkRef,
  favoriteLinksOf,
  removeFavoriteLink,
  settleFavoriteLinks,
} from "./favorite-links";
import { richWorkspace } from "./state-fixtures";
import type { FavoriteLink, Workspace } from "./types";

// The profiles and project actions of the Favorites bar: what names a link, what is refused, and the
// changes to the list. The rich workspace has the spaces "s1" (Main) and "s2" (Work).

const PROFILE: FavoriteLink = { kind: "profile", profileId: "pwsh", label: "PowerShell" };
const BUILD: FavoriteLink = { kind: "action", spaceId: "s1", actionId: "build", label: "Build" };

const base = (): Workspace => richWorkspace();
const withLinks = (...links: FavoriteLink[]): Workspace => ({
  ...base(),
  favoriteLinks: links,
});

describe("favoriteLinksOf", () => {
  it("is empty for a workspace saved before the bar took profiles and actions", () => {
    expect(favoriteLinksOf(base())).toEqual([]);
  });

  it("is the list in the order it was added", () => {
    expect(favoriteLinksOf(withLinks(PROFILE, BUILD))).toEqual([PROFILE, BUILD]);
  });
});

describe("favoriteLinkKey", () => {
  it("tells a profile from an action of the same id", () => {
    const profile = favoriteLinkKey({ kind: "profile", profileId: "build" });
    const action = favoriteLinkKey({ kind: "action", spaceId: "s1", actionId: "build" });
    expect(profile).not.toBe(action);
  });

  it("tells the same action id of two spaces apart", () => {
    const first = favoriteLinkKey({ kind: "action", spaceId: "s1", actionId: "build" });
    const second = favoriteLinkKey({ kind: "action", spaceId: "s2", actionId: "build" });
    expect(first).not.toBe(second);
  });

  it("does not let a space id run into the action id", () => {
    const a = favoriteLinkKey({ kind: "action", spaceId: "s1x", actionId: "y" });
    const b = favoriteLinkKey({ kind: "action", spaceId: "s1", actionId: "xy" });
    expect(a).not.toBe(b);
  });

  it("leaves the name out", () => {
    const renamed: FavoriteLink = { ...PROFILE, label: "Another name" };
    expect(favoriteLinkKey(renamed)).toBe(favoriteLinkKey(PROFILE));
    expect(favoriteLinkRef(BUILD)).toEqual({ kind: "action", spaceId: "s1", actionId: "build" });
  });
});

describe("favoriteLinkProblem", () => {
  const spaces = base().spaces;

  it("takes a profile and an action of a space that exists", () => {
    expect(favoriteLinkProblem(PROFILE, spaces)).toBeUndefined();
    expect(favoriteLinkProblem(BUILD, spaces)).toBeUndefined();
  });

  it("refuses a link with no name", () => {
    expect(favoriteLinkProblem({ ...PROFILE, label: "" }, spaces)).toMatch(/no name/);
    expect(favoriteLinkProblem({ ...BUILD, label: "   " }, spaces)).toMatch(/no name/);
  });

  it("refuses a profile or an action with no id", () => {
    expect(favoriteLinkProblem({ ...PROFILE, profileId: " " }, spaces)).toMatch(/no profile/);
    expect(favoriteLinkProblem({ ...BUILD, actionId: "" }, spaces)).toMatch(/no action/);
  });

  it("refuses an action of a space the workspace does not have", () => {
    expect(favoriteLinkProblem({ ...BUILD, spaceId: "ghost" }, spaces)).toMatch(/ghost/);
  });

  it("refuses what is not a link", () => {
    expect(favoriteLinkProblem(null, spaces)).toMatch(/not a link/);
    expect(favoriteLinkProblem("pwsh", spaces)).toMatch(/not a link/);
    expect(favoriteLinkProblem({ kind: "tab", id: "i1", label: "x" }, spaces)).toMatch(/"tab"/);
    expect(favoriteLinkProblem({ label: "x" }, spaces)).toMatch(/kind/);
  });
});

describe("addFavoriteLink", () => {
  it("puts a link at the end of the list, after the ones already there", () => {
    const one = addFavoriteLink(base(), PROFILE);
    expect(one.favoriteLinks).toEqual([PROFILE]);
    const two = addFavoriteLink(one, BUILD);
    expect(two.favoriteLinks).toEqual([PROFILE, BUILD]);
  });

  it("does not touch the favorite tabs", () => {
    const next = addFavoriteLink(base(), PROFILE);
    expect(next.favorites).toEqual(base().favorites);
  });

  it("keeps a link once: the same workspace comes back for one that is already there", () => {
    const once = addFavoriteLink(base(), BUILD);
    expect(addFavoriteLink(once, BUILD)).toBe(once);
    // The name it is added under does not make it another link.
    expect(addFavoriteLink(once, { ...BUILD, label: "Build it" })).toBe(once);
    expect(once.favoriteLinks?.[0]?.label).toBe("Build");
  });

  it("keeps the same action id of two spaces, and a profile next to an action of the same id", () => {
    const links: FavoriteLink[] = [
      BUILD,
      { ...BUILD, spaceId: "s2" },
      { kind: "profile", profileId: "build", label: "Build" },
    ];
    let next = base();
    for (const link of links) next = addFavoriteLink(next, link);
    expect(next.favoriteLinks).toEqual(links);
  });

  it("trims the name", () => {
    expect(addFavoriteLink(base(), { ...PROFILE, label: "  PowerShell " }).favoriteLinks).toEqual([
      PROFILE,
    ]);
  });

  it("keeps only what names the link and its name", () => {
    const loose = { ...PROFILE, command: "rm -rf /", extra: 1 } as FavoriteLink;
    expect(addFavoriteLink(base(), loose).favoriteLinks).toEqual([PROFILE]);
  });

  it("refuses what the check refuses, and gives the same workspace back", () => {
    const ws = base();
    expect(addFavoriteLink(ws, { ...PROFILE, label: "" })).toBe(ws);
    expect(addFavoriteLink(ws, { ...BUILD, spaceId: "ghost" })).toBe(ws);
    expect(addFavoriteLink(ws, { ...BUILD, actionId: "" })).toBe(ws);
  });
});

describe("removeFavoriteLink", () => {
  it("takes a link out and keeps the others in their order", () => {
    const other: FavoriteLink = { kind: "profile", profileId: "wsl", label: "WSL" };
    const next = removeFavoriteLink(withLinks(PROFILE, BUILD, other), favoriteLinkRef(BUILD));
    expect(next.favoriteLinks).toEqual([PROFILE, other]);
  });

  it("leaves an empty list, not a missing one, when the last link goes", () => {
    expect(removeFavoriteLink(withLinks(PROFILE), favoriteLinkRef(PROFILE)).favoriteLinks).toEqual(
      [],
    );
  });

  it("gives the same workspace back for a link that is not in the list", () => {
    const ws = withLinks(PROFILE);
    expect(removeFavoriteLink(ws, favoriteLinkRef(BUILD))).toBe(ws);
    expect(removeFavoriteLink(base(), favoriteLinkRef(PROFILE))).toEqual(base());
  });

  it("does not take the action of another space with the same id", () => {
    const second: FavoriteLink = { ...BUILD, spaceId: "s2" };
    const next = removeFavoriteLink(withLinks(BUILD, second), favoriteLinkRef(BUILD));
    expect(next.favoriteLinks).toEqual([second]);
  });
});

describe("settleFavoriteLinks", () => {
  it("takes out the actions of a space that is gone and keeps the profiles", () => {
    const ws: Workspace = {
      ...withLinks(PROFILE, { ...BUILD, spaceId: "s2" }, BUILD),
      spaces: base().spaces.filter((space) => space.id !== "s2"),
    };
    expect(settleFavoriteLinks(ws).favoriteLinks).toEqual([PROFILE, BUILD]);
  });

  it("gives the same workspace back when every action still has its space", () => {
    const ws = withLinks(PROFILE, BUILD);
    expect(settleFavoriteLinks(ws)).toBe(ws);
    const bare = base();
    expect(settleFavoriteLinks(bare)).toBe(bare);
  });
});
