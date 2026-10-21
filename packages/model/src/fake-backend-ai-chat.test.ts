import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AiChatEvent, AiChatRequest, AiProviderConfig } from "./ai";
import { buildAskMessages } from "./ask-context";
import { DEFAULT_AI_REPLY, FakeBackend } from "./fake-backend";

// The chat side of the fake backend: a fake provider that answers in deltas, an end that comes once,
// `cancel` that ends a running request with `cancelled`, and the messages it was sent, recorded.

const KEY = "sk-" + "test-0123456789abcdef";
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

const request = (over: Partial<AiChatRequest> = {}): AiChatRequest => ({
  requestId: "r1",
  providerId: "ollama",
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

/** Runs a request to its end and gives the events. */
async function run(
  backend: FakeBackend,
  over: Partial<AiChatRequest> = {},
): Promise<AiChatEvent[]> {
  const events: AiChatEvent[] = [];
  await backend.ai.chat(request(over), (event) => events.push(event));
  return events;
}

const deltasOf = (events: readonly AiChatEvent[]): string[] =>
  events.flatMap((event) => (event.type === "delta" ? [event.text] : []));
const endsOf = (events: readonly AiChatEvent[]) => events.filter((event) => event.type !== "delta");

const withOllama = (reply?: string | ((request: AiChatRequest) => string)) =>
  new FakeBackend({
    ollamaModels: ["llama3.2"],
    ...(reply !== undefined ? { aiReply: reply } : {}),
  });

describe("FakeBackend ai.chat", () => {
  it("answers in deltas, in order, and ends once with done", async () => {
    const events = await run(withOllama("Use `ls -la` to list files."));
    expect(deltasOf(events)).toEqual(["Use ", "`ls ", "-la` ", "to ", "list ", "files."]);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(endsOf(events)).toHaveLength(1);
  });

  it("reports no count of tokens unless the test gives one", async () => {
    const events = await run(withOllama("one two"));
    expect(events.at(-1)).toStrictEqual({ type: "done" });
  });

  it("reports the count of tokens in the done, from a number or a function of the request", async () => {
    const fixed = new FakeBackend({ ollamaModels: ["llama3.2"], aiTokens: 33 });
    expect((await run(fixed)).at(-1)).toStrictEqual({ type: "done", outputTokens: 33 });
    const byRequest = new FakeBackend({
      ollamaModels: ["llama3.2"],
      aiTokens: (req) => (req.requestId === "r1" ? 5 : undefined),
    });
    expect((await run(byRequest)).at(-1)).toStrictEqual({ type: "done", outputTokens: 5 });
    expect((await run(byRequest, { requestId: "r2" })).at(-1)).toStrictEqual({ type: "done" });
    byRequest.setAiTokens(0);
    expect((await run(byRequest)).at(-1)).toStrictEqual({ type: "done", outputTokens: 0 });
    byRequest.setAiTokens(undefined);
    expect((await run(byRequest)).at(-1)).toStrictEqual({ type: "done" });
  });

  it("leaves out a count that is not a whole number, and gives none to a failed or cancelled request", async () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const backend = new FakeBackend({ ollamaModels: ["llama3.2"], aiTokens: bad });
      expect((await run(backend)).at(-1)).toStrictEqual({ type: "done" });
    }
    const failing = new FakeBackend({ aiTokens: 9 });
    const ends = endsOf(await run(failing));
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ type: "error" });
    expect(ends[0]).not.toHaveProperty("outputTokens");
  });

  it("answers with the default text when the test gave none", async () => {
    const events = await run(withOllama());
    expect(deltasOf(events).join("")).toBe(DEFAULT_AI_REPLY);
  });

  it("keeps the blanks of the reply: the deltas put together are the reply", async () => {
    const reply = "  line one\n\n    indented  \nend";
    const events = await run(withOllama(reply));
    expect(deltasOf(events).join("")).toBe(reply);
  });

  it("builds the reply from the request when it is a function, and from the new one after setAiReply", async () => {
    const backend = withOllama((r) => `you said: ${r.messages.at(-1)?.content ?? ""}`);
    expect(deltasOf(await run(backend)).join("")).toBe("you said: hi");
    backend.setAiReply("changed");
    expect(deltasOf(await run(backend, { requestId: "r2" })).join("")).toBe("changed");
    backend.setAiReply(undefined);
    expect(deltasOf(await run(backend, { requestId: "r3" })).join("")).toBe(DEFAULT_AI_REPLY);
  });

  it("hands over nothing at all for an empty reply but the end", async () => {
    const events = await run(withOllama(""));
    expect(events).toEqual([{ type: "done" }]);
  });

  it("answers for a provider of the settings", async () => {
    const backend = new FakeBackend({ aiKeys: { "my-openai": KEY } });
    await backend.ai.configure([OPENAI]);
    const events = await run(backend, { providerId: "my-openai", model: "gpt-4o" });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(backend.callsTo("ai.chat")[0]?.args[0]).toMatchObject({ model: "gpt-4o" });
  });

  it("can ask again with the same request id once it has ended", async () => {
    const backend = withOllama("a");
    await run(backend);
    await expect(run(backend)).resolves.toEqual([{ type: "delta", text: "a" }, { type: "done" }]);
  });
});

describe("FakeBackend ai.chat: what it was sent", () => {
  it("records the messages exactly as sent, equal to the preview that was shown", async () => {
    const built = buildAskMessages({
      settings: { ai: { enabled: true } },
      space: { aiEnabled: true },
      question: "what does this mean?",
      chips: [
        { kind: "tab", title: "build", text: "error[E0425]: cannot find value `x`" },
        { kind: "selection", text: "let y = x + 1;" },
      ],
    });
    if (!built.ok) throw new Error("refused");
    const backend = withOllama();
    await backend.ai.chat(request({ messages: built.messages }), () => undefined);

    const [call] = backend.callsTo("ai.chat");
    const sent = call?.args[0] as AiChatRequest;
    expect(sent.messages).toEqual(built.messages);
    expect(sent.messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n")).toBe(built.preview);
    expect(sent.messages[1]?.content).toContain("error[E0425]");
  });

  it("records a copy: changing the request afterwards does not change what was sent", async () => {
    const backend = withOllama();
    const messages = [{ role: "user" as const, content: "before" }];
    await backend.ai.chat(request({ messages }), () => undefined);
    messages[0] = { role: "user", content: "after" };
    const sent = backend.callsTo("ai.chat")[0]?.args[0] as AiChatRequest;
    expect(sent.messages[0]?.content).toBe("before");
  });

  it("never records a key: the request has none and the keychain stays out of the calls", async () => {
    const backend = new FakeBackend({ aiKeys: { "my-openai": KEY } });
    await backend.ai.configure([OPENAI]);
    await run(backend, { providerId: "my-openai" });
    await backend.ai.cancel("r1");
    expect(JSON.stringify(backend.calls)).not.toContain(KEY);
  });
});

describe("FakeBackend ai.cancel", () => {
  it("ends a running request with cancelled, once, and no delta after it", async () => {
    const backend = withOllama("one two three four five six");
    const events: AiChatEvent[] = [];
    const done = backend.ai.chat(request(), (event) => {
      events.push(event);
      if (events.length === 2) void backend.ai.cancel("r1");
    });
    await done;
    expect(deltasOf(events)).toEqual(["one ", "two "]);
    expect(events.at(-1)).toEqual({ type: "error", kind: "cancelled", message: "cancelled" });
    expect(endsOf(events)).toHaveLength(1);
  });

  it("cancelled before the first delta, it ends with cancelled and no delta at all", async () => {
    const backend = withOllama();
    const events: AiChatEvent[] = [];
    const done = backend.ai.chat(request(), (event) => events.push(event));
    await expect(backend.ai.cancel("r1")).resolves.toBe(true);
    await done;
    expect(events).toEqual([{ type: "error", kind: "cancelled", message: "cancelled" }]);
  });

  it("cancels only the request it names", async () => {
    const backend = withOllama("a b c");
    const one: AiChatEvent[] = [];
    const two: AiChatEvent[] = [];
    const first = backend.ai.chat(request({ requestId: "one" }), (e) => one.push(e));
    const second = backend.ai.chat(request({ requestId: "two" }), (e) => two.push(e));
    await backend.ai.cancel("one");
    await Promise.all([first, second]);
    expect(one.at(-1)).toMatchObject({ type: "error", kind: "cancelled" });
    expect(two.at(-1)).toEqual({ type: "done" });
    expect(deltasOf(two).join("")).toBe("a b c");
  });

  it("says false for an id that is not running, and for one that already ended", async () => {
    const backend = withOllama();
    await expect(backend.ai.cancel("nobody")).resolves.toBe(false);
    await run(backend);
    await expect(backend.ai.cancel("r1")).resolves.toBe(false);
  });

  it("records the call", async () => {
    const backend = withOllama();
    await backend.ai.cancel("r9");
    expect(backend.callsTo("ai.cancel").map((c) => c.args)).toEqual([["r9"]]);
  });
});

describe("FakeBackend holdAiAnswer", () => {
  it("stops an answer after its first piece until it is released, then finishes it", async () => {
    const backend = withOllama("one two three");
    backend.holdAiAnswer(true);
    const events: AiChatEvent[] = [];
    const finished = backend.ai.chat(request(), (event) => events.push(event));
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(events).toEqual([{ type: "delta", text: "one " }]);
    backend.holdAiAnswer(false);
    await finished;
    expect(deltasOf(events)).toEqual(["one ", "two ", "three"]);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("lets a cancel end a held answer at once, with what had come and one cancelled", async () => {
    const backend = withOllama("one two three");
    backend.holdAiAnswer(true);
    const events: AiChatEvent[] = [];
    const finished = backend.ai.chat(request(), (event) => events.push(event));
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    await expect(backend.ai.cancel("r1")).resolves.toBe(true);
    await finished;
    expect(events).toEqual([
      { type: "delta", text: "one " },
      { type: "error", kind: "cancelled", message: "cancelled" },
    ]);
  });

  it("holds nothing when it is off, and holds every answer started while it is on", async () => {
    const backend = withOllama("a b");
    expect(deltasOf(await run(backend)).join("")).toBe("a b");
    backend.holdAiAnswer(true);
    const first: AiChatEvent[] = [];
    const second: AiChatEvent[] = [];
    const one = backend.ai.chat(request({ requestId: "one" }), (e) => first.push(e));
    const two = backend.ai.chat(request({ requestId: "two" }), (e) => second.push(e));
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    backend.holdAiAnswer(false);
    await Promise.all([one, two]);
    expect(first.at(-1)).toEqual({ type: "done" });
    expect(second.at(-1)).toEqual({ type: "done" });
  });
});

describe("FakeBackend ai.chat: when the provider cannot answer", () => {
  it("ends with a network error when there is no Ollama", async () => {
    const events = await run(new FakeBackend());
    expect(events).toEqual([
      {
        type: "error",
        kind: "network",
        message: "could not reach the provider: connection refused",
      },
    ]);
  });

  it("ends with an error for an Anthropic provider that has no key, and answers once it has one", async () => {
    const backend = new FakeBackend();
    await backend.ai.configure([CLAUDE]);
    const refused = await run(backend, { providerId: "claude" });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ type: "error", kind: "invalid-request" });
    await backend.ai.setKey("claude", KEY);
    const ok = await run(backend, { providerId: "claude", requestId: "r2" });
    expect(ok.at(-1)).toEqual({ type: "done" });
  });

  it("ends with the failure a test chose, without the key in its text", async () => {
    const backend = new FakeBackend({ aiKeys: { "my-openai": KEY } });
    await backend.ai.configure([OPENAI]);
    backend.setAiConnectionResult("my-openai", {
      ok: false,
      kind: "auth",
      message: `the provider refused the key ${KEY}`,
    });
    const events = await run(backend, { providerId: "my-openai" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", kind: "auth" });
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it("rejects, with no event, a request that cannot start", async () => {
    const backend = withOllama();
    const seen: AiChatEvent[] = [];
    const ask = (over: Partial<AiChatRequest>) =>
      backend.ai.chat(request(over), (e) => seen.push(e));
    await expect(ask({ providerId: "nobody" })).rejects.toThrow("there is no provider `nobody`");
    await expect(ask({ providerId: "bad id" })).rejects.toThrow("is not a provider id");
    await expect(ask({ requestId: "" })).rejects.toThrow("request id");
    await expect(ask({ requestId: "has space" })).rejects.toThrow("request id");
    await expect(
      ask({ messages: [{ role: "tool" as unknown as "user", content: "x" }] }),
    ).rejects.toThrow("is not a role");
    expect(seen).toEqual([]);
  });

  it("rejects a request id that is already running, and keeps the first one going", async () => {
    const backend = withOllama("a b");
    const first: AiChatEvent[] = [];
    const running = backend.ai.chat(request(), (e) => first.push(e));
    await expect(backend.ai.chat(request(), () => undefined)).rejects.toThrow("already running");
    await running;
    expect(first.at(-1)).toEqual({ type: "done" });
  });

  it("lets go of the request id when the listener throws", async () => {
    const backend = withOllama("a b");
    await expect(
      backend.ai.chat(request(), () => {
        throw new Error("listener broke");
      }),
    ).rejects.toThrow("listener broke");
    await expect(run(backend)).resolves.toContainEqual({ type: "done" });
  });
});

describe("FakeBackend ai.chat: properties", () => {
  it("streams any reply back whole, in order, with one done at the end", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: "grapheme", maxLength: 200 }), async (reply) => {
        const events = await run(withOllama(reply));
        expect(deltasOf(events).join("")).toBe(reply);
        expect(endsOf(events)).toEqual([{ type: "done" }]);
        expect(events.at(-1)).toEqual({ type: "done" });
      }),
      { numRuns: 100 },
    );
  });

  it("ends exactly once, with cancelled, however far into the answer it is cancelled", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 1, maxLength: 12 }),
        fc.nat(14),
        async (words, after) => {
          const backend = withOllama(words.join(" "));
          const events: AiChatEvent[] = [];
          const finished = backend.ai.chat(request(), (event) => {
            events.push(event);
            if (events.length === after) void backend.ai.cancel("r1");
          });
          await finished;
          const ends = endsOf(events);
          expect(ends).toHaveLength(1);
          expect(events.at(-1)).toBe(ends[0]);
          const cancelled = events.at(-1)?.type === "error";
          if (cancelled) {
            expect(events.at(-1)).toMatchObject({ kind: "cancelled" });
            expect(deltasOf(events).length).toBeLessThanOrEqual(after);
          } else {
            expect(deltasOf(events).join("")).toBe(words.join(" "));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
