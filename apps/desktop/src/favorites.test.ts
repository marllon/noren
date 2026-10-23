import { FakeBackend, createSequentialIds, layoutPanes, restoreWorkspace } from "@noren/model";
import type { ActionsFileState, FavoriteLink, Id, ProjectAction, Space } from "@noren/model";
import { describe, expect, it } from "vitest";
import { actionToRun, itemTitle, resolveBar, resolveFavorites, titleInitial } from "./favorites";
import type { BarSources } from "./favorites";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

const clock = { now: () => 1000 };

/** A store with "Main" (three tabs) and a second space "Other" (one tab); Main is active. */
async function openStore() {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  const main = activeSpaceOf(store.getState().workspace).id;
  store.getState().newTab();
  store.getState().newTab();
  store.getState().createSpace({ name: "Other" });
  const other = activeSpaceOf(store.getState().workspace).id;
  store.getState().activateSpace(main);
  const spaces = () => store.getState().workspace.spaces;
  const mainSpace = (): Space => activeSpaceOf(store.getState().workspace);
  const mainIds = spaceItemIds(mainSpace()) as [Id, Id, Id];
  const otherIds = spaceItemIds(spaces().find((space) => space.id === other) ?? mainSpace()) as [
    Id,
  ];
  return { store, spaces, mainSpace, main, other, mainIds, otherIds };
}

describe("resolveFavorites", () => {
  it("returns each favorite with its owner space, in the order it was added", async () => {
    const { spaces, main, other, mainIds, otherIds } = await openStore();
    const resolved = resolveFavorites(spaces(), [otherIds[0], mainIds[1]]);
    expect(resolved.map((favorite) => [favorite.id, favorite.spaceId])).toEqual([
      [otherIds[0], other],
      [mainIds[1], main],
    ]);
    expect(resolved[0]).toMatchObject({ spaceName: "Other" });
    expect(resolved[0]?.spaceColor).toBe(spaces().find((s) => s.id === other)?.color);
  });

  it("uses the title, or the placeholder counted in the order of the owner space", async () => {
    const { store, spaces, mainIds } = await openStore();
    store.getState().dispatch({ type: "item/rename", itemId: mainIds[0], title: "api" });
    const resolved = resolveFavorites(spaces(), [mainIds[0], mainIds[2]]);
    expect(resolved.map((favorite) => [favorite.title, favorite.initial])).toEqual([
      ["api", "A"],
      ["Tab 3", "T"],
    ]);
  });

  it("leaves out ids no space holds and repeated ids", async () => {
    const { spaces, mainIds } = await openStore();
    const resolved = resolveFavorites(spaces(), ["gone", mainIds[0], "also-gone", mainIds[0]]);
    expect(resolved.map((favorite) => favorite.id)).toEqual([mainIds[0]]);
    expect(resolveFavorites(spaces(), [])).toEqual([]);
  });

  it("follows a tab moved to another space and drops one that was closed", async () => {
    const { store, spaces, other, mainIds } = await openStore();
    const { dispatch } = store.getState();
    dispatch({ type: "item/favorite", itemId: mainIds[0] });
    dispatch({ type: "item/favorite", itemId: mainIds[1] });
    dispatch({ type: "item/move", itemId: mainIds[0], spaceId: other });
    dispatch({ type: "item/close", itemId: mainIds[1] });
    // The closed id is fed back in on purpose: a stale file may still list it.
    const resolved = resolveFavorites(spaces(), [
      ...store.getState().workspace.favorites,
      mainIds[1],
    ]);
    expect(resolved.map((favorite) => [favorite.id, favorite.spaceId])).toEqual([
      [mainIds[0], other],
    ]);
  });
});

/** The id of the first pane of a tab. */
function firstPaneOf(space: Space, itemId: Id | undefined): Id {
  const item = itemId === undefined ? undefined : space.items[itemId];
  return (item !== undefined ? layoutPanes(item.layout)[0]?.id : undefined) ?? "";
}

describe("itemTitle", () => {
  it("numbers an untitled tab from 1 in the order of its space", async () => {
    const { mainSpace, mainIds } = await openStore();
    expect(itemTitle(mainSpace(), mainIds[0])).toBe("Tab 1");
    expect(itemTitle(mainSpace(), mainIds[2])).toBe("Tab 3");
  });

  it("names a tab after the folder its shell reported, before it has a title", async () => {
    const { store, mainSpace, mainIds } = await openStore();
    const paneId = firstPaneOf(mainSpace(), mainIds[0]);
    store
      .getState()
      .dispatch({ type: "pane/set-shell-folder", itemId: mainIds[0], paneId, cwd: "/srv/api" });
    expect(itemTitle(mainSpace(), mainIds[0])).toBe("api");
    // The others still have nothing to say and keep their number.
    expect(itemTitle(mainSpace(), mainIds[1])).toBe("Tab 2");
  });

  it("the title the person typed wins over the folder and the command", async () => {
    const { store, mainSpace, mainIds } = await openStore();
    const paneId = firstPaneOf(mainSpace(), mainIds[0]);
    const { dispatch } = store.getState();
    dispatch({ type: "item/rename", itemId: mainIds[0], title: "mine" });
    dispatch({ type: "pane/set-shell-folder", itemId: mainIds[0], paneId, cwd: "/srv/api" });
    dispatch({ type: "pane/command-start", itemId: mainIds[0], paneId, text: "pnpm dev" });
    expect(itemTitle(mainSpace(), mainIds[0])).toBe("mine");
  });
});

describe("titleInitial", () => {
  it("takes the first letter or digit in upper case", () => {
    expect(titleInitial("deploy")).toBe("D");
    expect(titleInitial("  ~/dev/site")).toBe("D");
    expect(titleInitial("3d-print")).toBe("3");
    expect(titleInitial("épico")).toBe("É");
  });

  it("falls back to the first character, then to a question mark", () => {
    expect(titleInitial("---")).toBe("-");
    expect(titleInitial("   ")).toBe("?");
  });
});

// The bar with its three kinds of tile: what each one is made of, and what it says when its target
// is gone (an unavailable tile keeps its place and gives the reason; nothing else is ever run).

const DEV: ProjectAction = { id: "dev", label: "Dev server", command: "pnpm dev", tab: "dev" };
const TESTS: ProjectAction = {
  id: "tests",
  label: "Run tests",
  command: "pnpm test",
  tab: "tests",
};
const okFile = (...actions: ProjectAction[]): ActionsFileState => ({ status: "ok", actions });
const PWSH: FavoriteLink = { kind: "profile", profileId: "pwsh", label: "PowerShell" };

/** The sources of the bar for the store of `openStore`, with "Main" given a folder. */
async function barSources(overrides: Partial<BarSources> = {}) {
  const opened = await openStore();
  opened.store
    .getState()
    .dispatch({ type: "space/set-defaults", spaceId: opened.main, cwd: "/proj" });
  const sources = (extra: Partial<BarSources> = {}): BarSources => ({
    spaces: opened.spaces(),
    favorites: [],
    links: [],
    profiles: [{ id: "pwsh", name: "PowerShell", default: true }],
    actionFiles: new Map(),
    isRunning: () => false,
    ...overrides,
    ...extra,
  });
  const action = (id: string, label: string, spaceId: Id = opened.main): FavoriteLink => ({
    kind: "action",
    spaceId,
    actionId: id,
    label,
  });
  return { ...opened, sources, action };
}

describe("resolveBar", () => {
  it("is empty with nothing in the bar", async () => {
    const { sources } = await barSources();
    expect(resolveBar(sources())).toEqual([]);
  });

  it("puts the favorite tabs first, then the profiles and the actions in the order they came", async () => {
    const { sources, action, mainIds, main } = await barSources();
    const tiles = resolveBar(
      sources({
        favorites: [mainIds[1]],
        links: [action("dev", "Dev server"), PWSH],
        actionFiles: new Map([[main, okFile(DEV)]]),
      }),
    );
    expect(tiles.map((tile) => tile.kind)).toEqual(["tab", "action", "profile"]);
    expect(new Set(tiles.map((tile) => tile.key)).size).toBe(3);
  });

  it("shows a profile with the name it has now and no reason while the computer has it", async () => {
    const { sources } = await barSources({
      profiles: [{ id: "pwsh", name: "PowerShell 7", default: true }],
    });
    const [tile] = resolveBar(sources({ links: [PWSH] }));
    expect(tile).toMatchObject({
      kind: "profile",
      title: "PowerShell 7",
      ref: { profileId: "pwsh" },
    });
    expect(tile).not.toHaveProperty("unavailable");
  });

  it("keeps a profile the computer lost, with the name it had and the reason", async () => {
    const { sources } = await barSources({ profiles: [] });
    const [tile] = resolveBar(sources({ links: [PWSH] }));
    expect(tile).toMatchObject({
      kind: "profile",
      title: "PowerShell",
      unavailable: 'The profile "PowerShell" is not available any more.',
    });
  });

  it("gives an action the label the file has now, the action to run and its running state", async () => {
    const { sources, action, main } = await barSources();
    const links = [action("dev", "Old label")];
    const files = new Map([[main, okFile(DEV, TESTS)]]);
    const [idle] = resolveBar(sources({ links, actionFiles: files }));
    expect(idle).toMatchObject({
      kind: "action",
      title: "Dev server",
      action: DEV,
      running: false,
      spaceName: "Main",
    });
    expect(idle).not.toHaveProperty("unavailable");
    const [running] = resolveBar(
      sources({ links, actionFiles: files, isRunning: (_, candidate) => candidate.id === "dev" }),
    );
    expect(running).toMatchObject({ running: true });
  });

  it("makes an action the file no longer declares unavailable, with its old label and the reason, and no action to run", async () => {
    const { sources, action, main } = await barSources();
    const [tile] = resolveBar(
      sources({
        links: [action("dev", "Dev server")],
        // The file still has an action, but not the one in the bar: it must never be run instead.
        actionFiles: new Map([[main, okFile(TESTS)]]),
      }),
    );
    expect(tile).toMatchObject({
      kind: "action",
      title: "Dev server",
      running: false,
      unavailable: '"Dev server" is no longer in the .noren/actions.json of Main.',
    });
    expect(tile).not.toHaveProperty("action");
  });

  it("says why when the file is missing, not valid or cannot be read", async () => {
    const { sources, action, main } = await barSources();
    const reason = (file: ActionsFileState) => {
      const [tile] = resolveBar(
        sources({ links: [action("dev", "Dev server")], actionFiles: new Map([[main, file]]) }),
      );
      return tile?.kind === "action" ? tile.unavailable : undefined;
    };
    expect(reason({ status: "missing" })).toBe("There is no .noren/actions.json in Main.");
    expect(reason({ status: "invalid", reason: "x" })).toBe(
      "The .noren/actions.json of Main is not valid.",
    );
    expect(reason({ status: "unreadable", reason: "x" })).toBe(
      "The .noren/actions.json of Main cannot be read.",
    );
  });

  it("makes an action unavailable when its space has no folder to read the file in", async () => {
    const { sources, action, other, main } = await barSources();
    const [tile] = resolveBar(
      sources({
        links: [action("dev", "Dev server", other)],
        // Even a reading that has it does not count: the space has no folder.
        actionFiles: new Map([[other, okFile(DEV)]]),
      }),
    );
    expect(tile).toMatchObject({
      kind: "action",
      unavailable: "Other has no folder, so its actions cannot be read.",
    });
    expect(main).not.toBe(other);
  });

  it("leaves an action available while its file has not been read yet", async () => {
    const { sources, action } = await barSources();
    const [tile] = resolveBar(sources({ links: [action("dev", "Dev server")] }));
    expect(tile).toMatchObject({ kind: "action", title: "Dev server", running: false });
    expect(tile).not.toHaveProperty("unavailable");
    expect(tile).not.toHaveProperty("action");
  });

  it("leaves out the action of a space that is not in the workspace", async () => {
    const { sources, action } = await barSources();
    expect(resolveBar(sources({ links: [action("dev", "Dev server", "gone")] }))).toEqual([]);
  });
});

describe("actionToRun", () => {
  const tileOf = async (
    sources: (extra?: Partial<BarSources>) => BarSources,
    link: FavoriteLink,
    extra: Partial<BarSources> = {},
  ) => {
    const [tile] = resolveBar(sources({ links: [link], ...extra }));
    if (tile?.kind !== "action") throw new Error("expected the tile of an action");
    return tile;
  };

  it("hands back the action the tile has seen, without reading the file again", async () => {
    const { sources, action, main, spaces } = await barSources();
    const tile = await tileOf(sources, action("dev", "Dev server"), {
      actionFiles: new Map([[main, okFile(DEV)]]),
    });
    let reads = 0;
    const found = await actionToRun(tile, spaces()[0], async () => {
      reads++;
      return okFile();
    });
    expect(found).toEqual({ action: DEV });
    expect(reads).toBe(0);
  });

  it("reads the file of the space when the tile was clicked before the first reading", async () => {
    const { sources, action, main, spaces } = await barSources();
    const tile = await tileOf(sources, action("dev", "Dev server"));
    expect(tile).not.toHaveProperty("action");
    const asked: string[] = [];
    const space = spaces().find((candidate) => candidate.id === main);
    const found = await actionToRun(tile, space, async (cwd) => {
      asked.push(cwd);
      return okFile(TESTS, DEV);
    });
    expect(asked).toEqual(["/proj"]);
    expect(found).toEqual({ action: DEV });
  });

  it("runs nothing, and says why, when the file read now no longer has the action", async () => {
    const { sources, action, main, spaces } = await barSources();
    const tile = await tileOf(sources, action("dev", "Dev server"));
    const space = spaces().find((candidate) => candidate.id === main);
    // Another action is there; it is never run in place of the one in the bar.
    const found = await actionToRun(tile, space, async () => okFile(TESTS));
    expect(found).toEqual({
      problem: '"Dev server" is no longer in the .noren/actions.json of Main.',
    });
    expect(found).not.toHaveProperty("action");
    const missing = await actionToRun(tile, space, async () => ({ status: "missing" }));
    expect(missing).toEqual({ problem: "There is no .noren/actions.json in Main." });
  });

  it("gives the reason an unavailable tile already carries, and does not read", async () => {
    const { sources, action, main, spaces } = await barSources();
    const tile = await tileOf(sources, action("dev", "Dev server"), {
      actionFiles: new Map([[main, okFile(TESTS)]]),
    });
    let reads = 0;
    const found = await actionToRun(tile, spaces()[0], async () => {
      reads++;
      return okFile(DEV);
    });
    expect(found.problem).toMatch(/no longer in/);
    expect(found).not.toHaveProperty("action");
    expect(reads).toBe(0);
  });

  it("does nothing for a space that is gone", async () => {
    const { sources, action } = await barSources();
    const tile = await tileOf(sources, action("dev", "Dev server"));
    expect(await actionToRun(tile, undefined, async () => okFile(DEV))).toEqual({});
  });

  it("names no folder to read for a space that has none, and reads nothing", async () => {
    const { sources, action, other, spaces } = await barSources();
    const noFolder = spaces().find((candidate) => candidate.id === other);
    let reads = 0;
    const read = async () => {
      reads++;
      return okFile(DEV);
    };
    // The tile of that space already says so; and a tile that has not seen the file, handed a space
    // whose folder went away since, says it as well.
    const own = await tileOf(sources, action("dev", "Dev server", other));
    expect(await actionToRun(own, noFolder, read)).toEqual({
      problem: "Other has no folder, so its actions cannot be read.",
    });
    const pending = await tileOf(sources, action("dev", "Dev server"));
    expect(await actionToRun(pending, noFolder, read)).toEqual({
      problem: "Other has no folder, so its actions cannot be read.",
    });
    expect(reads).toBe(0);
  });
});
