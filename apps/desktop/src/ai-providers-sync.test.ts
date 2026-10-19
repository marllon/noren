import { describe, expect, it } from "vitest";
import { ConfigManager, FakeBackend } from "@noren/model";
import type { AiProviderConfig } from "@noren/model";
import { AiProvidersSync } from "./ai-providers-sync";

// The providers of the file reach the backend (`ai.configure`) when the settings are first in
// force and when the list changes, in order, and a refusal is told without stopping anything.

const work: AiProviderConfig = {
  id: "work",
  kind: "openai-compatible",
  baseUrl: "https://llm.example.com/v1",
  model: "big",
};
const spare: AiProviderConfig = {
  id: "spare",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com",
  model: "small",
};

const fileWith = (providers: readonly AiProviderConfig[], extra = ""): string =>
  `{ "ai": { "providers": ${JSON.stringify(providers)} }${extra} }`;

/** The lists the fake backend was handed, in order. */
const handed = (fake: FakeBackend): unknown[] =>
  fake.callsTo("ai.configure").map((call) => call.args[0]);

async function started(text: string | null) {
  const fake = new FakeBackend({ config: text });
  const manager = new ConfigManager();
  await manager.start(fake);
  const sync = new AiProvidersSync();
  sync.follow(manager, fake.ai);
  await sync.settled();
  return { fake, manager, sync };
}

describe("handing the providers of the file to the backend", () => {
  it("hands them over once the settings are in force", async () => {
    const { fake } = await started(fileWith([work]));
    expect(handed(fake)).toEqual([[work]]);
    expect((await fake.ai.providers()).map((provider) => provider.id)).toEqual(["ollama", "work"]);
  });

  it("hands over an empty list when the file lists none, or there is no file", async () => {
    expect(handed((await started(null)).fake)).toEqual([[]]);
    expect(handed((await started("{}")).fake)).toEqual([[]]);
  });

  it("hands over the new list when the file changes it, and not when another setting changes", async () => {
    const { fake, sync } = await started(fileWith([work]));

    fake.setConfig(fileWith([work, spare]));
    await sync.settled();
    expect(handed(fake)).toEqual([[work], [work, spare]]);

    // Another setting, and a comment: the list is the same, so nothing is handed over.
    fake.setConfig(fileWith([work, spare], `, "notifications": { "enabled": false } // quiet`));
    await sync.settled();
    expect(handed(fake)).toHaveLength(2);

    fake.setConfig(fileWith([]));
    await sync.settled();
    expect(handed(fake)).toEqual([[work], [work, spare], []]);
  });

  it("hands over the list when the settings screen writes it (an update of the manager)", async () => {
    const { fake, manager, sync } = await started(fileWith([work]));
    const result = await manager.update([{ path: ["ai", "providers"], append: [spare] }]);
    expect(result.ok).toBe(true);
    await sync.settled();
    expect(handed(fake).at(-1)).toEqual([work, spare]);
  });

  it("keeps the last valid list when the file turns invalid, and hands nothing over", async () => {
    const { fake, sync } = await started(fileWith([work]));
    fake.setConfig("{ not json");
    await sync.settled();
    expect(handed(fake)).toEqual([[work]]);
    expect(sync.error).toBeUndefined();
  });

  it("stops handing over when the follow is stopped", async () => {
    const fake = new FakeBackend({ config: fileWith([work]) });
    const manager = new ConfigManager();
    await manager.start(fake);
    const sync = new AiProvidersSync();
    const stop = sync.follow(manager, fake.ai);
    await sync.settled();
    stop();
    fake.setConfig(fileWith([work, spare]));
    await sync.settled();
    expect(handed(fake)).toEqual([[work]]);
  });

  it("tells a refusal with its reason, never rejects, and takes the next list", async () => {
    const fake = new FakeBackend({ config: fileWith([work]) });
    const manager = new ConfigManager();
    await manager.start(fake);
    let refuse: string | undefined = "the Rust side did not like it";
    const calls: (readonly AiProviderConfig[])[] = [];
    const ai = {
      configure: (providers: readonly AiProviderConfig[]) => {
        calls.push(providers);
        return refuse === undefined ? Promise.resolve() : Promise.reject(new Error(refuse));
      },
    };
    const sync = new AiProvidersSync();
    let heard = 0;
    sync.subscribe(() => (heard += 1));
    sync.follow(manager, ai);
    await sync.settled();
    expect(sync.error).toContain("the Rust side did not like it");
    expect(heard).toBe(1);

    // The list that was refused is tried again at the next change of the file, and now it works.
    refuse = undefined;
    fake.setConfig(fileWith([work], `, "notifications": { "enabled": false }`));
    await sync.settled();
    expect(calls).toHaveLength(2);
    expect(sync.error).toBeUndefined();
    expect(heard).toBe(2);
  });

  it("goes on after a backend without an ai side", async () => {
    const manager = new ConfigManager();
    await manager.start(new FakeBackend({ config: fileWith([work]) }));
    const sync = new AiProvidersSync();
    sync.follow(manager, undefined as never);
    await sync.settled();
    expect(sync.error).toContain("The providers were not handed to the AI");
  });

  it("hands over in order: an older list never lands after a newer one", async () => {
    const fake = new FakeBackend({ config: fileWith([]) });
    const manager = new ConfigManager();
    await manager.start(fake);
    const landed: number[] = [];
    const ai = {
      configure: async (providers: readonly AiProviderConfig[]) => {
        // The first call is slow, the others quick.
        if (providers.length === 0) await new Promise((done) => setTimeout(done, 20));
        landed.push(providers.length);
      },
    };
    const sync = new AiProvidersSync();
    sync.follow(manager, ai);
    fake.setConfig(fileWith([work]));
    fake.setConfig(fileWith([work, spare]));
    await sync.settled();
    expect(landed).toEqual([0, 1, 2]);
  });
});
