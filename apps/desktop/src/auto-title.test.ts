import type { Item, LayoutNode, Pane } from "@noren/model";
import { describe, expect, it } from "vitest";
import { autoTitleAction } from "./auto-title";

const pane = (id: string, extra: Partial<Pane> = {}): Pane => ({
  id,
  type: "terminal",
  profileId: "default",
  status: "idle",
  unread: false,
  bell: false,
  ...extra,
});

const leaf = (p: Pane): LayoutNode => ({ kind: "pane", pane: p });

const item = (extra: Partial<Item> = {}, panes: Pane[] = [pane("p1")]): Item => ({
  id: "i1",
  titleLocked: false,
  layout:
    panes.length === 1 && panes[0]
      ? leaf(panes[0])
      : { kind: "split", dir: "row", sizes: [50, 50], children: panes.map(leaf) },
  focusedPaneId: panes[0]?.id ?? "p1",
  lastActivityAt: 0,
  ...extra,
});

describe("autoTitleAction", () => {
  const rename = (title: string) => ({
    type: "item/rename",
    itemId: "i1",
    title,
    source: "process",
  });

  it("names the tab after its folder and, while a command runs, the program after it", () => {
    const tab = item({}, [pane("p1", { cwd: "/proj", runningCommand: { text: "sleep 5" } })]);
    expect(autoTitleAction(tab)).toEqual(rename("proj · sleep"));
  });

  it("names a tab with no folder yet after its running command alone", () => {
    const tab = item({}, [pane("p1", { runningCommand: { text: "sleep 5" } })]);
    expect(autoTitleAction(tab)).toEqual(rename("sleep"));
  });

  it("names the tab after the folder the shell started in, which the pane does not keep", () => {
    const tab = item({}, [pane("p1", { shellCwd: "/home/ada" })]);
    expect(autoTitleAction(tab, "/home/ada")).toEqual(rename("~"));
    expect(autoTitleAction(tab)).toEqual(rename("ada"));
  });

  it("names the tab after the folder when nothing runs", () => {
    const tab = item({}, [pane("p1", { cwd: "/home/ada/proj" })]);
    expect(autoTitleAction(tab, "/home/ada")).toEqual(rename("proj"));
    expect(autoTitleAction(item({}, [pane("p1", { cwd: "/home/ada" })]), "/home/ada")).toEqual(
      rename("~"),
    );
  });

  it("goes from the command back to the folder", () => {
    const tab = item({ title: "proj · sleep" }, [pane("p1", { cwd: "/proj" })]);
    expect(autoTitleAction(tab)).toEqual(rename("proj"));
  });

  it("changes nothing when the tab already has the title", () => {
    const tab = item({ title: "proj" }, [pane("p1", { cwd: "/proj" })]);
    expect(autoTitleAction(tab)).toBeUndefined();
    expect(autoTitleAction(item())).toBeUndefined();
  });

  it("a title the user locked never changes, whatever the pane does", () => {
    const locked = { title: "api", titleLocked: true };
    const running = item(locked, [pane("p1", { cwd: "/proj", runningCommand: { text: "ls" } })]);
    expect(autoTitleAction(running)).toBeUndefined();
    expect(autoTitleAction(item(locked, [pane("p1", { cwd: "/proj" })]))).toBeUndefined();
    expect(
      autoTitleAction(item({ titleLocked: true }, [pane("p1", { cwd: "/p" })])),
    ).toBeUndefined();
  });

  it("takes a title the shell gave away when the pane asks for nothing", () => {
    expect(autoTitleAction(item({ title: "proj" }))).toEqual(rename(""));
  });

  it("follows the focused pane of a split tab", () => {
    const panes = [pane("p1", { cwd: "/a" }), pane("p2", { cwd: "/b" })];
    expect(autoTitleAction(item({}, panes))).toEqual(rename("a"));
    expect(autoTitleAction(item({ focusedPaneId: "p2" }, panes))).toEqual(rename("b"));
  });
});
