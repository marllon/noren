import { describe, expect, it } from "vitest";
import {
  TITLE_SEPARATOR,
  autoTabTitle,
  commandName,
  folderName,
  paneFolder,
  paneTitle,
  tabLabel,
  wslFolder,
} from "./tab-label";
import type { Item, LayoutNode, Pane } from "./types";

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

const placeholder = (n: number): string => `Tab ${n}`;
const label = (tab: Item, index = 0, home?: string): string =>
  tabLabel(tab, { index, placeholder, home });

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

describe("folderName", () => {
  it("is the last part of a POSIX folder", () => {
    expect(folderName("/home/ada/proj/noren")).toBe("noren");
    expect(folderName("/proj")).toBe("proj");
    expect(folderName("/srv/api/")).toBe("api");
    expect(folderName("/srv/api///")).toBe("api");
  });

  it("is the last part of a Windows folder, with either slash and with a trailing one", () => {
    expect(folderName("C:\\Users\\ada\\dev\\site")).toBe("site");
    expect(folderName("C:\\Users\\x\\proj")).toBe("proj");
    expect(folderName("C:\\Users\\x\\proj\\")).toBe("proj");
    expect(folderName("C:/Users/ada/dev")).toBe("dev");
    expect(folderName("c:\\")).toBe("c:\\");
  });

  it("reads a network path and a WSL path by their last part", () => {
    expect(folderName("\\\\server\\share\\dir")).toBe("dir");
    expect(folderName("\\\\wsl$\\Ubuntu\\home\\ada")).toBe("ada");
  });

  it("names a folder in a WSL distro as the distro does, the root included", () => {
    // The form a bash in WSL reports (OSC 7), in the share Windows reaches the distro by.
    expect(folderName("//wsl.localhost/Ubuntu/home/ada/proj")).toBe("proj");
    expect(folderName("\\\\wsl.localhost\\Ubuntu\\home\\ada\\proj\\")).toBe("proj");
    expect(folderName("//wsl.localhost/Ubuntu 22.04/srv/api/")).toBe("api");
    // The root of the distro is `/`, not the name of the share (the distro).
    expect(folderName("//wsl.localhost/Ubuntu")).toBe("/");
    expect(folderName("//wsl.localhost/Ubuntu/")).toBe("/");
    expect(folderName("\\\\wsl$\\Ubuntu")).toBe("/");
    // A distro that happens to be called `home`, or a folder called like the share.
    expect(folderName("//wsl.localhost/home")).toBe("/");
    expect(folderName("//wsl.localhost/Ubuntu/wsl.localhost")).toBe("wsl.localhost");
    // The home folder of Windows is not a folder of the distro.
    expect(folderName("//wsl.localhost/Ubuntu/Users/ada", "C:\\Users\\ada")).toBe("ada");
    // A folder on a drive seen from inside the distro is a Windows folder, as before.
    expect(folderName("D:/Projetos/noren")).toBe("noren");
  });

  it("is ~ for the home folder, and the name of a folder inside it", () => {
    expect(folderName("/home/ada", "/home/ada")).toBe("~");
    expect(folderName("/home/ada/", "/home/ada")).toBe("~");
    expect(folderName("C:\\Users\\ada", "c:/users/ada")).toBe("~");
    expect(folderName("/home/ada/proj", "/home/ada")).toBe("proj");
    expect(folderName("~")).toBe("~");
  });

  it("keeps a root as it is, whichever the drive", () => {
    expect(folderName("/")).toBe("/");
    expect(folderName("C:\\")).toBe("C:\\");
    expect(folderName("D:/")).toBe("D:/");
  });

  it("is none for a blank or missing folder", () => {
    expect(folderName(undefined)).toBeUndefined();
    expect(folderName("   ")).toBeUndefined();
    expect(folderName("")).toBeUndefined();
  });
});

describe("wslFolder", () => {
  it("gives the distro and the Linux path of a folder in a distro, in either share and either slash", () => {
    expect(wslFolder("//wsl.localhost/Ubuntu/home/ada/proj")).toEqual({
      distro: "Ubuntu",
      linux: "/home/ada/proj",
    });
    expect(wslFolder("\\\\wsl.localhost\\Debian\\srv\\api")).toEqual({
      distro: "Debian",
      linux: "/srv/api",
    });
    expect(wslFolder("\\\\wsl$\\Ubuntu\\home\\ada")).toEqual({
      distro: "Ubuntu",
      linux: "/home/ada",
    });
    expect(wslFolder("//WSL.LOCALHOST/Ubuntu/Home")).toEqual({ distro: "Ubuntu", linux: "/Home" });
  });

  it("keeps a distro name with a space and drops repeated and trailing slashes", () => {
    expect(wslFolder("//wsl.localhost/Ubuntu 22.04/home//ada///")).toEqual({
      distro: "Ubuntu 22.04",
      linux: "/home/ada",
    });
  });

  it("gives / for the root of the distro, with or without the last slash", () => {
    expect(wslFolder("//wsl.localhost/Ubuntu")).toEqual({ distro: "Ubuntu", linux: "/" });
    expect(wslFolder("//wsl.localhost/Ubuntu/")).toEqual({ distro: "Ubuntu", linux: "/" });
  });

  it("is none for anything that is not a folder in a distro", () => {
    for (const path of [
      "C:/Users/ada",
      "D:\\Projetos\\noren",
      "/home/ada",
      "//server/share/dir",
      "//wsl.localhost",
      "//wsl.localhost/",
      "wsl.localhost/Ubuntu/home",
      "/wsl.localhost/Ubuntu/home",
      "",
    ]) {
      expect(wslFolder(path), path).toBeUndefined();
    }
  });
});

describe("paneFolder", () => {
  it("is the folder the shell reported, else the one the pane has", () => {
    expect(paneFolder(pane("p1", { cwd: "/a", shellCwd: "/b" }))).toBe("/b");
    expect(paneFolder(pane("p1", { cwd: "/a" }))).toBe("/a");
    expect(paneFolder(pane("p1", { shellCwd: "/home/ada" }))).toBe("/home/ada");
    expect(paneFolder(pane("p1"))).toBeUndefined();
  });
});

describe("paneTitle", () => {
  it("is the folder, and the program after it while a command runs", () => {
    const folder = pane("p1", { cwd: "/srv/api" });
    expect(paneTitle(folder)).toBe("api");
    expect(paneTitle({ ...folder, runningCommand: { text: "npm test" } })).toBe(
      `api${TITLE_SEPARATOR}npm`,
    );
    expect(paneTitle({ ...folder, runningCommand: { text: "npm test" } })).toBe("api · npm");
  });

  it("names a tab after the folder the shell started in, which the pane does not keep", () => {
    expect(paneTitle(pane("p1", { shellCwd: "/home/ada" }), "/home/ada")).toBe("~");
    expect(paneTitle(pane("p1", { shellCwd: "C:\\Users\\ada" }), "C:\\Users\\ada")).toBe("~");
    expect(paneTitle(pane("p1", { shellCwd: "/home/ada" }))).toBe("ada");
  });

  it("follows the shell when it leaves the folder it was recorded in", () => {
    expect(paneTitle(pane("p1", { cwd: "/a", shellCwd: "/b" }))).toBe("b");
  });

  it("names a tab in a WSL distro after its folder and the program that runs there", () => {
    const folder = pane("p1", {
      profileId: "wsl-Ubuntu",
      cwd: "//wsl.localhost/Ubuntu/home/ada/proj",
    });
    expect(paneTitle(folder)).toBe("proj");
    expect(paneTitle({ ...folder, runningCommand: { text: "claude --continue" } })).toBe(
      "proj · claude",
    );
    // The folder the shell started in, which the pane does not keep, names the tab as well.
    expect(
      paneTitle(pane("p2", { shellCwd: "//wsl.localhost/Ubuntu/home/ada/work" }), "C:\\Users\\ada"),
    ).toBe("work");
  });

  it("is the program alone while no folder is known", () => {
    expect(paneTitle(pane("p1", { runningCommand: { text: "sleep 5" } }))).toBe("sleep");
  });

  it("uses the folder alone while the running command has no line", () => {
    expect(paneTitle(pane("p1", { cwd: "/proj", runningCommand: {} }))).toBe("proj");
  });

  it("is none for a pane with neither a folder nor a command", () => {
    expect(paneTitle(pane("p1"))).toBeUndefined();
    expect(paneTitle(undefined)).toBeUndefined();
    expect(paneTitle(pane("p1", { runningCommand: {} }))).toBeUndefined();
  });

  it("does not use the last command", () => {
    expect(paneTitle(pane("p1", { lastCommand: { text: "ls" } }))).toBeUndefined();
    expect(paneTitle(pane("p1", { cwd: "/proj", lastCommand: { text: "ls" } }))).toBe("proj");
  });

  it("names a preview pane after its file", () => {
    expect(paneTitle(pane("p1", { type: "preview", path: "/docs/readme.md" }))).toBe("readme.md");
  });
});

describe("autoTabTitle", () => {
  it("follows the focused pane of a split tab", () => {
    const panes = [pane("p1", { cwd: "/a" }), pane("p2", { cwd: "/b" })];
    expect(autoTabTitle(item({}, panes))).toBe("a");
    expect(autoTabTitle(item({ focusedPaneId: "p2" }, panes))).toBe("b");
  });

  it("is spoken for by the first terminal when the focused pane is not one", () => {
    const panes = [
      pane("p1", { type: "browser", url: "https://example.com" }),
      pane("p2", { cwd: "/srv/api" }),
    ];
    expect(autoTabTitle(item({}, panes))).toBe("api");
  });
});

describe("tabLabel", () => {
  it("is the folder of a tab with no title, as soon as it is known", () => {
    expect(label(item({}, [pane("p1", { shellCwd: "/srv/api" })]))).toBe("api");
    expect(label(item({}, [pane("p1", { cwd: "/srv/web" })]))).toBe("web");
  });

  it("adds the program while a command runs", () => {
    const tab = item({}, [
      pane("p1", { shellCwd: "/srv/api", runningCommand: { text: "pnpm dev" } }),
    ]);
    expect(label(tab)).toBe("api · pnpm");
  });

  it("is the home folder as ~ when the home is known", () => {
    const tab = item({}, [pane("p1", { shellCwd: "C:\\Users\\ada" })]);
    expect(label(tab, 0, "C:\\Users\\ada")).toBe("~");
    expect(label(tab)).toBe("ada");
  });

  it("is the placeholder, counted from 1, while the folder is still unknown", () => {
    expect(label(item(), 0)).toBe("Tab 1");
    expect(label(item(), 2)).toBe("Tab 3");
    expect(label(item({}, [pane("p1", { runningCommand: {} })]), 1)).toBe("Tab 2");
  });

  it("is the program alone while the folder is unknown", () => {
    expect(label(item({}, [pane("p1", { runningCommand: { text: "sleep 2" } })]))).toBe("sleep");
  });

  it("keeps the title the shell last asked for", () => {
    expect(label(item({ title: "api" }, [pane("p1", { cwd: "/srv/api" })]))).toBe("api");
  });

  it("the title the person gave wins over the folder and the command, whatever they are", () => {
    const panes = [pane("p1", { shellCwd: "/srv/api", runningCommand: { text: "pnpm dev" } })];
    expect(label(item({ title: "mine", titleLocked: true }, panes))).toBe("mine");
    expect(label(item({ title: "mine", titleLocked: true }, [pane("p1")]), 4)).toBe("mine");
  });

  it("is never empty: a blank title falls through", () => {
    expect(label(item({ title: "  " }, [pane("p1", { cwd: "/srv/api" })]))).toBe("api");
    expect(label(item({ title: "" }), 0)).toBe("Tab 1");
  });
});
