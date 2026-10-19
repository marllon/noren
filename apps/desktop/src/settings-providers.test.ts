import { describe, expect, it } from "vitest";
import { editConfigText, parseConfigText } from "@noren/model";
import type { AiProviderConfig, Config } from "@noren/model";
import {
  NEW_PROVIDER,
  PROVIDER_ID_OLLAMA,
  PROVIDER_STEPS,
  connectionLine,
  needsSteps,
  ollamaLine,
  planAddProvider,
  planRemoveProvider,
  reasonWithout,
} from "./settings-providers";
import type { ProviderDraft } from "./settings-providers";

const COMMENTED = `// My Noren settings, keep this line.
{
  // The AI, careful.
  "ai": {
    "enabled": false, // off for now
    "providers": [
      // my work server
      { "id": "work", "kind": "openai-compatible", "baseUrl": "https://llm.example.com/v1", "model": "big" }, // keep
      { "id": "spare", "kind": "anthropic", "baseUrl": "https://api.anthropic.com", "model": "small" },
    ],
    "defaults": {
      "ask": { "provider": "work", "model": "big" },
      "command": { "provider": "work", "model": "big" },
      "explain": { "provider": "ollama", "model": "llama3" },
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

const draft = (patch: Partial<ProviderDraft>): ProviderDraft => ({
  ...NEW_PROVIDER,
  id: "my-openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-x",
  ...patch,
});

/** The file after adding `patch` over `text`, as the screen does it: the plan, the edit, the check. */
function added(text: string, patch: Partial<ProviderDraft>): string {
  const plan = planAddProvider(parsed(text), draft(patch));
  if (!plan.ok) throw new Error(JSON.stringify(plan.problems));
  const next = editConfigText(text, plan.edits);
  expect(parseConfigText(next).ok).toBe(true);
  return next;
}

describe("adding a provider", () => {
  it("appends it to the list of the file and leaves every comment where it was", () => {
    const next = added(COMMENTED, {});
    expect(next).toContain("// My Noren settings, keep this line.");
    expect(next).toContain("// The AI, careful.");
    expect(next).toContain('"enabled": false, // off for now');
    expect(next).toContain("// my work server");
    expect(next).toContain("}, // keep");
    expect(parsed(next).ai?.providers?.map((provider) => provider.id)).toEqual([
      "work",
      "spare",
      "my-openai",
    ]);
    expect(parsed(next).ai?.providers?.[2]).toEqual({
      id: "my-openai",
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-x",
    });
    expect(parsed(next).ai?.defaults).toEqual(parsed(COMMENTED).ai?.defaults);
  });

  it("makes the list, and the ai section, when the file has none", () => {
    const next = added('// Mine.\n{\n  "notifications": { "enabled": true }, // quiet\n}\n', {
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
    });
    expect(next).toContain("// Mine.");
    expect(next).toContain("// quiet");
    expect(parsed(next).ai?.providers).toEqual([
      {
        id: "my-openai",
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "gpt-x",
      },
    ]);
    expect(added("", {})).toContain('"providers"');
  });

  it("drops the blanks around the boxes", () => {
    const plan = planAddProvider(
      {},
      draft({ id: "  my-openai ", baseUrl: " https://x.test/v1  ", model: " m " }),
    );
    expect(plan.ok && plan.provider).toEqual({
      id: "my-openai",
      kind: "openai-compatible",
      baseUrl: "https://x.test/v1",
      model: "m",
    });
  });

  it("refuses an id the file already uses, with the reason under the id box", () => {
    const plan = planAddProvider(parsed(COMMENTED), draft({ id: "work" }));
    expect(plan).toMatchObject({ ok: false, problems: { id: expect.stringContaining("work") } });
    expect(plan.ok).toBe(false);
  });

  it("refuses the id ollama and a blank or badly written id", () => {
    expect(planAddProvider({}, draft({ id: "ollama" }))).toEqual({
      ok: false,
      problems: { id: PROVIDER_ID_OLLAMA },
    });
    for (const id of ["", "   ", "My Server", "-dash", "A", "a/b"]) {
      const plan = planAddProvider({}, draft({ id }));
      expect(plan.ok).toBe(false);
      expect(!plan.ok && plan.problems.id).toBeTruthy();
    }
  });

  it("refuses an address that is not an http or https one, with the reason under its box", () => {
    for (const baseUrl of [
      "",
      "localhost:11434",
      "ftp://host/v1",
      "file:///etc/hosts",
      "https://me:secret@host/v1",
      "https://",
      "https://a b/v1",
    ]) {
      const plan = planAddProvider({}, draft({ baseUrl }));
      expect(plan.ok).toBe(false);
      expect(!plan.ok && plan.problems.baseUrl).toBeTruthy();
      expect(!plan.ok && Object.keys(plan.problems)).toEqual(["baseUrl"]);
    }
  });

  it("refuses a blank model", () => {
    for (const model of ["", "   "]) {
      const plan = planAddProvider({}, draft({ model }));
      expect(plan.ok).toBe(false);
      expect(!plan.ok && plan.problems.model).toBeTruthy();
    }
  });

  it("tells every box that is wrong at once", () => {
    const plan = planAddProvider({}, NEW_PROVIDER);
    expect(!plan.ok && Object.keys(plan.problems).sort()).toEqual(["baseUrl", "id", "model"]);
  });

  it("refuses a list with too many providers", () => {
    const many: AiProviderConfig[] = Array.from({ length: 50 }, (_, index) => ({
      id: `p${index}`,
      kind: "openai-compatible",
      baseUrl: "https://x.test/v1",
      model: "m",
    }));
    const plan = planAddProvider({ ai: { providers: many } }, draft({}));
    expect(plan).toMatchObject({ ok: false, problems: { form: expect.stringContaining("50") } });
  });

  it("never writes a key: the form has no box for one, and a key slipped in is not copied", () => {
    const key = "sk-test-0123456789abcdef";
    const slipped = { ...draft({}), apiKey: key, key } as ProviderDraft;
    const plan = planAddProvider(parsed(COMMENTED), slipped);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(JSON.stringify(plan)).not.toContain(key);
    expect(editConfigText(COMMENTED, plan.edits)).not.toContain(key);
    expect(Object.keys(plan.provider).sort()).toEqual(["baseUrl", "id", "kind", "model"]);
  });

  it("refuses a key typed into the address, so it does not end up in the file", () => {
    const plan = planAddProvider({}, draft({ baseUrl: "https://user:sk-secret@host/v1" }));
    expect(plan.ok).toBe(false);
  });
});

describe("removing a provider", () => {
  it("takes only its entry out and leaves the other and the comments", () => {
    const text = COMMENTED.replace(/ {4}"defaults": \{[\s\S]*?\n {4}\},\n/, "");
    expect(parsed(text).ai?.defaults).toBeUndefined();
    const plan = planRemoveProvider(parsed(text), "spare");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const next = editConfigText(text, plan.edits);
    expect(parseConfigText(next).ok).toBe(true);
    expect(parsed(next).ai?.providers?.map((provider) => provider.id)).toEqual(["work"]);
    expect(next).toContain("// my work server");
    expect(next).toContain("}, // keep");
    expect(next).toContain("// The AI, careful.");
    expect(next).not.toContain("spare");
  });

  it("refuses a provider that a function uses, and names the functions", () => {
    const plan = planRemoveProvider(parsed(COMMENTED), "work");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain('"work"');
    expect(plan.reason).toContain("Ask and Command");
    expect(plan.reason).not.toContain("Explain");
  });

  it("says it for a single function in the singular", () => {
    const config = parsed(
      COMMENTED.replace('"command": { "provider": "work"', '"command": { "provider": "spare"'),
    );
    const plan = planRemoveProvider(config, "spare");
    expect(!plan.ok && plan.reason).toContain("Command");
    expect(!plan.ok && plan.reason).toContain("for it");
  });

  it("refuses an id the file does not list", () => {
    expect(planRemoveProvider({}, "nope")).toEqual({
      ok: false,
      reason: '"nope" is not in the file.',
    });
    expect(planRemoveProvider(parsed(COMMENTED), "ollama").ok).toBe(false);
  });
});

describe("what the screen says", () => {
  it("tells what was found of Ollama", () => {
    expect(ollamaLine(undefined)).toContain("Looking");
    expect(ollamaLine({ found: false })).toContain("not found");
    expect(ollamaLine({ found: true, models: [] })).toContain("no model");
    expect(ollamaLine({ found: true, models: ["a"] })).toContain("1 model");
    expect(ollamaLine({ found: true, models: ["a", "b"] })).toContain("2 models");
  });

  it("shows the steps only when no provider can answer", () => {
    const listed = parsed(COMMENTED);
    expect(needsSteps({}, undefined)).toBe(false);
    expect(needsSteps({}, { found: false })).toBe(true);
    expect(needsSteps({}, { found: true, models: [] })).toBe(true);
    expect(needsSteps({}, { found: true, models: ["llama3"] })).toBe(false);
    expect(needsSteps(listed, { found: false })).toBe(false);
    expect(needsSteps({ ai: { providers: [] } }, { found: false })).toBe(true);
    expect(PROVIDER_STEPS.length).toBe(3);
  });

  it("tells a connection test in a sentence", () => {
    expect(connectionLine({ ok: true })).toBe("The connection works.");
    expect(connectionLine({ ok: false, kind: "auth", message: "the key was rejected" })).toBe(
      "The connection failed: the key was rejected",
    );
  });

  it("takes a key out of the reason of a failure", () => {
    expect(reasonWithout(new Error("bad key sk-1234 here"), "sk-1234")).toBe("bad key [key] here");
    expect(reasonWithout("plain", "")).toBe("plain");
  });
});
