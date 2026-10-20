import { describe, expect, it } from "vitest";
import {
  AgentCatalogSchema,
  DEFAULT_AGENT_CATALOG,
  DEFAULT_RESUME_ON_RESTORE,
  MAX_AGENT_RESUME_CHARS,
  agentSettingsOf,
  configJsonSchema,
  parseConfigText,
  planAgentResume,
} from "./index";
import type { AgentCatalog, SavedPaneCommand } from "./index";

// Resuming agents after the machine restarted (NOR-F14-03): the field `resume` of a catalog entry,
// the option `agents.resumeOnRestore`, and the pure rule that says which panes get which command.

/** A catalog that is not the built-in one: two agents that can be resumed and two that cannot. */
const CATALOG: AgentCatalog = [
  { id: "alpha", executables: ["alpha"], resume: "alpha --resume" },
  { id: "beta", executables: ["beta"], resume: "beta continue --last" },
  { id: "gamma", executables: ["gamma"] },
  { id: "delta", executables: ["delta"], resume: "  " },
];

const ON = { enabled: true, resumeOnRestore: true, catalog: CATALOG };

const saved = (...commands: [string, string][]): SavedPaneCommand[] =>
  commands.map(([paneId, text]) => ({ paneId, text }));

describe("planAgentResume", () => {
  it("resumes the pane whose saved command names an agent that has a resume command", () => {
    const plan = planAgentResume({
      settings: ON,
      savedCommands: saved(["p1", "alpha --verbose"]),
      reattachedPaneIds: [],
    });
    expect(plan).toEqual([{ paneId: "p1", agentId: "alpha", text: "alpha --resume" }]);
  });

  it("gives each pane the command of its own agent, in the order of the saved commands", () => {
    const plan = planAgentResume({
      settings: ON,
      savedCommands: saved(["p2", "beta go"], ["p1", "alpha"]),
      reattachedPaneIds: [],
    });
    expect(plan).toEqual([
      { paneId: "p2", agentId: "beta", text: "beta continue --last" },
      { paneId: "p1", agentId: "alpha", text: "alpha --resume" },
    ]);
  });

  it("finds the agent the way the detector does (a folder in front, a launcher ending, a prefix word)", () => {
    const plan = planAgentResume({
      settings: ON,
      savedCommands: saved(["p1", "sudo /opt/bin/Alpha.exe --x"], ["p2", "cd /tmp && beta"]),
      reattachedPaneIds: [],
    });
    expect(plan.map((entry) => entry.paneId)).toEqual(["p1", "p2"]);
  });

  it("does nothing with the option off, which is the default", () => {
    expect(DEFAULT_RESUME_ON_RESTORE).toBe(false);
    expect(
      planAgentResume({
        settings: { ...ON, resumeOnRestore: false },
        savedCommands: saved(["p1", "alpha"]),
        reattachedPaneIds: [],
      }),
    ).toEqual([]);
    expect(
      planAgentResume({
        settings: agentSettingsOf(undefined),
        savedCommands: saved(["p1", "claude"]),
        reattachedPaneIds: [],
      }),
    ).toEqual([]);
  });

  it("does nothing with the agents off, even with the option on", () => {
    expect(
      planAgentResume({
        settings: { ...ON, enabled: false },
        savedCommands: saved(["p1", "alpha"]),
        reattachedPaneIds: [],
      }),
    ).toEqual([]);
  });

  it("skips an agent whose entry has no resume command, or a blank one", () => {
    expect(
      planAgentResume({
        settings: ON,
        savedCommands: saved(["p1", "gamma"], ["p2", "delta"]),
        reattachedPaneIds: [],
      }),
    ).toEqual([]);
  });

  it("skips a pane with no agent: a command that is not in the catalog, or no command", () => {
    expect(
      planAgentResume({
        settings: ON,
        savedCommands: saved(["p1", "vim notes.txt"], ["p2", "alphabet"], ["p3", ""], ["p4", "  "]),
        reattachedPaneIds: [],
      }),
    ).toEqual([]);
    expect(planAgentResume({ settings: ON, savedCommands: [], reattachedPaneIds: [] })).toEqual([]);
  });

  it("never resumes a pane that got its old shell back: the agent still runs in it", () => {
    const plan = planAgentResume({
      settings: ON,
      savedCommands: saved(["p1", "alpha"], ["p2", "beta"]),
      reattachedPaneIds: ["p1"],
    });
    expect(plan).toEqual([{ paneId: "p2", agentId: "beta", text: "beta continue --last" }]);
  });

  it("lists a pane once, whatever the saved commands say", () => {
    const plan = planAgentResume({
      settings: ON,
      savedCommands: saved(["p1", "alpha"], ["p1", "beta"]),
      reattachedPaneIds: [],
    });
    expect(plan).toEqual([{ paneId: "p1", agentId: "alpha", text: "alpha --resume" }]);
  });

  it("uses the catalog it is given: the built-in one resumes claude and no other", () => {
    const withResume = DEFAULT_AGENT_CATALOG.filter((entry) => entry.resume !== undefined);
    expect(withResume.map((entry) => entry.id)).toEqual(["claude"]);
    const plan = planAgentResume({
      settings: { ...agentSettingsOf({ resumeOnRestore: true }) },
      savedCommands: saved(["p1", "claude"], ["p2", "codex"], ["p3", "aider --model x"]),
      reattachedPaneIds: [],
    });
    expect(plan).toEqual([{ paneId: "p1", agentId: "claude", text: "claude --continue" }]);
  });
});

describe("the resume field of a catalog entry", () => {
  const entry = (resume: unknown) =>
    AgentCatalogSchema.safeParse([{ id: "alpha", executables: ["alpha"], resume }]);

  it("takes a full command line", () => {
    expect(entry("alpha --resume").success).toBe(true);
    expect(entry("claude --continue").success).toBe(true);
  });

  it("is optional: an entry without it, and a catalog written before the field, are valid", () => {
    expect(AgentCatalogSchema.safeParse([{ id: "alpha", executables: ["alpha"] }]).success).toBe(
      true,
    );
    expect(AgentCatalogSchema.safeParse(DEFAULT_AGENT_CATALOG).success).toBe(true);
  });

  it("refuses a blank line, a line break, a control character, a number and a line that is too long", () => {
    expect(entry("").success).toBe(false);
    expect(entry("   ").success).toBe(false);
    expect(entry("alpha\nrm -rf x").success).toBe(false);
    expect(entry("alpha\r").success).toBe(false);
    expect(entry("alpha\u001b[31m").success).toBe(false);
    expect(entry("alpha\u0000").success).toBe(false);
    expect(entry(3).success).toBe(false);
    expect(entry("a".repeat(MAX_AGENT_RESUME_CHARS)).success).toBe(true);
    expect(entry("a".repeat(MAX_AGENT_RESUME_CHARS + 1)).success).toBe(false);
  });
});

describe("agents.resumeOnRestore", () => {
  it("is off by default", () => {
    expect(agentSettingsOf(undefined).resumeOnRestore).toBe(false);
    expect(agentSettingsOf({}).resumeOnRestore).toBe(false);
    expect(agentSettingsOf({ enabled: true }).resumeOnRestore).toBe(false);
  });

  it("is what the file says", () => {
    expect(agentSettingsOf({ resumeOnRestore: true }).resumeOnRestore).toBe(true);
    expect(agentSettingsOf({ resumeOnRestore: false }).resumeOnRestore).toBe(false);
  });

  it("reads from config.jsonc, and a config written before the option is still valid", () => {
    const on = parseConfigText('{ "agents": { "resumeOnRestore": true } }');
    expect(on.ok && on.config.agents?.resumeOnRestore).toBe(true);
    const old = parseConfigText(
      '{ "agents": { "enabled": true, "scanSeconds": 5, "catalog": [{ "id": "x", "executables": ["x"] }] } }',
    );
    expect(old.ok).toBe(true);
    expect(old.ok && old.config.agents?.resumeOnRestore).toBeUndefined();
    expect(parseConfigText("{}").ok).toBe(true);
  });

  it("reads a resume command from the catalog of config.jsonc", () => {
    const result = parseConfigText(
      '{ "agents": { "catalog": [{ "id": "x", "executables": ["x"], "resume": "x --again" }] } }',
    );
    expect(result.ok && result.config.agents?.catalog?.[0]?.resume).toBe("x --again");
  });

  it("refuses what is not true or false, and a resume command with a line break, with the place", () => {
    const wrong = parseConfigText('{ "agents": { "resumeOnRestore": "yes" } }');
    expect(wrong.ok).toBe(false);
    const broken = parseConfigText(
      '{ "agents": { "catalog": [{ "id": "x", "executables": ["x"], "resume": "x\\ny" }] } }',
    );
    expect(broken.ok).toBe(false);
  });

  it("is in the JSON schema with its description and its default, and so is the resume field", () => {
    const schema = configJsonSchema() as {
      properties: { agents: { properties: Record<string, unknown> } };
    };
    const agents = schema.properties.agents.properties as {
      resumeOnRestore: { type: string; default: boolean; description: string };
      catalog: { items: { properties: { resume: { type: string; description: string } } } };
    };
    expect(agents.resumeOnRestore.type).toBe("boolean");
    expect(agents.resumeOnRestore.default).toBe(false);
    expect(agents.resumeOnRestore.description).toMatch(/restarts/);
    expect(agents.catalog.items.properties.resume.type).toBe("string");
    expect(agents.catalog.items.properties.resume.description).toMatch(/claude --continue/);
  });
});
