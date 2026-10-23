import { createBrowserPane } from "@noren/model";
import type { Item, LayoutNode, Pane } from "@noren/model";
import { afterEach, describe, expect, it } from "vitest";
import { autoTitleAction } from "./auto-title";
import { setLanguage } from "./i18n";
import { paneEntries, paneStatusText, paneTitleText } from "./item-panes";
import { speakingPane, summarizeItem } from "./pane-info";

// A tab with a browser pane in it still speaks through its terminal: the page has no folder, no
// branch and no program to name the tab after.

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

const page = createBrowserPane("b1", "https://example.com/docs");

describe("the pane that speaks for a tab", () => {
  it("is the focused pane when it is a terminal", () => {
    const item = tabOf([terminal("t1"), page], "t1");
    expect(speakingPane(item)?.id).toBe("t1");
  });

  it("is the first terminal when the browser pane has the keyboard", () => {
    const item = tabOf([page, terminal("t1"), terminal("t2")], "b1");
    expect(speakingPane(item)?.id).toBe("t1");
  });

  it("is the browser pane itself when it is all the tab has", () => {
    const item = tabOf([page], "b1");
    expect(speakingPane(item)?.id).toBe("b1");
  });
});

describe("a tab with a browser pane", () => {
  it("shows the folder, branch and command of its terminal while the page has the keyboard", () => {
    const item = tabOf([terminal("t1"), page], "b1");
    const summary = summarizeItem(item, "/default");
    expect(summary.cwd).toBe("/home/me/proj");
    expect(summary.gitBranch).toBe("main");
    expect(summary.command).toMatchObject({ state: "running", text: "npm run dev" });
  });

  it("is named after its terminal while the page has the keyboard", () => {
    const item = tabOf([terminal("t1"), page], "b1");
    expect(autoTitleAction(item)).toEqual({
      type: "item/rename",
      itemId: "i1",
      title: "proj · npm",
      source: "process",
    });
  });

  it("lists the page by its host, and says it is a web page", () => {
    const item = tabOf([terminal("t1"), page], "t1");
    const [first, second] = paneEntries(item, "/default");
    expect(first).toMatchObject({ paneId: "t1", status: "running" });
    expect(second).toMatchObject({ paneId: "b1", title: "example.com", status: "web page" });
  });

  it("says it in Portuguese when the language says so", () => {
    setLanguage("pt-BR");
    expect(paneStatusText(page)).toBe("página web");
    expect(paneTitleText(createBrowserPane("b2", "http://localhost:3000/"))).toBe("localhost:3000");
  });
});
