import { FakeBackend, createSequentialIds, layoutPanes, restoreWorkspace } from "@noren/model";
import { describe, expect, it } from "vitest";
import { collectSearchTabs, searchTabs } from "./tab-search";
import type { SearchTab } from "./tab-search";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

const clock = { now: () => 1000 };

function tab(id: string, lines: string[], extra: Partial<SearchTab> = {}): SearchTab {
  return {
    itemId: id,
    spaceId: "s1",
    title: `Tab ${id}`,
    space: "Main",
    spaceColor: "#fff",
    panes: [{ paneId: `${id}-pane`, lines }],
    ...extra,
  };
}

describe("searchTabs", () => {
  it("lists the lines that hold the text, with the row, the line and where the match starts", () => {
    const { tabs, truncated } = searchTabs(
      [tab("a", ["first", "an error here", "", "another ERROR"])],
      "error",
    );
    expect(truncated).toBe(false);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.hits).toEqual([
      { paneId: "a-pane", row: 1, text: "an error here", column: 3, length: 5 },
      { paneId: "a-pane", row: 3, text: "another ERROR", column: 8, length: 5 },
    ]);
  });

  it("matches without regard to case, in either direction", () => {
    const tabs = [tab("a", ["Build FAILED", "all good"])];
    expect(searchTabs(tabs, "failed").tabs[0]?.hits.map((h) => h.row)).toEqual([0]);
    expect(searchTabs(tabs, "BUILD").tabs[0]?.hits.map((h) => h.row)).toEqual([0]);
  });

  it("takes the text literally: no pattern characters, spaces inside count", () => {
    const tabs = [tab("a", ["a.c", "abc", "x  y", "x y", "[1]"])];
    expect(searchTabs(tabs, "a.c").tabs[0]?.hits.map((h) => h.row)).toEqual([0]);
    expect(searchTabs(tabs, "x y").tabs[0]?.hits.map((h) => h.row)).toEqual([3]);
    expect(searchTabs(tabs, "[1]").tabs[0]?.hits.map((h) => h.row)).toEqual([4]);
  });

  it("lists nothing for an empty or blank query", () => {
    const tabs = [tab("a", ["x", " ", ""])];
    expect(searchTabs(tabs, "")).toEqual({ tabs: [], truncated: false });
    expect(searchTabs(tabs, "   ")).toEqual({ tabs: [], truncated: false });
  });

  it("ignores spaces around the query", () => {
    const tabs = [tab("a", ["needle in a haystack"])];
    expect(searchTabs(tabs, "  needle ").tabs[0]?.hits).toHaveLength(1);
  });

  it("leaves out a tab with no match and keeps the order of the tabs", () => {
    const tabs = [
      tab("a", ["zzz foo"]),
      tab("b", ["nothing"]),
      tab("c", ["foo"]),
      tab("d", ["Foo bar"]),
    ];
    expect(searchTabs(tabs, "foo").tabs.map((t) => t.itemId)).toEqual(["a", "c", "d"]);
  });

  it("carries the tab's title, space and color on the result", () => {
    const only = tab("a", ["hit"], { title: "build", space: "Work", spaceColor: "#123456" });
    const [first] = searchTabs([only], "hit").tabs;
    expect(first).toMatchObject({
      itemId: "a",
      spaceId: "s1",
      title: "build",
      space: "Work",
      spaceColor: "#123456",
      truncated: false,
    });
  });

  it("searches every pane of a tab, in layout order, and says which pane a line is in", () => {
    const split = tab("a", [], {
      panes: [
        { paneId: "p1", lines: ["no", "key one"] },
        { paneId: "p2", lines: ["key two"] },
      ],
    });
    const hits = searchTabs([split], "key").tabs[0]?.hits;
    expect(hits?.map((h) => [h.paneId, h.row])).toEqual([
      ["p1", 1],
      ["p2", 0],
    ]);
  });

  it("caps the lines of one tab and marks it", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `hit ${i}`);
    const { tabs, truncated } = searchTabs([tab("a", lines), tab("b", ["hit"])], "hit");
    expect(tabs[0]?.hits).toHaveLength(50);
    expect(tabs[0]?.truncated).toBe(true);
    // The cap is per tab: the next tab still lists its line.
    expect(tabs[1]?.hits).toHaveLength(1);
    expect(tabs[1]?.truncated).toBe(false);
    expect(truncated).toBe(true);
    // The lines kept are the first ones, top down.
    expect(tabs[0]?.hits[0]?.row).toBe(0);
    expect(tabs[0]?.hits[49]?.row).toBe(49);
  });

  it("caps the lines in all and says so, even when a whole tab is cut", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `hit ${i}`);
    const many = ["a", "b", "c", "d"].map((id) => tab(id, lines));
    const { tabs, truncated } = searchTabs(many, "hit", { perTab: 50, total: 100 });
    expect(tabs.map((t) => t.hits.length)).toEqual([40, 40, 20]);
    expect(tabs.map((t) => t.truncated)).toEqual([false, false, true]);
    expect(truncated).toBe(true);
  });

  it("does not flag a search that exactly fills the cap", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `hit ${i}`);
    const { tabs, truncated } = searchTabs([tab("a", lines)], "hit", { perTab: 5, total: 5 });
    expect(tabs[0]?.hits).toHaveLength(5);
    expect(tabs[0]?.truncated).toBe(false);
    expect(truncated).toBe(false);
  });

  it("uses 50 lines per tab and 500 in all by default", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `hit ${i}`);
    const many = Array.from({ length: 12 }, (_, i) => tab(`t${i}`, lines));
    const { tabs } = searchTabs(many, "hit");
    expect(tabs[0]?.hits).toHaveLength(50);
    expect(tabs.reduce((sum, t) => sum + t.hits.length, 0)).toBe(500);
  });

  it("gives no offset when folding the case moved it", () => {
    // "İ" (dotted capital I) becomes two characters in lower case.
    const [first] = searchTabs([tab("a", ["İx needle"])], "needle").tabs;
    expect(first?.hits[0]).toMatchObject({ row: 0, column: -1 });
  });

  it("does not change what it is given", () => {
    const lines = ["a hit"];
    const tabs = [tab("a", lines)];
    searchTabs(tabs, "hit");
    expect(lines).toEqual(["a hit"]);
    expect(tabs[0]?.panes[0]?.lines).toBe(lines);
  });
});

describe("collectSearchTabs", () => {
  it("lists every tab of every space in the order of the sidebar, with the text of each pane", async () => {
    const backend = new FakeBackend();
    const newId = createSequentialIds("n");
    const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
    const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
    store.getState().newTab();
    const main = activeSpaceOf(store.getState().workspace);
    const [a, b] = spaceItemIds(main) as [string, string];
    store.getState().dispatch({ type: "item/rename", itemId: a, title: "alpha" });
    store.getState().createSpace({ name: "Other" });
    const other = activeSpaceOf(store.getState().workspace);
    const c = spaceItemIds(other)[0] as string;

    const workspace = store.getState().workspace;
    const paneOf = (itemId: string, spaceIndex: number): string => {
      const item = workspace.spaces[spaceIndex]?.items[itemId];
      return (item === undefined ? [] : layoutPanes(item.layout))[0]?.id ?? "";
    };
    const text = new Map([
      [paneOf(a, 0), ["a line"]],
      [paneOf(c, 1), ["c line"]],
    ]);
    const tabs = collectSearchTabs(workspace, (paneId) => text.get(paneId));

    expect(tabs.map((t) => t.itemId)).toEqual([a, b, c]);
    expect(tabs[0]).toMatchObject({ title: "alpha", space: "Main", spaceId: main.id });
    expect(tabs[2]).toMatchObject({ space: "Other", spaceId: other.id });
    expect(tabs[0]?.panes[0]?.lines).toEqual(["a line"]);
    // A pane whose terminal is not mounted has no text, and the tab is still listed.
    expect(tabs[1]?.panes[0]?.lines).toEqual([]);
    expect(tabs[2]?.panes[0]?.lines).toEqual(["c line"]);
  });
});
