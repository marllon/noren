import { treeGroups } from "@noren/model";
import type {
  AgentState,
  GroupNode,
  Item,
  LayoutNode,
  Pane,
  SessionLink,
  Space,
} from "@noren/model";
import { describe, expect, it } from "vitest";
import {
  agentStateLabel,
  commandInfo,
  commandWords,
  failureLabel,
  formatDuration,
  groupMarks,
  indicatorLabels,
  linkShort,
  linkText,
  marksWords,
  shortCwd,
  spaceMarks,
  summarizeItem,
} from "./pane-info";
import { setLanguage } from "./i18n";

describe("shortCwd", () => {
  it("turns the home folder into ~ and keeps what follows it", () => {
    expect(shortCwd("/home/ada", "/home/ada")).toBe("~");
    expect(shortCwd("/home/ada/", "/home/ada")).toBe("~");
    expect(shortCwd("/home/ada/proj", "/home/ada")).toBe("~/proj");
    expect(shortCwd("/home/ada/proj/noren", "/home/ada")).toBe("~/proj/noren");
  });

  it("keeps the last two segments behind an ellipsis when the path is longer", () => {
    expect(shortCwd("/home/ada/work/proj/noren", "/home/ada")).toBe("\u2026/proj/noren");
    expect(shortCwd("/usr/local/share/doc")).toBe("\u2026/share/doc");
    expect(shortCwd("/a/b/c", undefined, 3)).toBe("/a/b/c");
    expect(shortCwd("/a/b/c/d", undefined, 3)).toBe("\u2026/b/c/d");
  });

  it("leaves short absolute paths whole", () => {
    expect(shortCwd("/")).toBe("/");
    expect(shortCwd("/tmp")).toBe("/tmp");
    expect(shortCwd("/usr/bin")).toBe("/usr/bin");
  });

  it("does not take a sibling of the home folder for the home folder", () => {
    expect(shortCwd("/home/ada2", "/home/ada")).toBe("/home/ada2");
    expect(shortCwd("/home/ad", "/home/ada")).toBe("/home/ad");
  });

  it("reads a Windows path with backslashes and keeps the separator", () => {
    expect(shortCwd("C:\\Users\\ada", "C:\\Users\\ada")).toBe("~");
    expect(shortCwd("C:\\Users\\ada\\dev\\noren", "C:\\Users\\ada")).toBe("~\\dev\\noren");
    expect(shortCwd("C:\\Users\\ada\\dev\\noren\\apps", "C:\\Users\\ada")).toBe(
      "\u2026\\noren\\apps",
    );
    expect(shortCwd("D:\\Projects\\noren\\apps")).toBe("\u2026\\noren\\apps");
    expect(shortCwd("D:\\Projects\\noren")).toBe("D:\\Projects\\noren");
    expect(shortCwd("C:\\")).toBe("C:\\");
    expect(shortCwd("C:\\Windows")).toBe("C:\\Windows");
  });

  it("compares a Windows path with home ignoring case and slash direction", () => {
    expect(shortCwd("c:\\users\\ADA\\dev", "C:\\Users\\ada")).toBe("~\\dev");
    expect(shortCwd("C:/Users/ada/dev", "C:\\Users\\ada\\")).toBe("~/dev");
    expect(shortCwd("C:/Users/ada2", "C:\\Users\\ada")).toBe("C:/Users/ada2");
  });

  it("reads a UNC path", () => {
    expect(shortCwd("\\\\server\\share\\team\\app")).toBe("\u2026\\team\\app");
  });

  it("keeps a path that already starts with ~", () => {
    expect(shortCwd("~")).toBe("~");
    expect(shortCwd("~/proj")).toBe("~/proj");
    expect(shortCwd("~/a/b/c")).toBe("\u2026/b/c");
  });

  it("is case sensitive on POSIX and needs a home to shorten", () => {
    expect(shortCwd("/Home/ada", "/home/ada")).toBe("/Home/ada");
    expect(shortCwd("/home/ada")).toBe("/home/ada");
    expect(shortCwd("/home/ada", "")).toBe("/home/ada");
  });

  it("gives an empty string for a blank path", () => {
    expect(shortCwd("")).toBe("");
    expect(shortCwd("   ")).toBe("");
  });
});

const pane = (id: string, extra: Partial<Pane> = {}): Pane => ({
  id,
  type: "terminal",
  profileId: "bash",
  status: "idle",
  unread: false,
  bell: false,
  ...extra,
});

const item = (layout: LayoutNode, focusedPaneId: string): Item => ({
  id: "i1",
  titleLocked: false,
  layout,
  focusedPaneId,
  lastActivityAt: 0,
});

const leaf = (p: Pane): LayoutNode => ({ kind: "pane", pane: p });

describe("summarizeItem with agents", () => {
  const byId: Record<string, string> = { p2: "codex", p3: "claude" };
  const agentOf = (p: Pane): string | undefined => byId[p.id];
  const split = (a: Pane, b: Pane, focused: string): Item =>
    item({ kind: "split", dir: "row", sizes: [50, 50], children: [leaf(a), leaf(b)] }, focused);

  it("has no agent unless it is told how to find one", () => {
    expect(summarizeItem(item(leaf(pane("p2")), "p2"))).not.toHaveProperty("agent");
    expect(summarizeItem(item(leaf(pane("p1")), "p1"), undefined, agentOf)).not.toHaveProperty(
      "agent",
    );
  });

  it("takes the agent of the focused pane, else of the first pane that has one", () => {
    const tab = split(pane("p3"), pane("p2"), "p2");
    expect(summarizeItem(tab, undefined, agentOf).agent).toBe("codex");
    const other = split(pane("p1"), pane("p3"), "p1");
    expect(summarizeItem(other, undefined, agentOf).agent).toBe("claude");
  });

  it("names the agent in the words of the indicators", () => {
    const summary = summarizeItem(item(leaf(pane("p2")), "p2"), undefined, agentOf);
    expect(indicatorLabels(summary)).toEqual(["Agent codex"]);
  });

  describe("and their state", () => {
    const states: Record<string, AgentState> = { p2: "working", p3: "waiting" };
    const stateOf = (p: Pane): AgentState | undefined => states[p.id];

    it("has no state unless it is told how to find one, nor for a tab without an agent", () => {
      const tab = item(leaf(pane("p2")), "p2");
      expect(summarizeItem(tab, undefined, agentOf)).not.toHaveProperty("agentState");
      expect(
        summarizeItem(item(leaf(pane("p1")), "p1"), undefined, agentOf, stateOf),
      ).not.toHaveProperty("agentState");
    });

    it("takes the state of the agent, and the most pressing one among the panes of a split", () => {
      expect(
        summarizeItem(item(leaf(pane("p2")), "p2"), undefined, agentOf, stateOf).agentState,
      ).toBe("working");
      const tab = split(pane("p2"), pane("p3"), "p2");
      expect(summarizeItem(tab, undefined, agentOf, stateOf).agentState).toBe("waiting");
    });

    it("says the state in the words of the indicators, in English and in Portuguese", () => {
      const summary = summarizeItem(item(leaf(pane("p3")), "p3"), undefined, agentOf, stateOf);
      expect(indicatorLabels(summary)).toEqual(["Agent claude is waiting for you"]);
      setLanguage("pt-BR");
      try {
        expect(indicatorLabels(summary)).toEqual(["O agente claude está esperando você"]);
        expect(agentStateLabel("claude", "working")).toBe("O agente claude está trabalhando");
        expect(agentStateLabel("claude", "idle")).toBe("O agente claude está ocioso");
      } finally {
        setLanguage("en");
      }
    });
  });
});

describe("summarizeItem", () => {
  it("has nothing to show for a plain idle pane without a folder", () => {
    expect(summarizeItem(item(leaf(pane("p1")), "p1"))).toEqual({
      running: false,
      unread: false,
      bell: false,
    });
  });

  it("takes the folder and the branch of the pane, and the default folder of the space otherwise", () => {
    const withCwd = item(leaf(pane("p1", { cwd: "/work", gitBranch: "main" })), "p1");
    expect(summarizeItem(withCwd, "/space")).toMatchObject({ cwd: "/work", gitBranch: "main" });
    const without = item(leaf(pane("p1")), "p1");
    expect(summarizeItem(without, "/space")).toMatchObject({ cwd: "/space" });
    expect(summarizeItem(without, "  ")).not.toHaveProperty("cwd");
    expect(summarizeItem(item(leaf(pane("p1", { gitBranch: "" })), "p1"))).not.toHaveProperty(
      "gitBranch",
    );
  });

  it("flags running, unread and bell", () => {
    const summary = summarizeItem(
      item(leaf(pane("p1", { status: "running", unread: true, bell: true })), "p1"),
    );
    expect(summary).toMatchObject({ running: true, unread: true, bell: true });
    expect(summary).not.toHaveProperty("failed");
  });

  it("flags an exit with a code other than 0, or without a code, but not a clean exit", () => {
    const exited = (exitCode?: number) =>
      summarizeItem(
        item(
          leaf(pane("p1", { status: "exited", ...(exitCode !== undefined ? { exitCode } : {}) })),
          "p1",
        ),
      );
    expect(exited(2).failed).toBe(2);
    expect(exited(130).failed).toBe(130);
    expect(exited().failed).toBeNull();
    expect(exited(0)).not.toHaveProperty("failed");
  });

  it("reads the focused pane for the folder and every pane for the flags", () => {
    const split: LayoutNode = {
      kind: "split",
      dir: "row",
      sizes: [50, 50],
      children: [
        leaf(pane("p1", { cwd: "/one", gitBranch: "one" })),
        leaf(
          pane("p2", { cwd: "/two", gitBranch: "two", status: "exited", exitCode: 3, bell: true }),
        ),
      ],
    };
    expect(summarizeItem(item(split, "p1"))).toMatchObject({
      cwd: "/one",
      gitBranch: "one",
      failed: 3,
      bell: true,
    });
    expect(summarizeItem(item(split, "p2"))).toMatchObject({ cwd: "/two", gitBranch: "two" });
  });
});

describe("indicatorLabels", () => {
  it("lists what is on, in drawing order", () => {
    const base = { running: false, unread: false, bell: false };
    expect(indicatorLabels(base)).toEqual([]);
    expect(indicatorLabels({ running: true, failed: 2, unread: true, bell: true })).toEqual([
      "Running",
      "Exited with code 2",
      "Unread output",
      "Bell",
    ]);
    expect(indicatorLabels({ ...base, failed: 0 })).toEqual(["Exited with code 0"]);
  });
});

describe("failureLabel", () => {
  it("names the code", () => {
    expect(failureLabel(2)).toBe("Exited with code 2");
    expect(failureLabel(null)).toBe("Exited with an error");
  });
});

describe("formatDuration", () => {
  it("writes a short time with a tenth, a longer one in whole seconds, minutes and hours", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(999)).toBe("<1s");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(2599)).toBe("2.5s");
    expect(formatDuration(9999)).toBe("9.9s");
    expect(formatDuration(10_000)).toBe("10s");
    expect(formatDuration(59_999)).toBe("59s");
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
  });

  it("is empty for a time that makes no sense", () => {
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
  });
});

describe("commandInfo", () => {
  it("is none for a pane that ran nothing", () => {
    expect(commandInfo(pane("p1"))).toBeUndefined();
    expect(commandInfo(undefined)).toBeUndefined();
  });

  it("shows the command running now, with its line when the shell told it", () => {
    expect(commandInfo(pane("p1", { runningCommand: { text: "npm test" } }))).toEqual({
      state: "running",
      text: "npm test",
    });
    expect(commandInfo(pane("p1", { runningCommand: {} }))).toEqual({ state: "running" });
  });

  it("the running command comes before the last one", () => {
    const info = commandInfo(
      pane("p1", { runningCommand: { text: "b" }, lastCommand: { text: "a", exitCode: 1 } }),
    );
    expect(info).toEqual({ state: "running", text: "b" });
  });

  it("shows the last command with its code and duration", () => {
    expect(
      commandInfo(pane("p1", { lastCommand: { text: "ls", exitCode: 0, durationMs: 2500 } })),
    ).toEqual({ state: "done", text: "ls", exitCode: 0, duration: "2.5s" });
  });

  it("a code other than 0 is a failure; no code is not", () => {
    expect(commandInfo(pane("p1", { lastCommand: { text: "x", exitCode: 2 } }))?.state).toBe(
      "failed",
    );
    expect(commandInfo(pane("p1", { lastCommand: { text: "x" } }))).toEqual({
      state: "done",
      text: "x",
    });
  });
});

describe("commandWords", () => {
  it("words a running command and a last one", () => {
    expect(commandWords({ state: "running", text: "sleep 5" })).toBe("Running sleep 5");
    expect(commandWords({ state: "running" })).toBe("Running a command");
    expect(commandWords({ state: "failed", text: "make", exitCode: 2, duration: "12s" })).toBe(
      "Last command make, exit 2, 12s",
    );
    expect(commandWords({ state: "done", exitCode: 0 })).toBe("Last command, exit 0");
  });
});

describe("summarizeItem commands", () => {
  it("takes the command of the focused pane", () => {
    const split: LayoutNode = {
      kind: "split",
      dir: "row",
      sizes: [50, 50],
      children: [
        leaf(pane("p1", { lastCommand: { text: "one", exitCode: 0 } })),
        leaf(pane("p2", { lastCommand: { text: "two", exitCode: 1 } })),
      ],
    };
    expect(summarizeItem(item(split, "p1")).command).toMatchObject({ text: "one" });
    expect(summarizeItem(item(split, "p2")).command).toMatchObject({ text: "two" });
    expect(summarizeItem(item(leaf(pane("p1")), "p1"))).not.toHaveProperty("command");
  });

  it("a command running in any pane makes the tab running", () => {
    const split: LayoutNode = {
      kind: "split",
      dir: "row",
      sizes: [50, 50],
      children: [leaf(pane("p1")), leaf(pane("p2", { runningCommand: { text: "x" } }))],
    };
    expect(summarizeItem(item(split, "p1")).running).toBe(true);
    expect(summarizeItem(item(leaf(pane("p1")), "p1")).running).toBe(false);
  });
});

describe("the marks of a group and of a space", () => {
  const tab = (id: string, extra: Partial<Pane> = {}): Item =>
    item(leaf(pane(`p-${id}`, extra)), `p-${id}`);
  const space: Space = {
    id: "s1",
    name: "Main",
    icon: "terminal",
    color: "#6b8afd",
    modIds: [],
    defaults: { env: {} },
    aiEnabled: true,
    saveScrollback: true,
    pinned: ["a"],
    tree: [
      {
        kind: "group",
        id: "outer",
        name: "outer",
        color: "teal",
        collapsed: true,
        children: [
          { kind: "item", id: "b" },
          {
            kind: "group",
            id: "inner",
            name: "inner",
            color: "red",
            collapsed: false,
            children: [{ kind: "item", id: "c" }],
          },
        ],
      },
      { kind: "item", id: "d" },
    ],
    items: {
      a: tab("a", { unread: true }),
      b: tab("b"),
      c: tab("c", { unread: true, bell: true }),
      d: tab("d"),
    },
  };
  const group = (id: string): GroupNode => {
    const found = treeGroups(space.tree).find((g) => g.id === id);
    if (!found) throw new Error(id);
    return found;
  };

  it("a group has the marks of its tabs at any depth, and not those outside", () => {
    expect(groupMarks(space, group("outer"))).toEqual({ unread: true, bell: true });
    expect(groupMarks(space, group("inner"))).toEqual({ unread: true, bell: true });
    const quiet: Space = { ...space, items: { ...space.items, c: tab("c") } };
    expect(groupMarks(quiet, group("outer"))).toEqual({ unread: false, bell: false });
  });

  it("a space has the marks of all its tabs, pinned ones included", () => {
    expect(spaceMarks(space)).toEqual({ unread: true, bell: true });
    const onlyPinned: Space = { ...space, items: { ...space.items, c: tab("c") } };
    expect(spaceMarks(onlyPinned)).toEqual({ unread: true, bell: false });
    expect(spaceMarks({ ...space, items: {} })).toEqual({ unread: false, bell: false });
  });

  it("says them in words", () => {
    expect(marksWords({ unread: false, bell: false })).toEqual([]);
    expect(marksWords({ unread: true, bell: false })).toEqual(["Unread output"]);
    expect(marksWords({ unread: true, bell: true })).toEqual(["Unread output", "Bell"]);
  });
});

describe("summarizeItem with the connection of a shell on another machine", () => {
  const links: Record<string, SessionLink> = {
    p2: { id: 2, state: "reconnecting", attempt: 3, maxAttempts: 10, reason: "Connection reset" },
    p3: { id: 3, state: "failed", reason: "Permission denied (publickey)." },
    p4: { id: 4, state: "connected" },
  };
  const linkOf = (p: Pane): SessionLink | undefined => links[p.id];
  const split = (a: Pane, b: Pane): Item =>
    item({ kind: "split", dir: "row", sizes: [50, 50], children: [leaf(a), leaf(b)] }, a.id);

  it("has no link unless it is told how to find one, and none for a shell that is up", () => {
    expect(summarizeItem(item(leaf(pane("p2")), "p2"))).not.toHaveProperty("link");
    expect(
      summarizeItem(item(leaf(pane("p1")), "p1"), undefined, undefined, undefined, linkOf),
    ).not.toHaveProperty("link");
    expect(
      summarizeItem(item(leaf(pane("p4")), "p4"), undefined, undefined, undefined, linkOf),
    ).not.toHaveProperty("link");
  });

  it("takes the state, the attempt and the reason of the pane", () => {
    const summary = summarizeItem(
      item(leaf(pane("p2")), "p2"),
      undefined,
      undefined,
      undefined,
      linkOf,
    );
    expect(summary.link).toEqual({
      state: "reconnecting",
      attempt: 3,
      maxAttempts: 10,
      reason: "Connection reset",
    });
  });

  it("shows the failure over a retry when the panes of a split disagree, in either order", () => {
    for (const tab of [split(pane("p2"), pane("p3")), split(pane("p3"), pane("p2"))]) {
      expect(summarizeItem(tab, undefined, undefined, undefined, linkOf).link?.state).toBe(
        "failed",
      );
    }
    expect(
      summarizeItem(split(pane("p4"), pane("p2")), undefined, undefined, undefined, linkOf).link
        ?.state,
    ).toBe("reconnecting");
  });

  it("says what is happening, and for a retry that what is typed is not sent", () => {
    expect(linkText({ state: "reconnecting", attempt: 3, maxAttempts: 10 })).toBe(
      "Reconnecting, attempt 3 of 10. What you type is not sent.",
    );
    expect(linkText({ state: "reconnecting" })).toBe("Reconnecting. What you type is not sent.");
    expect(
      linkText({ state: "reconnecting", attempt: 1, maxAttempts: 5, reason: "Timed out" }),
    ).toBe("Reconnecting, attempt 1 of 5. What you type is not sent. Timed out");
    expect(linkText({ state: "failed", reason: "Host key changed" })).toBe(
      "Connection failed: Host key changed",
    );
    expect(linkText({ state: "failed" })).toBe("Connection failed.");
    expect(linkShort({ state: "reconnecting", attempt: 3, maxAttempts: 10 })).toBe(
      "Reconnecting 3/10",
    );
    expect(linkShort({ state: "reconnecting" })).toBe("Reconnecting");
    expect(linkShort({ state: "failed", reason: "x" })).toBe("Failed");
  });

  it("puts it first in the words of the indicators, in English and in Portuguese", () => {
    const summary = summarizeItem(
      item(leaf(pane("p2")), "p2"),
      undefined,
      undefined,
      undefined,
      linkOf,
    );
    expect(indicatorLabels(summary)[0]).toBe(
      "Reconnecting, attempt 3 of 10. What you type is not sent. Connection reset",
    );
    setLanguage("pt-BR");
    try {
      expect(linkText({ state: "reconnecting", attempt: 3, maxAttempts: 10 })).toBe(
        "Reconectando, tentativa 3 de 10. O que você digitar não é enviado.",
      );
      expect(linkText({ state: "failed", reason: "x" })).toBe("A conexão falhou: x");
      expect(linkShort({ state: "failed" })).toBe("Falhou");
    } finally {
      setLanguage("en");
    }
  });
});
