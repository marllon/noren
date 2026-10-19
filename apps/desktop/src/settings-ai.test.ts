import { describe, expect, it } from "vitest";
import { editConfigText, parseConfigText } from "@noren/model";
import type { Config } from "@noren/model";
import { hasProblems, planSave, shownSettings } from "./settings-screen";
import {
  AI_MODEL_MISSING,
  AI_PATHS,
  AI_PROVIDER_MISSING,
  DEFAULT_AI_VALUES,
  aiProviderIds,
  aiValuesOf,
  planAi,
  shownAi,
} from "./settings-sections";

const COMMENTED = `// My Noren settings, keep this line.
{
  // The AI, careful.
  "ai": {
    "enabled": false, // off for now
    "providers": [
      { "id": "work", "kind": "openai-compatible", "baseUrl": "https://llm.example.com/v1", "model": "big" },
    ],
    "defaults": {
      /* the Ask panel */
      "ask": { "provider": "ollama", "model": "llama3" }, // small
      "explain": { "provider": "work", "model": "big" },
    },
  },
  "notifications": { "enabled": true },
}
`;

function parsed(text: string): Config {
  const read = parseConfigText(text);
  if (!read.ok) throw new Error("the text of the test is not a valid file");
  return read.config;
}

/** The file after saving `draft` over `text`, as the screen does it: the plan, the edit, the check. */
function saved(text: string, draft: Parameters<typeof planSave>[1]): string {
  const plan = planSave(parsed(text), draft);
  const next = editConfigText(text, plan.changes);
  expect(parseConfigText(next).ok).toBe(true);
  return next;
}

describe("the AI settings in force", () => {
  it("are off with no default for a file that says nothing", () => {
    expect(aiValuesOf({})).toEqual(DEFAULT_AI_VALUES);
    expect(DEFAULT_AI_VALUES.enabled).toBe(false);
  });

  it("are what the file says", () => {
    expect(aiValuesOf(parsed(COMMENTED))).toEqual({
      enabled: false,
      ask: { provider: "ollama", model: "llama3" },
      explain: { provider: "work", model: "big" },
      command: { provider: "", model: "" },
    });
  });

  it("lists Ollama first, then the providers of the file", () => {
    expect(aiProviderIds({})).toEqual(["ollama"]);
    expect(aiProviderIds(parsed(COMMENTED))).toEqual(["ollama", "work"]);
  });

  it("show the draft over the file, a function at a time", () => {
    const config = parsed(COMMENTED);
    const shown = shownAi(config, {
      enabled: true,
      ask: { model: "phi" },
      command: { provider: "work" },
    });
    expect(shown).toEqual({
      enabled: true,
      ask: { provider: "ollama", model: "phi" },
      explain: { provider: "work", model: "big" },
      command: { provider: "work", model: "" },
    });
    expect(shownSettings(config, { ai: { enabled: true } }).ai.enabled).toBe(true);
  });

  it("keep each setting at a path of its own", () => {
    expect(AI_PATHS).toEqual({
      enabled: ["ai", "enabled"],
      ask: ["ai", "defaults", "ask"],
      explain: ["ai", "defaults", "explain"],
      command: ["ai", "defaults", "command"],
    });
  });
});

describe("planAi", () => {
  it("writes the switch only when it differs from the one in force", () => {
    expect(planAi({}, { enabled: true }).changes).toEqual([
      { path: ["ai", "enabled"], value: true },
    ]);
    expect(planAi({}, { enabled: false }).changes).toEqual([]);
    expect(planAi({}, undefined).changes).toEqual([]);
  });

  it("writes the provider and the model of a function that has none", () => {
    const plan = planAi({}, { ask: { provider: "ollama", model: "  llama3 " } });
    expect(plan.problems).toEqual({});
    expect(plan.changes).toEqual([
      { path: ["ai", "defaults", "ask", "provider"], value: "ollama" },
      { path: ["ai", "defaults", "ask", "model"], value: "llama3" },
    ]);
  });

  it("writes only the part of a function that differs from the file", () => {
    const config = parsed(COMMENTED);
    expect(planAi(config, { ask: { model: "phi" } }).changes).toEqual([
      { path: ["ai", "defaults", "ask", "model"], value: "phi" },
    ]);
    expect(planAi(config, { ask: { provider: "work" } }).changes).toEqual([
      { path: ["ai", "defaults", "ask", "provider"], value: "work" },
    ]);
    expect(planAi(config, { ask: { provider: "ollama", model: "llama3" } }).changes).toEqual([]);
  });

  it("takes a function out of the file when both of its boxes are emptied", () => {
    const config = parsed(COMMENTED);
    expect(planAi(config, { explain: { provider: "", model: "" } })).toEqual({
      changes: [{ path: ["ai", "defaults", "explain"], remove: true }],
      problems: {},
    });
    // A function the file does not have is left alone.
    expect(planAi(config, { command: { provider: "", model: "" } }).changes).toEqual([]);
  });

  it("refuses a model with no provider, and a provider with no model, and writes nothing", () => {
    const config = parsed(COMMENTED);
    const noModel = planAi(config, { command: { provider: "ollama" } });
    expect(noModel.problems.command).toEqual({ field: "model", message: AI_MODEL_MISSING });
    expect(noModel.changes).toEqual([]);
    const blankModel = planAi(config, { ask: { model: "   " } });
    expect(blankModel.problems.ask).toEqual({ field: "model", message: AI_MODEL_MISSING });
    expect(blankModel.changes).toEqual([]);
    const noProvider = planAi(config, { command: { model: "llama3" } });
    expect(noProvider.problems.command).toEqual({
      field: "provider",
      message: AI_PROVIDER_MISSING,
    });
    expect(noProvider.changes).toEqual([]);
  });

  it("refuses a provider the file does not list, with the words of the schema", () => {
    const plan = planAi(parsed(COMMENTED), { command: { provider: "ghost", model: "x" } });
    expect(plan.changes).toEqual([]);
    expect(plan.problems.command?.field).toBe("provider");
    expect(plan.problems.command?.message).toContain('"ghost"');
    // With no providers at all only Ollama exists.
    expect(planAi({}, { ask: { provider: "work", model: "x" } }).problems.ask?.field).toBe(
      "provider",
    );
  });

  it("refuses a model longer than the schema allows", () => {
    const plan = planAi({}, { ask: { provider: "ollama", model: "m".repeat(201) } });
    expect(plan.changes).toEqual([]);
    expect(plan.problems.ask?.field).toBe("model");
  });

  it("keeps the good functions of a draft that has a bad one in it, and reports the bad one", () => {
    const plan = planAi(
      {},
      {
        enabled: true,
        ask: { provider: "ollama", model: "llama3" },
        explain: { provider: "ollama" },
      },
    );
    expect(plan.changes.map((c) => c.path.join("."))).toEqual([
      "ai.enabled",
      "ai.defaults.ask.provider",
      "ai.defaults.ask.model",
    ]);
    expect(Object.keys(plan.problems)).toEqual(["explain"]);
  });

  it("makes a plan with problems that blocks saving", () => {
    const plan = planSave({}, { ai: { ask: { provider: "ollama" } } });
    expect(plan.changes).toEqual([]);
    expect(hasProblems(plan)).toBe(true);
  });
});

describe("saving the AI section into a file written by hand", () => {
  it("replaces the values the file has and keeps every comment", () => {
    const out = saved(COMMENTED, { ai: { enabled: true, ask: { model: "phi" } } });
    expect(out).toBe(
      COMMENTED.replace('"enabled": false, // off', '"enabled": true, // off').replace(
        '"model": "llama3" }, // small',
        '"model": "phi" }, // small',
      ),
    );
  });

  it("takes out the function that was emptied and keeps the comments around it", () => {
    const out = saved(COMMENTED, { ai: { explain: { provider: "", model: "" } } });
    expect(out).toContain("// The AI, careful.");
    expect(out).toContain("/* the Ask panel */");
    expect(out).toContain("// small");
    expect(out).not.toContain('"explain"');
    const config = parsed(out);
    expect(config.ai?.defaults).toEqual({ ask: { provider: "ollama", model: "llama3" } });
    expect(config.ai?.providers).toHaveLength(1);
  });

  it("creates only the section and the keys that were asked for in a file with no ai", () => {
    const text = '// only a comment\n{\n  "notifications": { "enabled": false }\n}\n';
    const turnedOn = saved(text, { ai: { enabled: true } });
    expect(turnedOn.startsWith("// only a comment")).toBe(true);
    expect(parsed(turnedOn)).toEqual({ ai: { enabled: true }, notifications: { enabled: false } });
    expect(turnedOn).not.toContain("defaults");
    expect(turnedOn).not.toContain("providers");

    const withAsk = saved(text, { ai: { ask: { provider: "ollama", model: "llama3" } } });
    expect(parsed(withAsk)).toEqual({
      ai: { defaults: { ask: { provider: "ollama", model: "llama3" } } },
      notifications: { enabled: false },
    });
    expect(withAsk).not.toContain('"enabled": true');
    expect(withAsk.indexOf('"notifications"')).toBeLessThan(withAsk.indexOf('"ai"'));
  });

  it("does not write when the draft only has a value the schema refuses", () => {
    const config = parsed(COMMENTED);
    const plan = planSave(config, { ai: { command: { provider: "ghost", model: "x" } } });
    expect(plan.changes).toEqual([]);
    expect(Object.keys(plan.aiProblems)).toEqual(["command"]);
  });

  it("builds a file from nothing when there is none", () => {
    const out = editConfigText(
      null,
      planSave({}, { ai: { enabled: true, ask: { provider: "ollama", model: "llama3" } } }).changes,
    );
    expect(parsed(out)).toEqual({
      ai: { enabled: true, defaults: { ask: { provider: "ollama", model: "llama3" } } },
    });
  });
});
