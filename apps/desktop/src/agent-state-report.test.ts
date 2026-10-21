import { afterEach, describe, expect, it } from "vitest";
import { ManualClock, encodeUtf8 } from "@noren/model";
import type { Pane } from "@noren/model";
import { API_AGENT_STATE_COMMAND, createAgentStateReporter } from "./agent-state-report";
import {
  feedAgentOutput,
  forgetAgentState,
  noteAgentInput,
  noteAgentNotification,
  resetAgentStates,
  setAgentStateClock,
  setAgentStateReporter,
} from "./agent-state-store";
import { resetAgentStore, setTreeAgents } from "./agent-store";
import { fixturePane } from "./closed-fixtures";
import { configManager } from "./config-store";
import type { TauriBridge } from "./tauri-backend";

// The page tells the Rust side what an agent is doing only when it changes, with the session of
// its pane, so the local API can publish `agent.state` once per change.

interface Call {
  command: string;
  args: Record<string, unknown> | undefined;
}

function recordingBridge(options: { fail?: boolean } = {}) {
  const calls: Call[] = [];
  const bridge: Pick<TauriBridge, "invoke"> = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return options.fail === true
        ? Promise.reject(new Error("the window is closing"))
        : Promise.resolve(undefined as T);
    },
  };
  return { bridge, calls };
}

const told = (calls: Call[]) => calls.map((c) => [c.args?.["sessionId"], c.args?.["state"]]);

describe("createAgentStateReporter", () => {
  it("calls the command with the session and the state, only when the state changes", () => {
    const { bridge, calls } = recordingBridge();
    const report = createAgentStateReporter(bridge);
    report("7", "working");
    report("7", "working");
    report("7", "waiting");
    report("7", "waiting");
    report("7", "working");
    expect(calls.every((c) => c.command === API_AGENT_STATE_COMMAND)).toBe(true);
    expect(told(calls)).toEqual([
      ["7", "working"],
      ["7", "waiting"],
      ["7", "working"],
    ]);
  });

  it("takes a session to be idle at first, so the first idle is not a change", () => {
    const { bridge, calls } = recordingBridge();
    const report = createAgentStateReporter(bridge);
    report("7", "idle");
    expect(calls).toEqual([]);
    report("7", "working");
    report("7", "idle");
    report("7", "idle");
    expect(told(calls)).toEqual([
      ["7", "working"],
      ["7", "idle"],
    ]);
  });

  it("keeps a state for each session", () => {
    const { bridge, calls } = recordingBridge();
    const report = createAgentStateReporter(bridge);
    report("1", "working");
    report("2", "working");
    report("1", "waiting");
    expect(told(calls)).toEqual([
      ["1", "working"],
      ["2", "working"],
      ["1", "waiting"],
    ]);
  });

  it("does not throw when the command fails", async () => {
    const { bridge, calls } = recordingBridge({ fail: true });
    const report = createAgentStateReporter(bridge);
    expect(() => report("7", "working")).not.toThrow();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });
});

describe("the tracker of a pane reports to the local API", () => {
  const clock = new ManualClock();
  const pane = (id: string, sessionId?: string): Pane => ({
    ...fixturePane(id),
    ...(sessionId !== undefined ? { sessionId } : {}),
    runningCommand: { text: "claude" },
  });
  const bytes = (text: string) => encodeUtf8(text);

  function start() {
    const run = recordingBridge();
    setAgentStateClock(clock);
    setAgentStateReporter(createAgentStateReporter(run.bridge));
    return run;
  }

  afterEach(() => {
    setAgentStateReporter(undefined);
    configManager.apply("{}");
    resetAgentStore();
    resetAgentStates();
  });

  it("calls the command once per change of state, with the session of the pane", () => {
    const { calls } = start();
    const p = pane("p1", "42");
    feedAgentOutput(p, bytes("compiling\n"));
    feedAgentOutput(p, bytes("still compiling\n"));
    expect(told(calls)).toEqual([["42", "working"]]);
    noteAgentNotification(p);
    expect(told(calls)).toEqual([
      ["42", "working"],
      ["42", "waiting"],
    ]);
    noteAgentInput(p);
    expect(told(calls).at(-1)).toEqual(["42", "working"]);
    clock.advance(60_000);
    expect(told(calls).at(-1)).toEqual(["42", "idle"]);
  });

  it("says nothing for a pane without a session", () => {
    const { calls } = start();
    feedAgentOutput(pane("p1"), bytes("compiling\n"));
    expect(calls).toEqual([]);
  });

  it("goes idle when the pane forgets its agent, and says it once", () => {
    const { calls } = start();
    const p = pane("p1", "42");
    feedAgentOutput(p, bytes("compiling\n"));
    forgetAgentState("p1");
    forgetAgentState("p1");
    expect(told(calls)).toEqual([
      ["42", "working"],
      ["42", "idle"],
    ]);
  });

  it("goes idle when the process tree stops showing the agent", () => {
    const { calls } = start();
    setTreeAgents(new Map([["p1", "claude"]]));
    const p: Pane = { ...fixturePane("p1"), sessionId: "42" };
    noteAgentNotification(p);
    expect(told(calls)).toEqual([["42", "waiting"]]);
    setTreeAgents(new Map());
    expect(told(calls)).toEqual([
      ["42", "waiting"],
      ["42", "idle"],
    ]);
  });
});
