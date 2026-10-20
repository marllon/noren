import { afterEach, describe, expect, it } from "vitest";
import { ManualClock, encodeUtf8 } from "@noren/model";
import type { Pane } from "@noren/model";
import {
  agentStateOfPane,
  feedAgentOutput,
  forgetAgentState,
  noteAgentInput,
  noteAgentNotification,
  resetAgentStates,
  setAgentStateClock,
  subscribeAgentStates,
} from "./agent-state-store";
import { resetAgentStore, setTreeAgents } from "./agent-store";
import { fixturePane } from "./closed-fixtures";
import { configManager } from "./config-store";

// What the agent of a pane is doing, kept per pane: the output, the notification and the keys go
// in, the silence runs on the clock the test moves, and a pane without an agent has no state.

const pane = (id: string, command?: string): Pane => ({
  ...fixturePane(id),
  ...(command !== undefined ? { runningCommand: { text: command } } : {}),
});
const bytes = (text: string): Uint8Array => encodeUtf8(text);

let clock: ManualClock;

function start(): void {
  clock = new ManualClock();
  setAgentStateClock(clock);
}

afterEach(() => {
  configManager.apply("{}");
  resetAgentStore();
  resetAgentStates();
});

describe("agentStateOfPane", () => {
  it("is undefined for a pane without an agent, whatever it prints", () => {
    start();
    feedAgentOutput(pane("p1", "ls"), bytes("Do you want to proceed? [y/N]"));
    expect(agentStateOfPane(pane("p1", "ls"))).toBeUndefined();
  });

  it("is idle for an agent that printed nothing yet", () => {
    start();
    expect(agentStateOfPane(pane("p1", "claude"))).toBe("idle");
  });

  it("is working while the agent prints, and idle after the silence of the settings", () => {
    start();
    const p = pane("p1", "claude");
    feedAgentOutput(p, bytes("\u001b[33m✻\u001b[39m Pondering… (3s · esc to interrupt)\r\n"));
    expect(agentStateOfPane(p)).toBe("working");
    clock.advance(7999);
    expect(agentStateOfPane(p)).toBe("working");
    clock.advance(1);
    expect(agentStateOfPane(p)).toBe("idle");
  });

  it("follows agents.silenceSeconds of the settings file, and the entry's own", () => {
    start();
    configManager.apply(`{ "agents": { "silenceSeconds": 2, "catalog": [
      { "id": "mine", "executables": ["mine"] },
      { "id": "slow", "executables": ["slow"], "silenceSeconds": 30 },
    ] } }`);
    const mine = pane("p1", "mine");
    const slow = pane("p2", "slow");
    feedAgentOutput(mine, bytes("busy\n"));
    feedAgentOutput(slow, bytes("busy\n"));
    clock.advance(2000);
    expect(agentStateOfPane(mine)).toBe("idle");
    expect(agentStateOfPane(slow)).toBe("working");
    clock.advance(28000);
    expect(agentStateOfPane(slow)).toBe("idle");
  });

  it("takes a changed file for the next output, patterns included", () => {
    start();
    const p = pane("p1", "mine");
    configManager.apply('{ "agents": { "catalog": [{ "id": "mine", "executables": ["mine"] }] } }');
    feedAgentOutput(p, bytes("Shall I go on?\n"));
    expect(agentStateOfPane(p)).toBe("working");
    configManager.apply(`{ "agents": { "catalog": [
      { "id": "mine", "executables": ["mine"], "patterns": { "waiting": ["shall i go on"] } },
    ] } }`);
    feedAgentOutput(p, bytes("Shall I go on?\n"));
    expect(agentStateOfPane(p)).toBe("waiting");
  });

  it("is waiting after a notification, and waiting does not decay", () => {
    start();
    const p = pane("p1", "codex");
    feedAgentOutput(p, bytes("working\n"));
    noteAgentNotification(p);
    expect(agentStateOfPane(p)).toBe("waiting");
    clock.advance(60_000);
    expect(agentStateOfPane(p)).toBe("waiting");
  });

  it("goes back to working when the person types the answer", () => {
    start();
    const p = pane("p1", "aider");
    feedAgentOutput(p, bytes("Run shell command?\r\n(Y)es/(N)o [Yes]: "));
    expect(agentStateOfPane(p)).toBe("waiting");
    clock.advance(500);
    noteAgentInput(p);
    expect(agentStateOfPane(p)).toBe("working");
  });

  it("keeps a state for each pane", () => {
    start();
    const a = pane("p1", "claude");
    const b = pane("p2", "claude");
    feedAgentOutput(a, bytes("Do you want to proceed?\n"));
    feedAgentOutput(b, bytes("compiling\n"));
    expect(agentStateOfPane(a)).toBe("waiting");
    expect(agentStateOfPane(b)).toBe("working");
  });

  it("starts again for another agent in the same pane", () => {
    start();
    setTreeAgents(new Map([["p1", "claude"]]));
    const p = pane("p1");
    noteAgentNotification(p);
    expect(agentStateOfPane(p)).toBe("waiting");
    setTreeAgents(new Map([["p1", "codex"]]));
    expect(agentStateOfPane(p)).toBe("idle");
  });

  it("drops the state of an agent the process tree stopped showing", () => {
    start();
    setTreeAgents(new Map([["p1", "claude"]]));
    const p = pane("p1");
    noteAgentNotification(p);
    expect(agentStateOfPane(p)).toBe("waiting");
    setTreeAgents(new Map());
    setTreeAgents(new Map([["p1", "claude"]]));
    expect(agentStateOfPane(p)).toBe("idle");
  });

  it("forgets the state of a pane on request, and leaves no timer", () => {
    start();
    const p = pane("p1", "claude");
    feedAgentOutput(p, bytes("busy\n"));
    expect(clock.pending).toBe(1);
    forgetAgentState("p1");
    expect(clock.pending).toBe(0);
    expect(agentStateOfPane(p)).toBe("idle");
  });

  it("is undefined for every pane when agents are off", () => {
    start();
    configManager.apply('{ "agents": { "enabled": false } }');
    const p = pane("p1", "claude");
    feedAgentOutput(p, bytes("busy\n"));
    expect(agentStateOfPane(p)).toBeUndefined();
  });
});

describe("subscribeAgentStates", () => {
  it("tells whoever listens when a state changes, and not when it stays", () => {
    start();
    const p = pane("p1", "claude");
    let calls = 0;
    const stop = subscribeAgentStates(() => calls++);
    feedAgentOutput(p, bytes("one\n"));
    expect(calls).toBe(1);
    feedAgentOutput(p, bytes("two\n"));
    expect(calls).toBe(1);
    clock.advance(8000);
    expect(calls).toBe(2);
    stop();
    feedAgentOutput(p, bytes("three\n"));
    expect(calls).toBe(2);
  });
});
