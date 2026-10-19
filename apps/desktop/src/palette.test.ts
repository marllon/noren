import { FakeBackend, createSequentialIds, restoreWorkspace } from "@noren/model";
import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS, resolveBindings } from "./keybindings";
import { buildEntries, parseQuery, searchEntries } from "./palette";
import type { ActionEntry, PaletteEntry, TabEntry } from "./palette";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

const clock = { now: () => 1000 };

/** Two spaces: "Main" with tabs api and build, "Other" with the tab docs (cwd /srv/docs). */
async function openStore() {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  const { dispatch } = store.getState();
  const main = activeSpaceOf(store.getState().workspace);
  store.getState().newTab();
  const [first, second] = spaceItemIds(activeSpaceOf(store.getState().workspace));
  dispatch({ type: "item/rename", itemId: first ?? "", title: "api" });
  dispatch({ type: "item/rename", itemId: second ?? "", title: "build" });
  store.getState().createSpace({ name: "Other", cwd: "/srv/docs" });
  const other = activeSpaceOf(store.getState().workspace);
  const [docs] = spaceItemIds(other);
  dispatch({ type: "item/rename", itemId: docs ?? "", title: "docs" });
  store.getState().activateSpace(main.id);
  return { store, main, other, docs: docs ?? "" };
}

const sources = async (preset: "safe" | "browser" = "safe") => {
  const { store, main, other, docs } = await openStore();
  const chords = resolveBindings({ ...DEFAULT_KEYBINDINGS, preset }).chords;
  return {
    entries: buildEntries({ workspace: store.getState().workspace, chords }),
    main,
    other,
    docs,
  };
};

const titles = (entries: readonly PaletteEntry[]) => entries.map((entry) => entry.title);
const tab = (entries: readonly PaletteEntry[], title: string) =>
  entries.find((entry): entry is TabEntry => entry.kind === "tab" && entry.title === title);
const action = (entries: readonly PaletteEntry[], title: string) =>
  entries.find((entry): entry is ActionEntry => entry.kind === "action" && entry.title === title);

describe("buildEntries", () => {
  it("lists the tabs of every space with the space and the folder, then the spaces, then the actions", async () => {
    const { entries, other, docs } = await sources();
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds).toEqual([...kinds].sort((a, b) => order(a) - order(b)));
    expect(titles(entries.filter((entry) => entry.kind === "tab"))).toEqual([
      "api",
      "build",
      "docs",
    ]);
    expect(tab(entries, "docs")).toMatchObject({
      itemId: docs,
      spaceId: other.id,
      spaceName: "Other",
      detail: "Other · /srv/docs",
      cwd: "/srv/docs",
    });
    // A tab with no folder shows the space alone.
    expect(tab(entries, "api")?.detail).toBe("Main");
    expect(titles(entries.filter((entry) => entry.kind === "space"))).toEqual(["Main", "Other"]);
    const other2 = entries.find((entry) => entry.kind === "space" && entry.title === "Other");
    expect(other2).toMatchObject({ detail: "1 tab · /srv/docs", active: false });
  });

  it("shows the folder of a tab under the home folder in its short form", async () => {
    const { store } = await openStore();
    const entries = buildEntries({
      workspace: store.getState().workspace,
      chords: {},
      home: "/srv",
    });
    expect(tab(entries, "docs")?.detail).toBe("Other · ~/docs");
  });

  it("lists the actions with the chord in force, as the user reads it", async () => {
    const { entries } = await sources();
    expect(action(entries, "Split right")?.chord).toBe("Ctrl+Shift+D");
    expect(action(entries, "Go to tab 1")?.chord).toBe("Alt+1");
    const browser = await sources("browser");
    expect(action(browser.entries, "Go to tab 1")?.chord).toBe("Ctrl+1");
    expect(action(browser.entries, "New tab")?.chord).toBe("Ctrl+T");
  });

  it("leaves the chord out of an action without a key, and Open palette out of the list", async () => {
    const { store } = await openStore();
    const chords = resolveBindings({ preset: "safe", overrides: { "pane.zoom": null } }).chords;
    const entries = buildEntries({ workspace: store.getState().workspace, chords });
    expect(action(entries, "Zoom pane")).not.toHaveProperty("chord");
    expect(action(entries, "Open palette")).toBeUndefined();
  });

  it("lists Import color scheme... as an action without a key, which the search finds", async () => {
    const { entries } = await sources();
    const importer = action(entries, "Import color scheme...");
    expect(importer).toMatchObject({
      detail: "General",
      action: { id: "themes.import-scheme", command: { kind: "import-scheme" } },
    });
    expect(importer).not.toHaveProperty("chord");
    const found = searchEntries(entries, ">import color");
    expect(found.map((entry) => entry.title)).toEqual(["Import color scheme..."]);
  });
});

const order = (kind: PaletteEntry["kind"]) => ["tab", "space", "action"].indexOf(kind);

describe("parseQuery", () => {
  it("reads the prefix and drops the blanks around it", () => {
    expect(parseQuery("")).toEqual({ scope: "all", term: "" });
    expect(parseQuery("  split")).toEqual({ scope: "all", term: "split" });
    expect(parseQuery(">split")).toEqual({ scope: "action", term: "split" });
    expect(parseQuery("> split right")).toEqual({ scope: "action", term: "split right" });
    expect(parseQuery(" @ api ")).toEqual({ scope: "tab", term: "api" });
    expect(parseQuery("#oth")).toEqual({ scope: "space", term: "oth" });
    expect(parseQuery("@")).toEqual({ scope: "tab", term: "" });
  });

  it("takes only a leading prefix: the same character inside the text is text", () => {
    expect(parseQuery("a>b")).toEqual({ scope: "all", term: "a>b" });
  });
});

describe("searchEntries", () => {
  it("lists everything when there is nothing to search for", async () => {
    const { entries } = await sources();
    expect(searchEntries(entries, "")).toEqual(entries);
    expect(searchEntries(entries, "   ")).toEqual(entries);
  });

  it("finds a tab of another space by part of its name", async () => {
    const { entries, docs } = await sources();
    const found = searchEntries(entries, "doc");
    expect(found[0]).toMatchObject({ kind: "tab", itemId: docs });
  });

  it("matches the space name and the folder of a tab", async () => {
    const { entries } = await sources();
    expect(titles(searchEntries(entries, "@other"))).toEqual(["docs"]);
    expect(titles(searchEntries(entries, "@srv/docs"))).toEqual(["docs"]);
  });

  it("reads several words, all of which must match", async () => {
    const { entries } = await sources();
    expect(titles(searchEntries(entries, "split right"))).toEqual(["Split right"]);
    expect(titles(searchEntries(entries, "right split"))).toEqual(["Split right"]);
    expect(searchEntries(entries, "split nonsense")).toEqual([]);
  });

  it("accepts letters spread out in the title, not in the folder", async () => {
    const { entries } = await sources();
    expect(titles(searchEntries(entries, ">spr"))).toContain("Split right");
    // "sdc" is spread out in /srv/docs but the folder only matches as a run.
    expect(searchEntries(entries, "@sdc")).toEqual([]);
  });

  it("limits the result to one kind with a prefix", async () => {
    const { entries } = await sources();
    const kindsOf = (query: string) => [
      ...new Set(searchEntries(entries, query).map((entry) => entry.kind)),
    ];
    expect(kindsOf(">")).toEqual(["action"]);
    expect(kindsOf("@")).toEqual(["tab"]);
    expect(kindsOf("#")).toEqual(["space"]);
    // Without a prefix "o" reaches tabs, spaces and actions alike.
    expect(kindsOf("o")).toEqual(["tab", "space", "action"]);
    expect(titles(searchEntries(entries, "#main"))).toEqual(["Main"]);
    expect(searchEntries(entries, ">api")).toEqual([]);
  });

  it("matches an action by its chord text, with or without the plus signs", async () => {
    const { entries } = await sources();
    expect(titles(searchEntries(entries, ">ctrl+shift+d"))).toEqual(["Split right"]);
    expect(titles(searchEntries(entries, ">ctrl shift d"))).toContain("Split right");
  });

  it("puts the match nearer the start of the title first", async () => {
    const { entries } = await sources();
    expect(titles(searchEntries(entries, ">split"))).toEqual(["Split right", "Split below"]);
    const right = titles(searchEntries(entries, ">right"));
    expect(right.slice(0, 3)).toEqual(["Split right", "Focus pane right", "Resize pane right"]);
  });
});
