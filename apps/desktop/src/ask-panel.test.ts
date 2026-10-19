import { describe, expect, it } from "vitest";
import type { Config } from "@noren/model";
import {
  ASK_STEPS,
  explainQuestion,
  NO_CHOICE,
  applyAskEvent,
  askNeedsOllama,
  askOffNotice,
  askRequestId,
  askSteps,
  askTarget,
  chipsWithExplained,
  cutLine,
  explainChip,
  explainChipLabel,
  failExchange,
  liveChoice,
  readAskChips,
  refusalText,
  secretsLine,
  shellNameOf,
  startExchange,
  statusNote,
  withTab,
} from "./ask-panel";
import type { AskSources } from "./ask-panel";

/** Sources that give back what a test says, and count how often each was asked. */
function sources(
  given: Partial<{
    selection: string;
    lastOutput: { text: string; command?: string } | undefined;
    screen: string;
    tabs: Record<string, { title: string; text: string }>;
  }> = {},
): AskSources & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    selection: () => {
      asked.push("selection");
      return given.selection ?? "";
    },
    lastOutput: () => {
      asked.push("lastOutput");
      return given.lastOutput;
    },
    screen: () => {
      asked.push("screen");
      return given.screen ?? "";
    },
    tab: (id) => {
      asked.push(`tab:${id}`);
      return given.tabs?.[id];
    },
  };
}

describe("readAskChips", () => {
  it("reads nothing when no chip is on", () => {
    const from = sources({ selection: "x", screen: "y" });
    expect(readAskChips(NO_CHOICE, from)).toEqual({ chips: [], left: [] });
    expect(from.asked).toEqual([]);
  });

  it("reads the chips that are on in a fixed order, the tabs as they were added", () => {
    const from = sources({
      selection: "picked",
      lastOutput: { text: "out", command: "ls" },
      screen: "seen",
      tabs: { b: { title: "Build", text: "built" }, a: { title: "Api", text: "served" } },
    });
    const read = readAskChips(
      { selection: true, lastOutput: true, screen: true, tabs: ["b", "a"] },
      from,
    );
    expect(read.left).toEqual([]);
    expect(read.chips).toEqual([
      { kind: "selection", text: "picked" },
      { kind: "lastOutput", text: "out", command: "ls" },
      { kind: "screen", text: "seen" },
      { kind: "tab", title: "Build", text: "built" },
      { kind: "tab", title: "Api", text: "served" },
    ]);
    // Each place is read once, and only the ones that are on.
    expect(from.asked).toEqual(["selection", "lastOutput", "screen", "tab:b", "tab:a"]);
  });

  it("leaves out a chip that is on and has nothing, and says so", () => {
    const read = readAskChips(
      { selection: true, lastOutput: true, screen: true, tabs: ["gone", "empty"] },
      sources({ screen: "   \n", tabs: { empty: { title: "Quiet", text: "" } } }),
    );
    expect(read.chips).toEqual([]);
    expect(read.left).toEqual([
      "Selection: nothing is selected in the terminal.",
      "Last output: no command has finished in this pane yet.",
      "Screen: the screen is empty.",
      "A tab you added is gone.",
      "Tab Quiet: it has no text yet.",
    ]);
  });

  it("says when the last command printed nothing", () => {
    expect(
      readAskChips({ ...NO_CHOICE, lastOutput: true }, sources({ lastOutput: { text: "" } })).left,
    ).toEqual(["Last output: the last command printed nothing."]);
  });

  it("treats a terminal that throws as a chip with nothing", () => {
    const broken: AskSources = {
      selection: () => {
        throw new Error("gone");
      },
      lastOutput: () => {
        throw new Error("gone");
      },
      screen: () => {
        throw new Error("gone");
      },
      tab: () => {
        throw new Error("gone");
      },
    };
    const read = readAskChips(
      { selection: true, lastOutput: true, screen: true, tabs: ["a"] },
      broken,
    );
    expect(read.chips).toEqual([]);
    expect(read.left).toHaveLength(4);
  });

  it("does not add a command to a last-output chip that has none", () => {
    const read = readAskChips(
      { ...NO_CHOICE, lastOutput: true },
      sources({ lastOutput: { text: "x" } }),
    );
    expect(read.chips).toEqual([{ kind: "lastOutput", text: "x" }]);
  });
});

describe("the tabs of a choice", () => {
  it("adds a tab once and takes it out", () => {
    const one = withTab(NO_CHOICE, "a", true);
    expect(one.tabs).toEqual(["a"]);
    expect(withTab(one, "a", true).tabs).toEqual(["a"]);
    expect(withTab(withTab(one, "b", true), "a", true).tabs).toEqual(["b", "a"]);
    expect(withTab(one, "a", false).tabs).toEqual([]);
    expect(withTab(one, "z", false)).toEqual(one);
  });

  it("drops the tabs that no longer exist and keeps the rest of the choice", () => {
    const choice = { selection: true, lastOutput: false, screen: false, tabs: ["a", "b"] };
    expect(liveChoice(choice, (id) => id === "b")).toEqual({ ...choice, tabs: ["b"] });
    expect(liveChoice(choice, () => true)).toBe(choice);
  });
});

const config = (ai: Config["ai"]): Pick<Config, "ai"> => (ai === undefined ? {} : { ai });

describe("who answers", () => {
  it("takes the provider and model the settings name for Ask", () => {
    const named = config({ defaults: { ask: { provider: "work", model: "big" } } });
    expect(askTarget(named, undefined)).toEqual({
      providerId: "work",
      model: "big",
      label: "work · big",
    });
    const ollama = config({ defaults: { ask: { provider: "ollama", model: "qwen2" } } });
    expect(askTarget(ollama, { found: false })?.label).toBe("Ollama · qwen2");
  });

  it("falls back to the first provider of the file, with its own model", () => {
    const listed = config({
      providers: [
        { id: "one", kind: "openai-compatible", baseUrl: "https://a.example/v1", model: "m1" },
        { id: "two", kind: "anthropic", baseUrl: "https://b.example", model: "m2" },
      ],
    });
    expect(askTarget(listed, { found: true, models: ["llama3"] })).toEqual({
      providerId: "one",
      model: "m1",
      label: "one · m1",
    });
  });

  it("falls back to the first model of the Ollama of this computer", () => {
    expect(askTarget(config(undefined), { found: true, models: ["llama3", "qwen2"] })).toEqual({
      providerId: "ollama",
      model: "llama3",
      label: "Ollama · llama3",
    });
  });

  it("has nobody when nothing is named, listed or installed", () => {
    expect(askTarget(config(undefined), undefined)).toBeUndefined();
    expect(askTarget(config(undefined), { found: false })).toBeUndefined();
    expect(askTarget(config(undefined), { found: true, models: [] })).toBeUndefined();
  });

  it("asks Ollama for its models only when the settings do not say who answers", () => {
    expect(askNeedsOllama(config(undefined))).toBe(true);
    expect(askNeedsOllama(config({ enabled: true }))).toBe(true);
    expect(askNeedsOllama(config({ defaults: { ask: { provider: "ollama", model: "m" } } }))).toBe(
      false,
    );
    expect(
      askNeedsOllama(
        config({
          providers: [{ id: "a", kind: "anthropic", baseUrl: "https://a.example", model: "m" }],
        }),
      ),
    ).toBe(false);
  });

  it("has steps that lead to a first provider", () => {
    expect(ASK_STEPS.length).toBeGreaterThanOrEqual(2);
    expect(ASK_STEPS.join(" ")).toContain("Ollama");
  });

  it("names the function in the last step", () => {
    expect(askSteps("ask")).toEqual(ASK_STEPS);
    expect(askSteps("explain")[2]).toContain("for Explain");
    expect(askSteps("command")[2]).toContain("for Command");
  });
});

describe("who answers each function", () => {
  const named = config({
    defaults: {
      ask: { provider: "a", model: "ma" },
      explain: { provider: "e", model: "me" },
      command: { provider: "ollama", model: "mc" },
    },
    providers: [{ id: "first", kind: "anthropic", baseUrl: "https://a.example", model: "mf" }],
  });

  it("takes the provider and model the settings name for that function", () => {
    expect(askTarget(named, undefined, "ask")?.label).toBe("a · ma");
    expect(askTarget(named, undefined, "explain")).toEqual({
      providerId: "e",
      model: "me",
      label: "e · me",
    });
    expect(askTarget(named, undefined, "command")?.label).toBe("Ollama · mc");
  });

  it("answers for Ask when no function is given", () => {
    expect(askTarget(named, undefined)).toEqual(askTarget(named, undefined, "ask"));
  });

  it("falls back, for a function nobody named, to the first provider and then to Ollama", () => {
    const onlyAsk = config({
      defaults: { ask: { provider: "a", model: "ma" } },
      providers: [{ id: "first", kind: "anthropic", baseUrl: "https://a.example", model: "mf" }],
    });
    expect(askTarget(onlyAsk, undefined, "explain")?.label).toBe("first · mf");
    expect(askTarget(onlyAsk, undefined, "command")?.label).toBe("first · mf");
    const bare = config({ defaults: { ask: { provider: "a", model: "ma" } } });
    expect(askTarget(bare, { found: true, models: ["llama3"] }, "command")?.label).toBe(
      "Ollama · llama3",
    );
    expect(askTarget(bare, { found: false }, "explain")).toBeUndefined();
  });

  it("asks Ollama for its models by function: a name for Ask does not answer Explain", () => {
    const onlyAsk = config({ defaults: { ask: { provider: "a", model: "ma" } } });
    expect(askNeedsOllama(onlyAsk, "ask")).toBe(false);
    expect(askNeedsOllama(onlyAsk, "explain")).toBe(true);
    expect(askNeedsOllama(onlyAsk, "command")).toBe(true);
    expect(askNeedsOllama(named, "explain")).toBe(false);
  });
});

describe("the shell of a pane", () => {
  const profiles = [
    { id: "pwsh", name: "PowerShell", default: false },
    { id: "bash", name: "Git Bash", default: true },
  ];

  it("is the name of the profile the pane names", () => {
    expect(shellNameOf("pwsh", profiles)).toBe("PowerShell");
  });

  it("is the name of the default profile for a pane that names none", () => {
    expect(shellNameOf("default", profiles)).toBe("Git Bash");
    expect(shellNameOf("default", [{ id: "x", name: "X", default: false }])).toBe("X");
  });

  it("falls back to the id, or to a word, when the profile is not listed", () => {
    expect(shellNameOf("zsh", profiles)).toBe("zsh");
    expect(shellNameOf("default", [])).toBe("the shell");
    expect(shellNameOf(undefined, profiles)).toBe("the shell");
  });
});

describe("explaining a command", () => {
  const request = {
    command: "fake$ cargo build",
    output: "error: boom",
    exitCode: 101,
    truncated: false,
  };

  it("makes a chip of the command, its output and its code", () => {
    expect(explainChip(request)).toEqual({
      kind: "command",
      command: "fake$ cargo build",
      text: "error: boom",
      exitCode: 101,
      truncated: false,
    });
  });

  it("puts the explained command before the chips read from the terminal", () => {
    const read = [{ kind: "screen" as const, text: "S" }];
    expect(chipsWithExplained(request, read).map((chip) => chip.kind)).toEqual([
      "command",
      "screen",
    ]);
    expect(chipsWithExplained(undefined, read)).toEqual(read);
  });

  it("shows the command on one short line", () => {
    expect(explainChipLabel({ command: "  a\n  b  " })).toBe("a b");
    expect(explainChipLabel({ command: "x".repeat(100) })).toBe(`${"x".repeat(40)}…`);
  });

  it("asks why it failed and how to fix it", () => {
    expect(explainQuestion()).toContain("fail");
  });
});

describe("the words of the panel", () => {
  it("says why the AI is off, and says nothing when it is on", () => {
    expect(askOffNotice(config({ enabled: true }), { aiEnabled: true })).toBe("");
    expect(askOffNotice(config({ enabled: true }), { aiEnabled: false })).toContain("this space");
    expect(askOffNotice(config({ enabled: false }), { aiEnabled: true })).toContain("Settings");
    expect(askOffNotice(config(undefined), { aiEnabled: false })).toContain("Settings");
  });

  it("says what a refusal means", () => {
    const on = config({ enabled: true });
    expect(refusalText("empty-question", on)).toBe("Type a question first.");
    expect(refusalText("question-too-long", on)).toContain("too long");
    expect(refusalText("ai-off", on)).toContain("this space");
    expect(refusalText("ai-off", config(undefined))).toContain("Settings");
  });

  it("counts the secrets that were replaced", () => {
    expect(secretsLine(0, [])).toBe("No secret was found in what will be sent.");
    expect(secretsLine(1, ["jwt"])).toBe("1 secret was replaced by a marker (jwt).");
    expect(secretsLine(3, ["jwt", "password"])).toBe(
      "3 secrets were replaced by markers (jwt, password).",
    );
  });

  it("says what was cut and from where", () => {
    expect(cutLine({ index: 0, chip: "selection", removed: 12, from: "end" })).toBe(
      "The selection was cut: 12 characters left out from the end.",
    );
    expect(cutLine({ index: 1, chip: "lastOutput", removed: 5, from: "start" })).toBe(
      "The output of the last command was cut: 5 characters left out from the start.",
    );
    expect(cutLine({ index: 2, chip: "tab", removed: 1, from: "start" })).toContain("A tab");
  });
});

describe("an answer in pieces", () => {
  const begin = () => startExchange(1, "ask-x-1", "why?", 2);

  it("starts empty and streaming, with the count of secrets that were replaced", () => {
    expect(begin()).toEqual({
      key: 1,
      requestId: "ask-x-1",
      question: "why?",
      answer: "",
      status: "streaming",
      redactions: 2,
    });
  });

  it("appends the pieces in order and ends on done", () => {
    let exchange = begin();
    for (const text of ["Because ", "of ", "this."]) {
      exchange = applyAskEvent(exchange, { type: "delta", text });
    }
    expect(exchange.answer).toBe("Because of this.");
    expect(exchange.status).toBe("streaming");
    exchange = applyAskEvent(exchange, { type: "done" });
    expect(exchange.status).toBe("done");
    expect(statusNote(exchange)).toBeUndefined();
  });

  it("ignores everything after the end", () => {
    const done = applyAskEvent(applyAskEvent(begin(), { type: "delta", text: "a" }), {
      type: "done",
    });
    expect(applyAskEvent(done, { type: "delta", text: "late" })).toBe(done);
    expect(applyAskEvent(done, { type: "error", kind: "network", message: "x" })).toBe(done);
    expect(applyAskEvent(done, { type: "done" })).toBe(done);
  });

  it("keeps what had come when the request is cancelled, and calls it stopped", () => {
    const part = applyAskEvent(begin(), { type: "delta", text: "half an ans" });
    const stopped = applyAskEvent(part, { type: "error", kind: "cancelled", message: "cancelled" });
    expect(stopped).toMatchObject({ status: "stopped", answer: "half an ans" });
    expect(stopped.error).toBeUndefined();
    expect(statusNote(stopped)).toBe("Stopped.");
  });

  it("fails with the sentence of the provider, and keeps what had come", () => {
    const part = applyAskEvent(begin(), { type: "delta", text: "so far" });
    const failed = applyAskEvent(part, {
      type: "error",
      kind: "auth",
      message: "the key was rejected",
    });
    expect(failed).toMatchObject({
      status: "failed",
      error: "the key was rejected",
      answer: "so far",
    });
    expect(statusNote(failed)).toBe("the key was rejected");
  });

  it("fails when the request could not start, but not an answer that has ended", () => {
    expect(failExchange(begin(), "no such provider")).toMatchObject({
      status: "failed",
      error: "no such provider",
    });
    const done = applyAskEvent(begin(), { type: "done" });
    expect(failExchange(done, "late")).toBe(done);
  });

  it("makes request ids the backend takes: letters, digits and dashes, at most 64", () => {
    const id = askRequestId(12, Date.now());
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(askRequestId(1, 1000)).not.toBe(askRequestId(2, 1000));
    expect(askRequestId(1, 1000)).not.toBe(askRequestId(1, 1001));
    expect(askRequestId(-5, Number.NaN.valueOf())).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
