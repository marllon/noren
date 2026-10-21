import { describe, expect, it } from "vitest";
import type { AiProviderConfig } from "./ai";
import { FakeBackend } from "./fake-backend";

// The AI side of the fake backend: a fake Ollama, the providers of the settings handed over with
// `ai.configure`, a fake keychain whose keys never show in what the interface reads, and a
// connection test that is ok or fails the way the real one does.

const KEY = "sk-test-0123456789abcdef";

const OPENAI: AiProviderConfig = {
  id: "my-openai",
  kind: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};
const CLAUDE: AiProviderConfig = {
  id: "claude",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
};

describe("FakeBackend ai.listOllamaModels", () => {
  it("lists the models of the fake Ollama it was given", async () => {
    const backend = new FakeBackend({ ollamaModels: ["llama3.2:latest", "qwen2.5-coder:7b"] });
    await expect(backend.ai.listOllamaModels()).resolves.toEqual({
      found: true,
      models: ["llama3.2:latest", "qwen2.5-coder:7b"],
    });
  });

  it("finds an Ollama with no model as found and empty", async () => {
    const backend = new FakeBackend({ ollamaModels: [] });
    await expect(backend.ai.listOllamaModels()).resolves.toEqual({ found: true, models: [] });
  });

  it("finds no Ollama unless it was given models: most computers have none", async () => {
    await expect(new FakeBackend().ai.listOllamaModels()).resolves.toEqual({ found: false });
  });

  it("follows installing and removing Ollama, and hands out copies", async () => {
    const backend = new FakeBackend();
    backend.setOllamaModels(["a"]);
    const first = await backend.ai.listOllamaModels();
    expect(first).toEqual({ found: true, models: ["a"] });
    if (first.found) first.models.push("changed by the caller");
    await expect(backend.ai.listOllamaModels()).resolves.toEqual({ found: true, models: ["a"] });
    backend.setOllamaModels(null);
    await expect(backend.ai.listOllamaModels()).resolves.toEqual({ found: false });
  });
});

describe("FakeBackend ai.ollamaMemory", () => {
  it("says no model is loaded unless it was given a reading", async () => {
    await expect(new FakeBackend().ai.ollamaMemory("llama3.2")).resolves.toBeNull();
  });

  it("answers the reading it was given for any model, or one per model", async () => {
    const reading = { bytes: 2_000_000_000, vramBytes: 1_500_000_000 };
    const backend = new FakeBackend({ ollamaMemory: reading });
    await expect(backend.ai.ollamaMemory("a")).resolves.toEqual(reading);
    await expect(backend.ai.ollamaMemory("b")).resolves.toEqual(reading);
    backend.setOllamaMemory((model) => (model === "big" ? { bytes: 9, vramBytes: 0 } : null));
    await expect(backend.ai.ollamaMemory("big")).resolves.toEqual({ bytes: 9, vramBytes: 0 });
    await expect(backend.ai.ollamaMemory("small")).resolves.toBeNull();
    backend.setOllamaMemory(null);
    await expect(backend.ai.ollamaMemory("big")).resolves.toBeNull();
    expect(backend.callsTo("ai.ollamaMemory").map((call) => call.args)).toEqual([
      ["a"],
      ["b"],
      ["big"],
      ["small"],
      ["big"],
    ]);
  });

  it("hands out a copy, and takes a reading that is not whole numbers of 0 or more as none", async () => {
    const reading = { bytes: 5, vramBytes: 1 };
    const backend = new FakeBackend({ ollamaMemory: reading });
    const first = await backend.ai.ollamaMemory("m");
    if (first !== null) first.bytes = 99;
    await expect(backend.ai.ollamaMemory("m")).resolves.toEqual(reading);
    for (const bad of [
      { bytes: -1, vramBytes: 0 },
      { bytes: 1.5, vramBytes: 0 },
      { bytes: 1, vramBytes: Number.NaN },
      { bytes: Number.MAX_SAFE_INTEGER + 1, vramBytes: 0 },
    ]) {
      backend.setOllamaMemory(bad);
      await expect(backend.ai.ollamaMemory("m"), JSON.stringify(bad)).resolves.toBeNull();
    }
  });

  it("rejects when the function of the test throws", async () => {
    const backend = new FakeBackend({
      ollamaMemory: () => {
        throw new Error("boom");
      },
    });
    await expect(backend.ai.ollamaMemory("m")).rejects.toThrow("boom");
  });
});

describe("FakeBackend ai.providers and ai.configure", () => {
  it("lists only the pre-defined Ollama until the providers of the settings are handed over", async () => {
    const backend = new FakeBackend();
    await expect(backend.ai.providers()).resolves.toEqual([
      {
        id: "ollama",
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        model: "",
        hasKey: false,
      },
    ]);
  });

  it("lists the providers handed over after Ollama, in order, and replaces them as a whole", async () => {
    const backend = new FakeBackend();
    await backend.ai.configure([OPENAI, CLAUDE]);
    expect((await backend.ai.providers()).map((p) => p.id)).toEqual([
      "ollama",
      "my-openai",
      "claude",
    ]);
    await backend.ai.configure([CLAUDE]);
    expect((await backend.ai.providers()).map((p) => p.id)).toEqual(["ollama", "claude"]);
    await backend.ai.configure([]);
    expect((await backend.ai.providers()).map((p) => p.id)).toEqual(["ollama"]);
  });

  it("keeps the address and the model without the blanks around them, as the Rust side does", async () => {
    const backend = new FakeBackend();
    await backend.ai.configure([
      { ...OPENAI, baseUrl: " https://api.openai.com/v1 ", model: " m " },
    ]);
    const [, provider] = await backend.ai.providers();
    expect(provider).toMatchObject({ baseUrl: "https://api.openai.com/v1", model: "m" });
  });

  it("refuses a bad list whole, with the reason, and keeps the one it had", async () => {
    const backend = new FakeBackend();
    await backend.ai.configure([OPENAI]);
    const bad: [string, readonly unknown[], RegExp][] = [
      ["the id ollama", [{ ...CLAUDE, id: "ollama" }], /reserved/],
      ["a repeated id", [CLAUDE, { ...OPENAI, id: "claude" }], /used by another provider/],
      ["an unknown kind", [{ ...CLAUDE, kind: "gemini" }], /kind/],
      ["a file address", [{ ...CLAUDE, baseUrl: "file:///etc/passwd" }], /http/],
      ["a password in the address", [{ ...CLAUDE, baseUrl: "https://a:b@x.com" }], /user name/],
      ["a blank model", [{ ...CLAUDE, model: " " }], /model/],
      ["a bad id", [{ ...CLAUDE, id: "a/b" }], /id/],
      ["a key", [{ ...CLAUDE, apiKey: KEY }], /Provider 1/],
    ];
    for (const [what, list, reason] of bad) {
      const rejection = backend.ai.configure(list as AiProviderConfig[]);
      await expect(rejection, what).rejects.toThrow(reason);
      expect(
        (await backend.ai.providers()).map((p) => p.id),
        what,
      ).toEqual(["ollama", "my-openai"]);
    }
  });

  it("does not repeat a key that came with a provider in the reason it gives", async () => {
    const backend = new FakeBackend();
    const error = await backend.ai.configure([{ ...OPENAI, apiKey: KEY } as AiProviderConfig]).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(KEY);
  });
});

describe("FakeBackend ai.setKey", () => {
  it("tells hasKey for the provider that has one and never shows the key", async () => {
    const backend = new FakeBackend();
    await backend.ai.configure([OPENAI, CLAUDE]);
    await backend.ai.setKey("my-openai", KEY);
    const providers = await backend.ai.providers();
    expect(providers.map((p) => [p.id, p.hasKey])).toEqual([
      ["ollama", false],
      ["my-openai", true],
      ["claude", false],
    ]);
    // Nowhere in what the interface reads: not in the list, not as a field, not in the text.
    expect(JSON.stringify(providers)).not.toContain(KEY);
    expect(providers.every((p) => !("key" in p) && !("apiKey" in p))).toBe(true);
    // Nor in the record of the calls the test inspects.
    expect(JSON.stringify(backend.calls)).not.toContain(KEY);
    expect(backend.callsTo("ai.setKey")).toEqual([{ method: "ai.setKey", args: ["my-openai"] }]);
  });

  it("takes the blanks around a pasted key, and removes the key when it is blank", async () => {
    const backend = new FakeBackend();
    await backend.ai.configure([OPENAI]);
    await backend.ai.setKey("my-openai", `  ${KEY} \n`);
    expect(backend.storedAiKey("my-openai")).toBe(KEY);
    await backend.ai.setKey("my-openai", "   ");
    expect(backend.storedAiKey("my-openai")).toBeUndefined();
    expect((await backend.ai.providers())[1]?.hasKey).toBe(false);
    // Removing what is not there is fine.
    await expect(backend.ai.setKey("my-openai", "")).resolves.toBeUndefined();
  });

  it("keeps a key when the provider leaves the list, for when it comes back", async () => {
    const backend = new FakeBackend();
    await backend.ai.configure([OPENAI]);
    await backend.ai.setKey("my-openai", KEY);
    await backend.ai.configure([]);
    await backend.ai.configure([OPENAI]);
    expect((await backend.ai.providers())[1]?.hasKey).toBe(true);
  });

  it("can hold a key for Ollama, which does not need one", async () => {
    const backend = new FakeBackend();
    await backend.ai.setKey("ollama", KEY);
    expect((await backend.ai.providers())[0]?.hasKey).toBe(true);
  });

  it("starts with the keys it was given", async () => {
    const backend = new FakeBackend({ aiKeys: { claude: KEY } });
    await backend.ai.configure([CLAUDE]);
    expect((await backend.ai.providers())[1]?.hasKey).toBe(true);
  });

  it("refuses an id that is not a provider id and a key that is too long, without repeating the key", async () => {
    const backend = new FakeBackend();
    for (const id of ["", "a/b", "../x", "a b", "-x", "a".repeat(65)]) {
      await expect(backend.ai.setKey(id, KEY), JSON.stringify(id)).rejects.toThrow(/provider id/);
    }
    const tooLong = "k".repeat(1025);
    const error = await backend.ai.setKey("my-openai", tooLong).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(String((error as Error).message)).toContain("1024");
    expect(String((error as Error).message)).not.toContain(tooLong);
    expect(backend.storedAiKey("my-openai")).toBeUndefined();
  });
});

describe("FakeBackend ai.testConnection", () => {
  it("is ok for a provider of the settings with its key", async () => {
    const backend = new FakeBackend();
    await backend.ai.configure([OPENAI, CLAUDE]);
    await backend.ai.setKey("claude", KEY);
    await expect(backend.ai.testConnection("my-openai")).resolves.toEqual({ ok: true });
    await expect(backend.ai.testConnection("claude")).resolves.toEqual({ ok: true });
  });

  it("is ok for Ollama when it is there, and fails with a readable reason when it is not", async () => {
    const present = new FakeBackend({ ollamaModels: ["llama3.2"] });
    await expect(present.ai.testConnection("ollama")).resolves.toEqual({ ok: true });
    const absent = new FakeBackend();
    const result = await absent.ai.testConnection("ollama");
    expect(result).toMatchObject({ ok: false, kind: "network" });
    if (!result.ok) expect(result.message).toMatch(/could not reach the provider/);
  });

  it("fails for Anthropic without a key, before asking anyone, as the real one does", async () => {
    const backend = new FakeBackend();
    await backend.ai.configure([CLAUDE]);
    const result = await backend.ai.testConnection("claude");
    expect(result).toEqual({
      ok: false,
      kind: "invalid-request",
      message: "this provider needs an API key and none is set",
    });
    await backend.ai.setKey("claude", KEY);
    await expect(backend.ai.testConnection("claude")).resolves.toEqual({ ok: true });
  });

  it("answers what the test chose for the provider, and takes the key out of the text", async () => {
    const backend = new FakeBackend();
    await backend.ai.configure([OPENAI]);
    await backend.ai.setKey("my-openai", KEY);
    backend.setAiConnectionResult("my-openai", {
      ok: false,
      kind: "auth",
      message: `the provider rejected the API key (HTTP 401): Incorrect API key provided: ${KEY}`,
    });
    const result = await backend.ai.testConnection("my-openai");
    expect(result).toMatchObject({ ok: false, kind: "auth" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.message).toContain("HTTP 401");
    expect(result.message).toContain("[key]");
    expect(result.message).not.toContain(KEY);
    // Undone, it is ok again.
    backend.setAiConnectionResult("my-openai", undefined);
    await expect(backend.ai.testConnection("my-openai")).resolves.toEqual({ ok: true });
  });

  it("rejects, without testing anything, for an id that is not a provider id or a provider it does not have", async () => {
    const backend = new FakeBackend();
    await backend.ai.configure([OPENAI]);
    for (const id of ["", "a/b", "../x", "a b"]) {
      await expect(backend.ai.testConnection(id), JSON.stringify(id)).rejects.toThrow(
        /not a provider id/,
      );
    }
    await expect(backend.ai.testConnection("nobody")).rejects.toThrow(/no provider/);
    // A provider that left the list cannot be tested any more.
    await backend.ai.configure([]);
    await expect(backend.ai.testConnection("my-openai")).rejects.toThrow(/no provider/);
  });
});

describe("FakeBackend ai calls", () => {
  it("records each call under the name of its method, with the arguments but never the key", async () => {
    const backend = new FakeBackend({ ollamaModels: [] });
    await backend.ai.providers();
    await backend.ai.configure([OPENAI]);
    await backend.ai.setKey("my-openai", KEY);
    await backend.ai.listOllamaModels();
    await backend.ai.testConnection("my-openai");
    expect(backend.calls.map((call) => call.method)).toEqual([
      "ai.providers",
      "ai.configure",
      "ai.setKey",
      "ai.listOllamaModels",
      "ai.testConnection",
    ]);
    expect(backend.callsTo("ai.configure")[0]?.args).toEqual([[OPENAI]]);
    expect(backend.callsTo("ai.testConnection")[0]?.args).toEqual(["my-openai"]);
    expect(JSON.stringify(backend.calls)).not.toContain(KEY);
  });
});
