import type { Item, LayoutNode, Pane, SplitNode } from "@noren/model";
import { describe, expect, it } from "vitest";
import {
  isSplitItem,
  layoutThumbnail,
  paneEntries,
  paneStatusText,
  paneTitleText,
} from "./item-panes";

function pane(id: string, extra: Partial<Pane> = {}): Pane {
  return {
    id,
    type: "terminal",
    profileId: "p",
    status: "idle",
    unread: false,
    bell: false,
    ...extra,
  };
}

const leaf = (id: string, extra: Partial<Pane> = {}): LayoutNode => ({
  kind: "pane",
  pane: pane(id, extra),
});

function split(dir: "row" | "column", sizes: number[], ...children: LayoutNode[]): SplitNode {
  return { kind: "split", dir, sizes, children };
}

function item(layout: LayoutNode, focusedPaneId: string): Item {
  return { id: "i", layout, focusedPaneId, titleLocked: false, lastActivityAt: 1 };
}

describe("layoutThumbnail", () => {
  it("gives a lone pane the whole box", () => {
    expect(layoutThumbnail(leaf("a"))).toEqual([{ paneId: "a", x: 0, y: 0, w: 100, h: 100 }]);
  });

  it("puts the children of a row side by side by their sizes", () => {
    expect(layoutThumbnail(split("row", [30, 70], leaf("a"), leaf("b")))).toEqual([
      { paneId: "a", x: 0, y: 0, w: 30, h: 100 },
      { paneId: "b", x: 30, y: 0, w: 70, h: 100 },
    ]);
  });

  it("stacks the children of a column", () => {
    expect(layoutThumbnail(split("column", [50, 50], leaf("a"), leaf("b")))).toEqual([
      { paneId: "a", x: 0, y: 0, w: 100, h: 50 },
      { paneId: "b", x: 0, y: 50, w: 100, h: 50 },
    ]);
  });

  it("nests a split inside the box of its panel", () => {
    const cells = layoutThumbnail(
      split("row", [50, 50], leaf("a"), split("column", [25, 75], leaf("b"), leaf("c"))),
    );
    expect(cells).toEqual([
      { paneId: "a", x: 0, y: 0, w: 50, h: 100 },
      { paneId: "b", x: 50, y: 0, w: 50, h: 25 },
      { paneId: "c", x: 50, y: 25, w: 50, h: 75 },
    ]);
  });

  it("reads sizes that do not fit the children as equal shares", () => {
    const cells = layoutThumbnail(split("row", [100], leaf("a"), leaf("b"), leaf("c")));
    expect(cells.map((cell) => cell.w)).toEqual([33.33, 33.33, 33.33]);
    expect(cells.map((cell) => cell.paneId)).toEqual(["a", "b", "c"]);
  });

  it("lists the panes in layout order", () => {
    const cells = layoutThumbnail(
      split("column", [50, 50], split("row", [50, 50], leaf("a"), leaf("b")), leaf("c")),
    );
    expect(cells.map((cell) => cell.paneId)).toEqual(["a", "b", "c"]);
  });
});

describe("paneStatusText", () => {
  it("words running, idle and exit codes", () => {
    expect(paneStatusText(pane("a", { status: "running" }))).toBe("running");
    expect(paneStatusText(pane("a", { status: "idle" }))).toBe("idle");
    // A command the shell reports is running even when the session state was not told.
    expect(paneStatusText(pane("a", { runningCommand: { text: "ls" } }))).toBe("running");
    expect(paneStatusText(pane("a", { status: "exited", exitCode: 0 }))).toBe("exit 0");
    expect(paneStatusText(pane("a", { status: "exited", exitCode: 2 }))).toBe("exit 2");
    expect(paneStatusText(pane("a", { status: "exited" }))).toBe("exit");
  });
});

describe("paneTitleText", () => {
  it("is the short folder of the pane, then of the space, then Terminal", () => {
    expect(paneTitleText(pane("a", { cwd: "/home/ada/proj" }), "/srv", "/home/ada")).toBe("~/proj");
    expect(paneTitleText(pane("a"), "/srv/app", "/home/ada")).toBe("/srv/app");
    expect(paneTitleText(pane("a"))).toBe("Terminal");
    expect(paneTitleText(pane("a", { cwd: "  " }))).toBe("Terminal");
  });
});

describe("paneEntries", () => {
  const two = item(
    split(
      "row",
      [50, 50],
      leaf("a", { cwd: "/srv/api", status: "running" }),
      leaf("b", { status: "exited", exitCode: 2 }),
    ),
    "b",
  );

  it("lists a split item's panes with title, status and the focused one", () => {
    expect(paneEntries(two)).toEqual([
      { paneId: "a", title: "/srv/api", status: "running", focused: false },
      { paneId: "b", title: "Terminal", status: "exit 2", focused: true },
    ]);
  });

  it("carries the command of each pane: running now, else the last one", () => {
    const withCommands = item(
      split(
        "row",
        [50, 50],
        leaf("a", { runningCommand: { text: "sleep 5" } }),
        leaf("b", { lastCommand: { text: "false", exitCode: 1, durationMs: 40 } }),
      ),
      "a",
    );
    const entries = paneEntries(withCommands);
    expect(entries[0]).toMatchObject({
      status: "running",
      command: { state: "running", text: "sleep 5" },
    });
    expect(entries[1]?.command).toEqual({
      state: "failed",
      text: "false",
      exitCode: 1,
      duration: "<1s",
    });
    expect(paneEntries(two)[0]).not.toHaveProperty("command");
  });

  it("is empty for an item with one pane", () => {
    const one = item(leaf("a"), "a");
    expect(paneEntries(one)).toEqual([]);
    expect(isSplitItem(one)).toBe(false);
    expect(isSplitItem(two)).toBe(true);
  });
});
