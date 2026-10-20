import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AgentCatalogSchema,
  DEFAULT_AGENT_CATALOG,
  agentSettingsOf,
  configJsonSchema,
  detectAgentByCommand,
  mentionsPackage,
  parseConfigText,
  programName,
  resolveAgent,
} from "./index";
import type { AgentCatalog } from "./index";

// The agent catalog (`agents` in config.jsonc) and the rule that reads a command line.

function agentsOf(text: string) {
  const result = parseConfigText(text);
  if (!result.ok) throw new Error(`expected a valid file: ${JSON.stringify(result.errors)}`);
  return result.config.agents;
}

function errorsOf(text: string) {
  const result = parseConfigText(text);
  if (result.ok) throw new Error("expected an invalid file");
  return result.errors;
}

describe("the default catalog", () => {
  it("is valid and names the agents by their executable", () => {
    expect(AgentCatalogSchema.safeParse(DEFAULT_AGENT_CATALOG).success).toBe(true);
    const ids = DEFAULT_AGENT_CATALOG.map((entry) => entry.id);
    for (const id of ["claude", "codex", "gemini", "opencode", "aider"]) {
      expect(ids).toContain(id);
    }
    // The name shown is the name of the executable: nothing else is in the entry to show.
    for (const entry of DEFAULT_AGENT_CATALOG) expect(entry.executables).toContain(entry.id);
  });
});

describe("agents in config.jsonc", () => {
  it("takes the built-in catalog, on, every 3 seconds, when the file says nothing", () => {
    const settings = agentSettingsOf(agentsOf("{}"));
    expect(settings).toEqual({
      enabled: true,
      catalog: DEFAULT_AGENT_CATALOG,
      scanIntervalMs: 3000,
    });
  });

  it("takes a catalog of your own, which replaces the built-in one", () => {
    const text = `{
  "agents": {
    "enabled": true,
    "scanSeconds": 5,
    // a tool of my own
    "catalog": [
      { "id": "helper", "executables": ["helper", "helper-cli"], "packages": ["@me/helper"] },
    ],
  },
}`;
    const settings = agentSettingsOf(agentsOf(text));
    expect(settings.catalog).toEqual([
      { id: "helper", executables: ["helper", "helper-cli"], packages: ["@me/helper"] },
    ]);
    expect(settings.scanIntervalMs).toBe(5000);
    expect(agentSettingsOf(agentsOf('{ "agents": { "catalog": [] } }')).catalog).toEqual([]);
  });

  it("can be turned off", () => {
    expect(agentSettingsOf(agentsOf('{ "agents": { "enabled": false } }')).enabled).toBe(false);
  });

  it("falls back to the default interval for one that is not usable", () => {
    for (const seconds of [Number.NaN, 0, -1, 0.5, Number.POSITIVE_INFINITY]) {
      expect(agentSettingsOf({ scanSeconds: seconds }).scanIntervalMs).toBe(3000);
    }
    expect(agentSettingsOf({ scanSeconds: 1 }).scanIntervalMs).toBe(1000);
  });

  it("refuses an interval under one second, with the line", () => {
    const [error] = errorsOf('{\n  "agents": {\n    "scanSeconds": 0\n  }\n}');
    expect(error?.path).toBe("agents.scanSeconds");
    expect(error?.line).toBe(3);
  });

  it("refuses an id used twice, at the second one", () => {
    const text = `{
  "agents": { "catalog": [
    { "id": "tool", "executables": ["tool"] },
    { "id": "tool", "executables": ["other"] }
  ] }
}`;
    const [error] = errorsOf(text);
    expect(error?.path).toBe("agents.catalog[1].id");
    expect(error?.message).toContain("used by another agent");
    expect(error?.line).toBe(4);
  });

  it("refuses an executable that two agents claim, whatever its case or ending", () => {
    const text = `{ "agents": { "catalog": [
      { "id": "one", "executables": ["tool"] },
      { "id": "two", "executables": ["Tool.EXE"] }
    ] } }`;
    const [error] = errorsOf(text);
    expect(error?.path).toBe("agents.catalog[1].executables[0]");
    expect(error?.message).toContain('already belongs to the agent "one"');
  });

  it("refuses what is not a catalog", () => {
    const bad: Record<string, string> = {
      "no executables": '{ "id": "a", "executables": [] }',
      "a path as executable": '{ "id": "a", "executables": ["/usr/bin/a"] }',
      "a space in an executable": '{ "id": "a", "executables": ["my tool"] }',
      "an upper case id": '{ "id": "Claude", "executables": ["claude"] }',
      "a blank id": '{ "id": "", "executables": ["a"] }',
      "no id": '{ "executables": ["a"] }',
      "a setting that is not one": '{ "id": "a", "executables": ["a"], "icon": "x" }',
      "a package that is not a name": '{ "id": "a", "executables": ["a"], "packages": ["a b"] }',
      "a long name": `{ "id": "a", "executables": ["${"x".repeat(65)}"] }`,
    };
    for (const [name, entry] of Object.entries(bad)) {
      const errors = errorsOf(`{ "agents": { "catalog": [${entry}] } }`);
      expect(errors.length, name).toBeGreaterThan(0);
      expect(errors[0]?.path, name).toMatch(/^agents\.catalog/);
    }
    expect(errorsOf('{ "agents": { "catalog": {} } }').length).toBeGreaterThan(0);
  });

  it("refuses too many agents", () => {
    const entries = Array.from({ length: 65 }, (_, n) => ({ id: `a${n}`, executables: [`a${n}`] }));
    expect(AgentCatalogSchema.safeParse(entries).success).toBe(false);
    expect(AgentCatalogSchema.safeParse(entries.slice(0, 64)).success).toBe(true);
  });

  it("is in the generated JSON Schema", () => {
    const properties = (configJsonSchema() as { properties: Record<string, unknown> }).properties;
    expect(properties.agents).toBeDefined();
  });
});

const catalog: AgentCatalog = [
  { id: "claude", executables: ["claude"] },
  { id: "codex", executables: ["codex"] },
  { id: "aider", executables: ["aider"], packages: ["aider"] },
  { id: "helper", executables: ["helper"], packages: ["@me/helper"] },
];

describe("detectAgentByCommand", () => {
  it("finds the agent by the name of the program", () => {
    expect(detectAgentByCommand("claude", catalog)).toBe("claude");
    expect(detectAgentByCommand("codex", catalog)).toBe("codex");
  });

  it("ignores the arguments", () => {
    expect(detectAgentByCommand("claude --resume fix the build", catalog)).toBe("claude");
    expect(detectAgentByCommand('codex "explain this" --model x', catalog)).toBe("codex");
  });

  it("ignores the folder, in either kind of slash", () => {
    expect(detectAgentByCommand("/usr/local/bin/claude -p hi", catalog)).toBe("claude");
    expect(detectAgentByCommand("./node_modules/.bin/codex", catalog)).toBe("codex");
    expect(detectAgentByCommand("C:\\Tools\\claude.exe --help", catalog)).toBe("claude");
    expect(detectAgentByCommand('"C:\\Program Files\\Tools\\claude.exe" --help', catalog)).toBe(
      "claude",
    );
    expect(detectAgentByCommand("& 'C:\\Tools\\codex.exe'", catalog)).toBe("codex");
  });

  it("ignores .exe, .cmd, .bat and the case", () => {
    for (const line of ["claude.exe", "CLAUDE.EXE", "Claude.cmd", "claude.bat", "claude.com"]) {
      expect(detectAgentByCommand(line, catalog), line).toBe("claude");
    }
  });

  it("matches whole names only", () => {
    for (const line of [
      "claudette",
      "claude-helper",
      "myclaude",
      "claud",
      "claude.sh",
      "claude.exe.bak",
      "echo claude",
      "git commit -m codex",
      "cat codex.txt",
      "man claude",
    ]) {
      expect(detectAgentByCommand(line, catalog), line).toBeUndefined();
    }
  });

  it("skips variables and the words that only run another command", () => {
    expect(detectAgentByCommand("ANTHROPIC_LOG=debug claude", catalog)).toBe("claude");
    expect(detectAgentByCommand("A=1 B='x y' codex", catalog)).toBe("codex");
    expect(detectAgentByCommand("sudo claude", catalog)).toBe("claude");
    expect(detectAgentByCommand("env FOO=1 codex --x", catalog)).toBe("codex");
    expect(detectAgentByCommand("time claude", catalog)).toBe("claude");
  });

  it("reads the first agent of a line of several commands", () => {
    expect(detectAgentByCommand("cd app && claude", catalog)).toBe("claude");
    expect(detectAgentByCommand("cd app; codex --x", catalog)).toBe("codex");
    expect(detectAgentByCommand("claude | tee log.txt", catalog)).toBe("claude");
    expect(detectAgentByCommand("echo hi || aider", catalog)).toBe("aider");
    expect(detectAgentByCommand("cd 'a && claude'", catalog)).toBeUndefined();
  });

  it("goes through a runner only for a package the catalog lists", () => {
    expect(detectAgentByCommand("npx @me/helper --yes", catalog)).toBe("helper");
    expect(detectAgentByCommand("npx -y @me/helper@1.2.3", catalog)).toBe("helper");
    expect(detectAgentByCommand("node ./node_modules/@me/helper/cli.js", catalog)).toBe("helper");
    expect(detectAgentByCommand("python -m aider --model x", catalog)).toBe("aider");
    expect(detectAgentByCommand("uvx aider", catalog)).toBe("aider");
    // Not listed, so not an agent.
    expect(detectAgentByCommand("npx some-other-tool", catalog)).toBeUndefined();
    expect(detectAgentByCommand("node server.js", catalog)).toBeUndefined();
    expect(detectAgentByCommand("python -m http.server", catalog)).toBeUndefined();
    // A name that only contains the package is not it.
    expect(detectAgentByCommand("npx my-aider-fork", catalog)).toBeUndefined();
    // A catalog without packages never matches a runner.
    expect(
      detectAgentByCommand("npx @me/helper", [{ id: "helper", executables: ["helper"] }]),
    ).toBe(undefined);
  });

  it("is undefined for nothing, blanks and an empty catalog", () => {
    expect(detectAgentByCommand(undefined, catalog)).toBeUndefined();
    expect(detectAgentByCommand("", catalog)).toBeUndefined();
    expect(detectAgentByCommand("   ", catalog)).toBeUndefined();
    expect(detectAgentByCommand("claude", [])).toBeUndefined();
  });

  it("follows a catalog of your own", () => {
    const own: AgentCatalog = [{ id: "mine", executables: ["mine-cli"] }];
    expect(detectAgentByCommand("mine-cli run", own)).toBe("mine");
    expect(detectAgentByCommand("claude", own)).toBeUndefined();
  });

  it("never throws and only answers an id of the catalog", () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        const found = detectAgentByCommand(line, catalog);
        expect(found === undefined || catalog.some((entry) => entry.id === found)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe("programName and mentionsPackage", () => {
  it("take the file name without folder and launcher ending", () => {
    expect(programName("C:\\Tools\\Claude.EXE")).toBe("claude");
    expect(programName("/usr/bin/codex")).toBe("codex");
    expect(programName(".exe")).toBe(".exe");
    expect(programName("")).toBe("");
  });

  it("match a package by whole segments", () => {
    expect(mentionsPackage("aider", "aider")).toBe(true);
    expect(mentionsPackage("aider@1.2.3", "aider")).toBe(true);
    expect(mentionsPackage("C:\\npm\\node_modules\\aider\\cli.js", "aider")).toBe(true);
    expect(mentionsPackage("/x/node_modules/@scope/tool/bin.js", "@scope/tool")).toBe(true);
    expect(mentionsPackage("my-aider-fork", "aider")).toBe(false);
    expect(mentionsPackage("/x/aiderish/cli.js", "aider")).toBe(false);
    expect(mentionsPackage("", "aider")).toBe(false);
    expect(mentionsPackage("aider", " ")).toBe(false);
  });
});

describe("resolveAgent", () => {
  it("lets the command win over the process tree when both know", () => {
    expect(resolveAgent("claude", "codex")).toBe("claude");
  });

  it("falls back to the tree, and to nothing", () => {
    expect(resolveAgent(undefined, "codex")).toBe("codex");
    expect(resolveAgent("claude", undefined)).toBe("claude");
    expect(resolveAgent(undefined, undefined)).toBeUndefined();
  });
});
