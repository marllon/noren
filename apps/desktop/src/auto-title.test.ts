import type { Item, LayoutNode, Pane } from "@noren/model";
import { describe, expect, it } from "vitest";
import { autoTitleAction, commandName, folderTitle, paneAutoTitle } from "./auto-title";

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

describe("commandName", () => {
  it("is the program of the command line", () => {
    expect(commandName("npm run build")).toBe("npm");
    expect(commandName("  git   status ")).toBe("git");
    expect(commandName("sleep 5")).toBe("sleep");
  });

  it("drops the folder, the Windows extension and the quotes", () => {
    expect(commandName("/usr/bin/python3 app.py")).toBe("python3");
    expect(commandName("C:\\tools\\Node.EXE app.js")).toBe("Node");
    expect(commandName('"C:\\Program Files\\x\\tool.cmd" --flag')).toBe("tool");
    expect(commandName("./run.sh")).toBe("run.sh");
    expect(commandName("build.ps1")).toBe("build");
  });

  it("skips leading NAME=value words", () => {
    expect(commandName("CI=1 NODE_ENV=test npm test")).toBe("npm");
    expect(commandName("CI=1")).toBeUndefined();
  });

  it("is none for a blank or missing line", () => {
    expect(commandName(undefined)).toBeUndefined();
    expect(commandName("")).toBeUndefined();
    expect(commandName("   ")).toBeUndefined();
    expect(commandName('""')).toBeUndefined();
  });

  it("cuts a very long name", () => {
    const name = commandName("a".repeat(100));
    expect(name).toHaveLength(32);
    expect(name?.endsWith("\u2026")).toBe(true);
  });
});

describe("folderTitle", () => {
  it("is the last part of the folder", () => {
    expect(folderTitle("/home/ada/proj/noren")).toBe("noren");
    expect(folderTitle("/proj")).toBe("proj");
    expect(folderTitle("/srv/api/")).toBe("api");
    expect(folderTitle("C:\\Users\\ada\\dev\\site")).toBe("site");
    expect(folderTitle("C:/Users/ada/dev")).toBe("dev");
  });

  it("is ~ for the home folder, and the name of a folder inside it", () => {
    expect(folderTitle("/home/ada", "/home/ada")).toBe("~");
    expect(folderTitle("C:\\Users\\ada", "c:/users/ada")).toBe("~");
    expect(folderTitle("/home/ada/proj", "/home/ada")).toBe("proj");
  });

  it("keeps a root as it is", () => {
    expect(folderTitle("/")).toBe("/");
    expect(folderTitle("C:\\")).toBe("C:\\");
  });

  it("is none for a blank or missing folder", () => {
    expect(folderTitle(undefined)).toBeUndefined();
    expect(folderTitle("   ")).toBeUndefined();
  });
});

describe("paneAutoTitle", () => {
  it("is the running command, then the folder", () => {
    expect(paneAutoTitle(pane("p1", { cwd: "/proj", runningCommand: { text: "npm test" } }))).toBe(
      "npm",
    );
    expect(paneAutoTitle(pane("p1", { cwd: "/proj" }))).toBe("proj");
  });

  it("uses the folder while the running command has no line", () => {
    expect(paneAutoTitle(pane("p1", { cwd: "/proj", runningCommand: {} }))).toBe("proj");
  });

  it("is none for a pane with neither", () => {
    expect(paneAutoTitle(pane("p1"))).toBeUndefined();
    expect(paneAutoTitle(undefined)).toBeUndefined();
  });

  it("does not use the last command", () => {
    expect(paneAutoTitle(pane("p1", { lastCommand: { text: "ls" } }))).toBeUndefined();
  });
});

describe("autoTitleAction", () => {
  const rename = (title: string) => ({
    type: "item/rename",
    itemId: "i1",
    title,
    source: "process",
  });

  it("names the tab after its running command", () => {
    const tab = item({}, [pane("p1", { cwd: "/proj", runningCommand: { text: "sleep 5" } })]);
    expect(autoTitleAction(tab)).toEqual(rename("sleep"));
  });

  it("names the tab after the folder when nothing runs", () => {
    const tab = item({}, [pane("p1", { cwd: "/home/ada/proj" })]);
    expect(autoTitleAction(tab, "/home/ada")).toEqual(rename("proj"));
    expect(autoTitleAction(item({}, [pane("p1", { cwd: "/home/ada" })]), "/home/ada")).toEqual(
      rename("~"),
    );
  });

  it("goes from the command back to the folder", () => {
    const tab = item({ title: "sleep" }, [pane("p1", { cwd: "/proj" })]);
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
