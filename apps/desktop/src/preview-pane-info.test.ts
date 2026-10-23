import { createPreviewPane } from "@noren/model";
import type { Item, LayoutNode, Pane } from "@noren/model";
import { afterEach, describe, expect, it } from "vitest";
import { autoTitleAction } from "./auto-title";
import { setLanguage } from "./i18n";
import { paneEntries, paneStatusText, paneTitleText } from "./item-panes";
import { speakingPane, summarizeItem } from "./pane-info";

// A tab with a preview pane in it still speaks through its terminal, as with a browser pane: a file
// has no folder, branch or program to name the tab after. A tab that is only a preview is named
// after its file.

afterEach(() => setLanguage("en"));

const terminal = (id: string): Pane => ({
  id,
  type: "terminal",
  profileId: "default",
  cwd: "/home/me/proj",
  gitBranch: "main",
  runningCommand: { text: "npm run dev" },
  status: "running",
  unread: false,
  bell: false,
});

/** A tab holding the panes side by side, with the keyboard on `focused`. */
function tabOf(panes: Pane[], focused: string): Item {
  const layout: LayoutNode =
    panes.length === 1 && panes[0] !== undefined
      ? { kind: "pane", pane: panes[0] }
      : {
          kind: "split",
          dir: "row",
          sizes: panes.map(() => 100 / panes.length),
          children: panes.map((pane) => ({ kind: "pane" as const, pane })),
        };
  return { id: "i1", titleLocked: false, layout, focusedPaneId: focused, lastActivityAt: 0 };
}

const file = createPreviewPane("v1", "/home/me/proj/README.md");

describe("the pane that speaks for a tab with a preview pane", () => {
  it("is the focused pane when it is a terminal", () => {
    expect(speakingPane(tabOf([terminal("t1"), file], "t1"))?.id).toBe("t1");
  });

  it("is the first terminal when the preview pane has the keyboard", () => {
    expect(speakingPane(tabOf([file, terminal("t1"), terminal("t2")], "v1"))?.id).toBe("t1");
  });

  it("is the preview pane itself when it is all the tab has", () => {
    expect(speakingPane(tabOf([file], "v1"))?.id).toBe("v1");
  });
});

describe("a tab with a preview pane", () => {
  it("shows the folder, branch and command of its terminal while the file has the keyboard", () => {
    const summary = summarizeItem(tabOf([terminal("t1"), file], "v1"), "/default");
    expect(summary.cwd).toBe("/home/me/proj");
    expect(summary.gitBranch).toBe("main");
    expect(summary.command).toMatchObject({ state: "running", text: "npm run dev" });
  });

  it("is named after its terminal while the file has the keyboard", () => {
    expect(autoTitleAction(tabOf([terminal("t1"), file], "v1"))).toEqual({
      type: "item/rename",
      itemId: "i1",
      title: "proj · npm",
      source: "process",
    });
  });

  it("is named after the file when the file is all it has", () => {
    expect(autoTitleAction(tabOf([file], "v1"))).toEqual({
      type: "item/rename",
      itemId: "i1",
      title: "README.md",
      source: "process",
    });
    const named: Item = { ...tabOf([file], "v1"), title: "README.md" };
    expect(autoTitleAction(named)).toBeUndefined();
    const chosen: Item = { ...tabOf([file], "v1"), title: "mine", titleLocked: true };
    expect(autoTitleAction(chosen)).toBeUndefined();
  });

  it("lists the file by its name, and says it is a file preview", () => {
    const [first, second] = paneEntries(tabOf([terminal("t1"), file], "t1"), "/default");
    expect(first).toMatchObject({ paneId: "t1", status: "running" });
    expect(second).toMatchObject({ paneId: "v1", title: "README.md", status: "file preview" });
  });

  it("says it in Portuguese when the language says so", () => {
    setLanguage("pt-BR");
    expect(paneStatusText(file)).toBe("prévia de arquivo");
    expect(paneTitleText(createPreviewPane("v2", "C:\\Users\\me\\data.json"))).toBe("data.json");
  });
});
