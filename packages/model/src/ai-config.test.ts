import { describe, expect, it } from "vitest";
import {
  AI_FUNCTIONS,
  MAX_AI_PROVIDERS,
  OLLAMA_PROVIDER_ID,
  aiProvidersProblem,
  isHttpAddress,
} from "./ai";
import { configJsonSchema, describeConfigError, parseConfigText } from "./config";
import type { Config } from "./config";

// The `ai` key of `config.jsonc`: the switch (off unless the file says so), the providers of the
// user (Ollama is always there and cannot be listed) and the provider and model each function uses.

/** The errors of a text, one line each, or an empty list when it is valid. */
function problems(text: string): string[] {
  const parsed = parseConfigText(text);
  return parsed.ok ? [] : parsed.errors.map(describeConfigError);
}

function config(text: string): Config {
  const parsed = parseConfigText(text);
  if (!parsed.ok) throw new Error(parsed.errors.map(describeConfigError).join("; "));
  return parsed.config;
}

const OPENAI = {
  id: "my-openai",
  kind: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};
const CLAUDE = {
  id: "claude",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
};

/** The text of a file with `ai` set to `ai`. */
const withAi = (ai: unknown): string => JSON.stringify({ ai }, null, 2);

describe("the ai key of config.jsonc", () => {
  it("is optional: a file without it, or with an empty one, says nothing about the AI", () => {
    expect(config("{}")).toEqual({});
    expect(config('{ "ai": {} }')).toEqual({ ai: {} });
  });

  it("holds the switch, the providers and the defaults of each function", () => {
    const ai = {
      enabled: true,
      providers: [OPENAI, CLAUDE],
      defaults: {
        ask: { provider: "claude", model: "claude-sonnet-4-5" },
        explain: { provider: "my-openai", model: "gpt-4o-mini" },
        command: { provider: "ollama", model: "llama3.2" },
      },
    };
    expect(config(withAi(ai))).toEqual({ ai });
  });

  it("reads the comments and the trailing commas of the file around it", () => {
    const text = `{
      // The AI stays off until this is true.
      "ai": {
        "enabled": false,
        "providers": [
          { "id": "local", "kind": "openai-compatible", "baseUrl": "http://localhost:1234/v1", "model": "m", },
        ],
      },
    }`;
    expect(config(text).ai?.providers?.[0]?.id).toBe("local");
  });

  it("accepts the address of a machine on the network, over http or https", () => {
    for (const baseUrl of [
      "http://localhost:11434/v1",
      "http://192.168.1.20:8000/v1",
      "https://openrouter.ai/api/v1",
      "http://[::1]:11434/v1",
    ]) {
      expect(problems(withAi({ providers: [{ ...OPENAI, baseUrl }] })), baseUrl).toEqual([]);
    }
  });

  it("refuses a switch that is not true or false", () => {
    for (const enabled of ["yes", 1, null]) {
      expect(problems(withAi({ enabled })), JSON.stringify(enabled)).not.toEqual([]);
    }
  });

  it("refuses a kind the client does not speak, at the line of the kind", () => {
    const text = `{
  "ai": {
    "providers": [
      { "id": "g", "kind": "gemini", "baseUrl": "https://example.com", "model": "m" }
    ]
  }
}`;
    const [first, ...others] = problems(text);
    expect(first).toMatch(/^line 4, column \d+: ai\.providers\[0\]\.kind: /);
    expect(others).toEqual([]);
  });

  it("refuses an id that is not lower case letters, digits, hyphens and underscores", () => {
    for (const id of [
      "",
      "My-OpenAI",
      "my openai",
      "a/b",
      "../x",
      "-x",
      "_x",
      "é",
      "a".repeat(65),
    ]) {
      expect(problems(withAi({ providers: [{ ...OPENAI, id }] })), JSON.stringify(id)).not.toEqual(
        [],
      );
    }
    for (const id of ["a", "0", "my_openai", "work-2", "a".repeat(64)]) {
      expect(problems(withAi({ providers: [{ ...OPENAI, id }] })), id).toEqual([]);
    }
  });

  it("refuses an address that is not http or https with a host", () => {
    for (const baseUrl of [
      "",
      "   ",
      "localhost:11434",
      "ftp://example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "http://",
      "https:///v1",
      "HTTP://example.com",
      "http://exa mple.com",
      `https://example.com/${"a".repeat(2100)}`,
    ]) {
      expect(
        problems(withAi({ providers: [{ ...OPENAI, baseUrl }] })),
        baseUrl.slice(0, 40),
      ).not.toEqual([]);
    }
  });

  it("refuses a user name or password in the address: a secret does not belong in the file", () => {
    for (const baseUrl of ["https://me:secret@example.com/v1", "https://token@example.com"]) {
      const [first] = problems(withAi({ providers: [{ ...OPENAI, baseUrl }] }));
      expect(first, baseUrl).toMatch(/ai\.providers\[0\]\.baseUrl: .*no user name or password/);
    }
  });

  it("refuses a provider without a model, or with a blank one", () => {
    expect(problems(withAi({ providers: [{ ...OPENAI, model: "" }] }))).not.toEqual([]);
    expect(problems(withAi({ providers: [{ ...OPENAI, model: "   " }] }))).not.toEqual([]);
    const without = { id: OPENAI.id, kind: OPENAI.kind, baseUrl: OPENAI.baseUrl };
    expect(problems(withAi({ providers: [without] }))).not.toEqual([]);
  });

  it("refuses an id used twice, at the second one", () => {
    const text = `{
  "ai": {
    "providers": [
      { "id": "a", "kind": "anthropic", "baseUrl": "https://example.com", "model": "m" },
      { "id": "b", "kind": "anthropic", "baseUrl": "https://example.com", "model": "m" },
      { "id": "a", "kind": "anthropic", "baseUrl": "https://example.com", "model": "m" }
    ]
  }
}`;
    const [first, ...others] = problems(text);
    expect(first).toMatch(
      /^line 6, column \d+: ai\.providers\[2\]\.id: The id "a" is used by another provider/,
    );
    expect(others).toEqual([]);
  });

  it("refuses the id ollama: that provider is Noren's own and always there", () => {
    const [first, ...others] = problems(
      withAi({ providers: [{ ...OPENAI, id: OLLAMA_PROVIDER_ID }] }),
    );
    expect(first).toMatch(/ai\.providers\[0\]\.id: The id "ollama" is reserved/);
    expect(others).toEqual([]);
  });

  it("refuses more providers than MAX_AI_PROVIDERS", () => {
    const many = Array.from({ length: MAX_AI_PROVIDERS + 1 }, (_, i) => ({
      ...OPENAI,
      id: `p${i}`,
    }));
    expect(problems(withAi({ providers: many }))).not.toEqual([]);
    expect(problems(withAi({ providers: many.slice(0, MAX_AI_PROVIDERS) }))).toEqual([]);
  });

  it("refuses a key, or any setting the schema does not know, in a provider or in ai", () => {
    for (const extra of ["apiKey", "key", "token", "secret"]) {
      const [first] = problems(withAi({ providers: [{ ...OPENAI, [extra]: "sk-123" }] }));
      expect(first, extra).toContain(`Unknown setting "${extra}"`);
    }
    expect(problems(withAi({ apiKey: "sk-123" }))[0]).toContain('Unknown setting "apiKey"');
    expect(
      problems(withAi({ defaults: { chat: { provider: "ollama", model: "m" } } }))[0],
    ).toContain('Unknown setting "chat"');
  });

  it("refuses a value that is not a list of providers", () => {
    expect(problems(withAi({ providers: "my-openai" }))).not.toEqual([]);
    expect(problems(withAi({ providers: { id: "a" } }))).not.toEqual([]);
    expect(problems(withAi({ providers: [] }))).toEqual([]);
  });
});

describe("ai.defaults", () => {
  it("names a provider and a model for each function", () => {
    for (const fn of AI_FUNCTIONS) {
      const text = withAi({
        providers: [OPENAI],
        defaults: { [fn]: { provider: "my-openai", model: "gpt-4o-mini" } },
      });
      expect(config(text).ai?.defaults?.[fn], fn).toEqual({
        provider: "my-openai",
        model: "gpt-4o-mini",
      });
    }
  });

  it("can name ollama without listing it: it is always there", () => {
    expect(
      problems(withAi({ defaults: { ask: { provider: "ollama", model: "llama3.2" } } })),
    ).toEqual([]);
  });

  it("refuses a provider that is neither ollama nor listed, at the line of the provider", () => {
    const text = `{
  "ai": {
    "providers": [
      { "id": "a", "kind": "anthropic", "baseUrl": "https://example.com", "model": "m" }
    ],
    "defaults": {
      "explain": { "provider": "typo", "model": "m" }
    }
  }
}`;
    const [first, ...others] = problems(text);
    expect(first).toMatch(
      /^line 7, column \d+: ai\.defaults\.explain\.provider: The provider "typo" is not "ollama" and is not listed in ai\.providers/,
    );
    expect(others).toEqual([]);
  });

  it("refuses a default without a model or without a provider", () => {
    expect(problems(withAi({ defaults: { ask: { provider: "ollama" } } }))).not.toEqual([]);
    expect(problems(withAi({ defaults: { ask: { model: "m" } } }))).not.toEqual([]);
    expect(problems(withAi({ defaults: { ask: { provider: "ollama", model: " " } } }))).not.toEqual(
      [],
    );
    expect(problems(withAi({ defaults: { ask: { provider: "", model: "m" } } }))).not.toEqual([]);
  });
});

describe("aiProvidersProblem", () => {
  it("accepts a list that matches the schema, and an empty one", () => {
    expect(aiProvidersProblem([])).toBeUndefined();
    expect(aiProvidersProblem([OPENAI, CLAUDE])).toBeUndefined();
  });

  it("says in a sentence what is wrong with the first bad provider", () => {
    expect(aiProvidersProblem([OPENAI, { ...CLAUDE, kind: "gemini" }])).toMatch(
      /^Provider 2: kind: /,
    );
    expect(aiProvidersProblem([{ ...OPENAI, baseUrl: "ftp://x" }])).toMatch(
      /^Provider 1: baseUrl: Must start with http/,
    );
    expect(aiProvidersProblem([OPENAI, { ...CLAUDE, id: OPENAI.id }])).toBe(
      'Provider 2: the id "my-openai" is used by another provider',
    );
    expect(aiProvidersProblem([{ ...OPENAI, id: "ollama" }])).toBe(
      'Provider 1: the id "ollama" is reserved',
    );
  });

  it("refuses a provider that carries a key, or anything the schema does not know", () => {
    expect(aiProvidersProblem([{ ...OPENAI, apiKey: "sk-123" }])).toMatch(/^Provider 1: /);
    expect(aiProvidersProblem([{ ...OPENAI, key: "sk-123" }])).toMatch(/^Provider 1: /);
  });

  it("refuses too many providers, and anything that is not a provider, without throwing", () => {
    const many = Array.from({ length: MAX_AI_PROVIDERS + 1 }, (_, i) => ({
      ...OPENAI,
      id: `p${i}`,
    }));
    expect(aiProvidersProblem(many)).toBe(`There are more than ${MAX_AI_PROVIDERS} providers`);
    for (const bad of [null, undefined, 3, "x", [], {}]) {
      expect(aiProvidersProblem([bad]), JSON.stringify(bad)).toMatch(/^Provider 1: /);
    }
  });
});

describe("isHttpAddress", () => {
  it("takes http and https addresses that name a host and nothing else", () => {
    for (const good of [
      "http://localhost:11434/v1",
      "https://api.openai.com/v1",
      " https://api.anthropic.com ",
      "http://127.0.0.1:8080",
      "https://openrouter.ai/api/v1?x=1#y",
    ]) {
      expect(isHttpAddress(good), good).toBe(true);
    }
    for (const bad of [
      "",
      "localhost:11434",
      "ftp://example.com",
      "file:///etc/passwd",
      "http://",
      "https:///path",
      "http://user:pass@example.com",
      "http://example.com/\nx",
      "http://exa mple.com",
    ]) {
      expect(isHttpAddress(bad), bad).toBe(false);
    }
  });
});

describe("docs/config.schema.json for the ai key", () => {
  type Node = {
    default?: unknown;
    enum?: string[];
    items?: Node;
    properties?: Record<string, Node>;
  };
  const ai = (configJsonSchema() as { properties: { ai: Node } }).properties.ai;

  it("says the AI is off unless the file says so", () => {
    expect(ai.properties?.["enabled"]?.default).toBe(false);
  });

  it("lists the two kinds of provider and the three functions", () => {
    expect(ai.properties?.["providers"]?.items?.properties?.["kind"]?.enum).toEqual([
      "openai-compatible",
      "anthropic",
    ]);
    expect(Object.keys(ai.properties?.["defaults"]?.properties ?? {})).toEqual([
      "ask",
      "explain",
      "command",
    ]);
  });

  it("has no room for a key in a provider", () => {
    const provider = ai.properties?.["providers"]?.items as
      { additionalProperties?: boolean; properties?: Record<string, unknown> } | undefined;
    expect(provider?.additionalProperties).toBe(false);
    expect(Object.keys(provider?.properties ?? {}).sort()).toEqual([
      "baseUrl",
      "id",
      "kind",
      "model",
    ]);
  });
});
