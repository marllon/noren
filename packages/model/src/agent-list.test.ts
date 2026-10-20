import { describe, expect, it } from "vitest";
import {
  AGENT_LINE_MAX,
  AgentStateTracker,
  ManualClock,
  NO_LAST_LINE,
  TerminalTextStripper,
  advanceLastLine,
  buildAgentList,
  compileAgentRules,
  encodeUtf8,
  firstWaitingAgent,
  lastLineOf,
  truncateLine,
} from "./index";
import type { AgentInfo, Pane, Space } from "./index";
import { richWorkspace } from "./state-fixtures";

// The list of the agents of all the spaces: the order (waiting, working, idle, then the one that
// has been in its state longest), the time in the state, the last line cut for the screen, the
// first agent that waits, and the last line the tracker keeps from the plain text of the output.

const workspace = richWorkspace();
const titleOf = (space: Space, itemId: string): string => `${space.name}/${itemId}`;

/** An agent in every pane of `states`, each in the state and since the moment given. */
function listOf(
  states: Readonly<Record<string, Pick<AgentInfo, "state" | "since"> & { lastLine?: string }>>,
  now: number,
) {
  return buildAgentList(
    workspace,
    (pane: Pane) => {
      const entry = states[pane.id];
      if (entry === undefined) return undefined;
      return { agentId: `agent-${pane.id}`, lastLine: "", ...entry };
    },
    titleOf,
    now,
  );
}

describe("buildAgentList", () => {
  it("is empty when no pane has an agent", () => {
    expect(listOf({}, 5000)).toEqual([]);
    expect(firstWaitingAgent(listOf({}, 5000))).toBeUndefined();
  });

  it("puts waiting before working before idle", () => {
    const rows = listOf(
      {
        p1: { state: "idle", since: 0 },
        p2: { state: "working", since: 0 },
        p3: { state: "waiting", since: 4000 },
      },
      5000,
    );
    expect(rows.map((row) => [row.paneId, row.state])).toEqual([
      ["p3", "waiting"],
      ["p2", "working"],
      ["p1", "idle"],
    ]);
  });

  it("puts the one that has been longest in its state first, and keeps the sidebar order on a tie", () => {
    const rows = listOf(
      {
        p1: { state: "waiting", since: 3000 },
        p2: { state: "waiting", since: 1000 },
        p3: { state: "waiting", since: 3000 },
      },
      5000,
    );
    expect(rows.map((row) => row.paneId)).toEqual(["p2", "p1", "p3"]);
  });

  it("says where each agent is: space, tab, pane", () => {
    const [row] = listOf({ p3: { state: "working", since: 0 } }, 1000);
    expect(row).toMatchObject({
      paneId: "p3",
      itemId: "i2",
      spaceId: "s1",
      spaceName: "Main",
      itemTitle: "Main/i2",
      agentId: "agent-p3",
    });
  });

  it("counts the time in the state on the clock it is given, never below zero", () => {
    const [row] = listOf({ p1: { state: "idle", since: 1000 } }, 126_000);
    expect(row?.elapsedMs).toBe(125_000);
    expect(row?.elapsed).toBe("2m 05s");
    const [early] = listOf({ p1: { state: "idle", since: 9000 } }, 1000);
    expect(early?.elapsedMs).toBe(0);
    expect(early?.elapsed).toBe("0s");
  });

  it("cuts a long last line and leaves a short one", () => {
    const long = "x".repeat(AGENT_LINE_MAX + 50);
    const rows = listOf(
      {
        p1: { state: "working", since: 0, lastLine: long },
        p2: { state: "working", since: 0, lastLine: "all done" },
      },
      0,
    );
    const byPane = Object.fromEntries(rows.map((row) => [row.paneId, row.lastLine]));
    expect(Array.from(byPane["p1"] ?? "")).toHaveLength(AGENT_LINE_MAX);
    expect(byPane["p1"]?.endsWith("…")).toBe(true);
    expect(byPane["p2"]).toBe("all done");
  });

  it("does not mutate the workspace", () => {
    const before = JSON.stringify(workspace);
    listOf({ p1: { state: "waiting", since: 0 } }, 10);
    expect(JSON.stringify(workspace)).toBe(before);
  });
});

describe("firstWaitingAgent", () => {
  it("is the waiting agent that has waited longest", () => {
    const rows = listOf(
      {
        p1: { state: "working", since: 0 },
        p2: { state: "waiting", since: 3000 },
        p3: { state: "waiting", since: 2000 },
      },
      9000,
    );
    expect(firstWaitingAgent(rows)?.paneId).toBe("p3");
  });

  it("is undefined when nobody waits", () => {
    const rows = listOf(
      { p1: { state: "working", since: 0 }, p2: { state: "idle", since: 0 } },
      9000,
    );
    expect(firstWaitingAgent(rows)).toBeUndefined();
  });
});

describe("truncateLine", () => {
  it("counts characters, not UTF-16 units", () => {
    expect(truncateLine("😀😀😀😀", 3)).toBe("😀😀…");
    expect(truncateLine("😀😀😀", 3)).toBe("😀😀😀");
  });
});

describe("the last line of the output", () => {
  const lines = (...chunks: string[]): string => {
    let memory = NO_LAST_LINE;
    for (const chunk of chunks) memory = advanceLastLine(memory, chunk);
    return lastLineOf(memory);
  };

  it("is empty before any output and ignores blank lines", () => {
    expect(lines()).toBe("");
    expect(lines("\n\n  \n")).toBe("");
  });

  it("is the last finished line with something on it", () => {
    expect(lines("one\ntwo\n\n  \n")).toBe("two");
  });

  it("shows the line still being written, so a prompt shows", () => {
    expect(lines("done\nready> ")).toBe("ready>");
  });

  it("joins a line cut between two chunks", () => {
    expect(lines("Do you want to pro", "ceed? [y/N]")).toBe("Do you want to proceed? [y/N]");
  });

  it("turns tabs into spaces", () => {
    expect(lines("a\tb\n")).toBe("a b");
  });

  it("is bounded, whatever comes in", () => {
    expect(lines("y".repeat(100_000)).length).toBeLessThanOrEqual(400);
    expect(lines("y".repeat(100_000) + "\n").length).toBeLessThanOrEqual(400);
  });
});

describe("AgentStateTracker.lastLine", () => {
  function tracker() {
    const clock = new ManualClock();
    const lineChanges: number[] = [];
    const t = new AgentStateTracker({
      clock,
      rules: compileAgentRules(undefined, 8000),
      onLine: () => lineChanges.push(clock.now()),
    });
    return { clock, t, lineChanges };
  }

  it("is the visible line of the bytes, without colors or cursor moves", () => {
    const { t } = tracker();
    t.feed(encodeUtf8("\u001b[33m✻\u001b[39m Thinking… (3s)\u001b[K\r\n"));
    expect(t.lastLine).toBe("✻ Thinking… (3s)");
  });

  it("follows a redraw with a carriage return", () => {
    const { t } = tracker();
    t.feed("Thinking (1s)\r");
    t.feed("Thinking (2s)\r");
    expect(t.lastLine).toBe("Thinking (2s)");
  });

  it("tells onLine when the line changed, and only then", () => {
    const { t, lineChanges } = tracker();
    t.feed("hello\n");
    t.feed("\n");
    t.feed("\u001b[0m");
    expect(lineChanges).toHaveLength(1);
    t.feed("again\n");
    expect(lineChanges).toHaveLength(2);
  });

  it("is the same through the stripper as through feedText", () => {
    const stripped = new TerminalTextStripper().feed("\u001b[1mbold\u001b[0m text\r\n");
    const { t } = tracker();
    t.feedText(stripped);
    expect(t.lastLine).toBe("bold text");
  });

  it("stops changing after dispose", () => {
    const { t } = tracker();
    t.feed("before\n");
    t.dispose();
    t.feed("after\n");
    expect(t.lastLine).toBe("before");
  });
});
