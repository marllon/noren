import { afterEach, describe, expect, it } from "vitest";
import type { Pane } from "@noren/model";
import { agentOfPane, resetAgentStore, setTreeAgents, subscribeAgents } from "./agent-store";
import { fixturePane } from "./closed-fixtures";
import { configManager } from "./config-store";

// Which agent a pane has: the running command against the catalog of the settings, else what the
// process tree showed; the command wins; the setting can turn it all off.

const pane = (id: string, command?: string): Pane => ({
  ...fixturePane(id),
  ...(command !== undefined ? { runningCommand: { text: command } } : {}),
});

afterEach(() => {
  configManager.apply("{}");
  resetAgentStore();
});

describe("agentOfPane", () => {
  it("has no agent for a pane that runs nothing and has nothing under its shell", () => {
    expect(agentOfPane(pane("p1"))).toBeUndefined();
    expect(agentOfPane(pane("p1", "ls -la"))).toBeUndefined();
  });

  it("takes the running command against the built-in catalog", () => {
    expect(agentOfPane(pane("p1", "claude --resume"))).toBe("claude");
    expect(agentOfPane(pane("p1", "codex"))).toBe("codex");
  });

  it("takes what the process tree showed for that pane only", () => {
    setTreeAgents(new Map([["p1", "gemini"]]));
    expect(agentOfPane(pane("p1"))).toBe("gemini");
    expect(agentOfPane(pane("p2"))).toBeUndefined();
  });

  it("lets the command win over the tree", () => {
    setTreeAgents(new Map([["p1", "gemini"]]));
    expect(agentOfPane(pane("p1", "claude"))).toBe("claude");
    expect(agentOfPane(pane("p1", "ls"))).toBe("gemini");
  });

  it("tells whoever listens only when the tree answer changed", () => {
    let calls = 0;
    const stop = subscribeAgents(() => calls++);
    setTreeAgents(new Map([["p1", "claude"]]));
    expect(calls).toBe(1);
    setTreeAgents(new Map([["p1", "claude"]]));
    expect(calls).toBe(1);
    setTreeAgents(new Map());
    expect(calls).toBe(2);
    stop();
    setTreeAgents(new Map([["p1", "claude"]]));
    expect(calls).toBe(2);
  });

  it("follows the catalog of the settings file", () => {
    configManager.apply(
      '{ "agents": { "catalog": [{ "id": "mine", "executables": ["mine-cli"] }] } }',
    );
    expect(agentOfPane(pane("p1", "mine-cli run"))).toBe("mine");
    expect(agentOfPane(pane("p1", "claude"))).toBeUndefined();
  });

  it("is off for every pane when the file turns agents off", () => {
    setTreeAgents(new Map([["p1", "claude"]]));
    configManager.apply('{ "agents": { "enabled": false } }');
    expect(agentOfPane(pane("p1", "claude"))).toBeUndefined();
    expect(agentOfPane(pane("p1"))).toBeUndefined();
  });
});
