import { createDiffPane } from "@noren/model";
import type { Item, LayoutNode, Pane } from "@noren/model";
import { afterEach, describe, expect, it } from "vitest";
import { autoTitleAction } from "./auto-title";
import { setLanguage } from "./i18n";
import { paneEntries, paneStatusText, paneTitleText } from "./item-panes";
import { speakingPane, summarizeItem } from "./pane-info";

// A tab with a diff pane in it still speaks through its terminal, as with a browser pane or a preview
// pane: the diff has no shell of its own to name the tab after. A tab that is only a diff is named
// after its folder.

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

const diff = createDiffPane("d1", "/home/me/other-repo");

describe("the pane that speaks for a tab with a diff pane", () => {
  it("is the focused pane when it is a terminal", () => {
    expect(speakingPane(tabOf([terminal("t1"), diff], "t1"))?.id).toBe("t1");
  });

  it("is the first terminal when the diff pane has the keyboard", () => {
    expect(speakingPane(tabOf([diff, terminal("t1"), terminal("t2")], "d1"))?.id).toBe("t1");
  });

  it("is the diff pane itself when the tab has no terminal", () => {
    expect(speakingPane(tabOf([diff], "d1"))?.id).toBe("d1");
  });

  it("keeps the folder, branch and command of the terminal in the summary of the tab", () => {
    const summary = summarizeItem(tabOf([terminal("t1"), diff], "d1"), "/default");
    expect(summary.cwd).toBe("/home/me/proj");
    expect(summary.gitBranch).toBe("main");
    expect(summary.command).toMatchObject({ state: "running", text: "npm run dev" });
  });
});

describe("the title of a tab with a diff pane", () => {
  it("is the one the terminal asks for while the diff pane has the keyboard", () => {
    const tab = tabOf([terminal("t1"), diff], "d1");
    expect(autoTitleAction(tab)).toEqual({
      type: "item/rename",
      itemId: "i1",
      title: "proj · npm",
      source: "process",
    });
  });

  it("is the name of the folder when the tab is only a diff", () => {
    expect(autoTitleAction(tabOf([diff], "d1"))).toEqual({
      type: "item/rename",
      itemId: "i1",
      title: "other-repo",
      source: "process",
    });
    const named: Item = { ...tabOf([diff], "d1"), title: "other-repo" };
    expect(autoTitleAction(named)).toBeUndefined();
    const chosen: Item = { ...tabOf([diff], "d1"), title: "mine", titleLocked: true };
    expect(autoTitleAction(chosen)).toBeUndefined();
  });
});

describe("how the sidebar words a diff pane", () => {
  it("calls it a git diff, in both languages", () => {
    expect(paneStatusText(diff)).toBe("git diff");
    setLanguage("pt-BR");
    expect(paneStatusText(diff)).toBe("diff do git");
  });

  it("titles it by the folder it shows", () => {
    expect(paneTitleText(diff)).toBe("Changes in other-repo");
    setLanguage("pt-BR");
    expect(paneTitleText(diff)).toBe("Mudanças em other-repo");
  });

  it("lists it among the panes of a split tab, with its status and its title", () => {
    const [first, second] = paneEntries(tabOf([terminal("t1"), diff], "d1"), "/default");
    expect(first).toMatchObject({ paneId: "t1", status: "running", focused: false });
    expect(second).toMatchObject({
      paneId: "d1",
      title: "Changes in other-repo",
      status: "git diff",
      focused: true,
    });
  });
});
