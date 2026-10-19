import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ASK_SYSTEM_PROMPT,
  MAX_ASK_CHIP_CHARS,
  MAX_ASK_QUESTION_CHARS,
  buildAskMessages,
  previewOfMessages,
} from "./ask-context";
import type { AskChip, AskInput, AskMessage } from "./ask-context";

const ON = { settings: { ai: { enabled: true } }, space: { aiEnabled: true } } as const;
// A made-up key, built from pieces so no line of this file looks like a real credential.
const KEY = "AK" + "IA" + "IOSFODNN7EXAMPLE";

function ask(question: string, chips: readonly AskChip[] = [], more: Partial<AskInput> = {}) {
  const result = buildAskMessages({ ...ON, question, chips, ...more });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

/** The user message of a built question. */
const userOf = (built: Extract<AskMessage, { ok: true }>): string =>
  built.messages[1]?.content ?? "";

describe("buildAskMessages: the message", () => {
  it("a question with no chip is the system prompt and the question", () => {
    const built = ask("  how do I list files?  ");
    expect(built.messages).toEqual([
      { role: "system", content: ASK_SYSTEM_PROMPT },
      { role: "user", content: "how do I list files?" },
    ]);
    expect(built.redactions).toBe(0);
    expect(built.cuts).toEqual([]);
  });

  it("puts the chips in the order given, each under its heading, and the question last", () => {
    const built = ask("why did it fail?", [
      { kind: "screen", text: "SCREEN TEXT" },
      { kind: "selection", text: "SELECTED TEXT" },
      { kind: "lastOutput", text: "OUTPUT TEXT", command: "cargo build" },
    ]);
    const text = userOf(built);
    const order = ["Visible screen", "Selected text", "Output of the last command", "## Question"];
    const at = order.map((heading) => text.indexOf(heading));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(text.indexOf("SCREEN TEXT")).toBeLessThan(text.indexOf("SELECTED TEXT"));
    expect(text.indexOf("SELECTED TEXT")).toBeLessThan(text.indexOf("OUTPUT TEXT"));
    expect(text).toContain("Command: cargo build");
    expect(text.endsWith("why did it fail?")).toBe(true);
  });

  it("changing the order of the chips changes the order in the message", () => {
    const a: AskChip = { kind: "selection", text: "AAA" };
    const b: AskChip = { kind: "screen", text: "BBB" };
    const ab = userOf(ask("q", [a, b]));
    const ba = userOf(ask("q", [b, a]));
    expect(ab.indexOf("AAA")).toBeLessThan(ab.indexOf("BBB"));
    expect(ba.indexOf("BBB")).toBeLessThan(ba.indexOf("AAA"));
  });

  it("an @tab chip brings the content of that tab under its title", () => {
    const built = ask("what is running there?", [
      { kind: "tab", title: "server", text: "listening on :8080\nGET /health 200" },
      { kind: "tab", title: "build", text: "compiling noren-core" },
    ]);
    const text = userOf(built);
    expect(text).toContain("### Tab: server");
    expect(text).toContain("listening on :8080\nGET /health 200");
    expect(text).toContain("### Tab: build");
    expect(text.indexOf("Tab: server")).toBeLessThan(text.indexOf("listening on :8080"));
    expect(text.indexOf("listening on :8080")).toBeLessThan(text.indexOf("Tab: build"));
    expect(text.indexOf("Tab: build")).toBeLessThan(text.indexOf("compiling noren-core"));
  });

  it("puts a tab title on one line, cut at 100 characters", () => {
    const built = ask("q", [{ kind: "tab", title: `a\nb\t${"x".repeat(200)}`, text: "t" }]);
    const heading = userOf(built)
      .split("\n")
      .find((line) => line.startsWith("### Tab:"));
    expect(heading).toBeDefined();
    expect([...(heading ?? "")].length).toBeLessThanOrEqual("### Tab: ".length + 101);
    expect(heading).toContain("a b xxx");
  });

  it("fences a chip with a fence that nothing inside it can close", () => {
    const built = ask("q", [{ kind: "screen", text: "```sh\nls\n```" }]);
    const text = userOf(built);
    expect(text).toContain("````\n```sh\nls\n```\n````");
  });

  it("holds an empty chip as such instead of leaving a hole", () => {
    expect(userOf(ask("q", [{ kind: "selection", text: "" }]))).toContain("(empty)");
  });
});

describe("buildAskMessages: redaction", () => {
  it("redacts the chips, the tab title, the command and the question", () => {
    const built = ask(`is ${KEY} mine?`, [
      { kind: "selection", text: `key ${KEY}` },
      { kind: "lastOutput", text: "ok", command: `export AWS=${KEY}` },
      { kind: "tab", title: `token=${KEY}`, text: "t" },
    ]);
    expect(built.preview).not.toContain(KEY);
    expect(JSON.stringify(built.messages)).not.toContain(KEY);
    expect(built.redactions).toBe(4);
    expect(built.redactionKinds).toEqual(["aws-access-key"]);
  });

  it("counts the redactions of all the chips together", () => {
    const built = ask("hello", [
      { kind: "screen", text: `${KEY} and password=abc` },
      { kind: "selection", text: "clean" },
    ]);
    expect(built.redactions).toBe(2);
  });
});

describe("buildAskMessages: the size of a chip", () => {
  it("leaves a chip at the limit alone", () => {
    const built = ask("q", [{ kind: "screen", text: "x".repeat(50) }], { maxChipChars: 50 });
    expect(built.cuts).toEqual([]);
    expect(userOf(built)).not.toContain("cut from");
  });

  it("cuts a chip that is too long from its start, keeping the end, and says so", () => {
    const text = `${"old ".repeat(100)}RECENT`;
    const built = ask("q", [{ kind: "lastOutput", text }], { maxChipChars: 20 });
    const sent = userOf(built);
    expect(sent).toContain(`[... ${text.length - 20} characters cut from the start]`);
    expect(sent).toContain("RECENT");
    expect(sent).not.toContain("old ".repeat(10));
    expect(built.cuts).toEqual([
      { index: 0, chip: "lastOutput", removed: text.length - 20, from: "start" },
    ]);
  });

  it("cuts a selection from its end, keeping its start", () => {
    const text = `FIRST${"-".repeat(100)}`;
    const built = ask("q", [{ kind: "selection", text }], { maxChipChars: 10 });
    expect(userOf(built)).toContain("FIRST-----\n[... 95 more characters cut from the end]");
    expect(built.cuts).toEqual([{ index: 0, chip: "selection", removed: 95, from: "end" }]);
  });

  it("limits each chip on its own", () => {
    const built = ask(
      "q",
      [
        { kind: "screen", text: "a".repeat(30) },
        { kind: "tab", title: "t", text: "b".repeat(5) },
        { kind: "selection", text: "c".repeat(30) },
      ],
      { maxChipChars: 10 },
    );
    expect(built.cuts.map((cut) => cut.index)).toEqual([0, 2]);
    expect(userOf(built)).toContain("bbbbb");
  });

  it("limits to 6000 characters unless told otherwise", () => {
    const built = ask("q", [{ kind: "screen", text: "z".repeat(MAX_ASK_CHIP_CHARS + 10) }]);
    expect(built.cuts).toEqual([{ index: 0, chip: "screen", removed: 10, from: "start" }]);
  });

  it("redacts before it cuts, so a secret is not left half there", () => {
    const text = `${"x".repeat(30)} ${KEY}`;
    const built = ask("q", [{ kind: "selection", text }], { maxChipChars: 45 });
    expect(userOf(built)).not.toContain("AKIA");
    expect(userOf(built)).toContain("[REDACTED:aws-");
  });
});

describe("buildAskMessages: the preview", () => {
  it("is the messages as they are sent, role by role", () => {
    const built = ask("q?", [{ kind: "selection", text: "sel" }]);
    expect(built.preview).toBe(previewOfMessages(built.messages));
    for (const message of built.messages) {
      expect(built.preview).toContain(`[${message.role}]\n${message.content}`);
    }
    expect(built.preview.startsWith("[system]\n")).toBe(true);
  });
});

describe("buildAskMessages: refusals", () => {
  const chips: AskChip[] = [{ kind: "selection", text: "x" }];

  it("refuses when the AI is off in the settings", () => {
    for (const settings of [{}, { ai: {} }, { ai: { enabled: false } }]) {
      expect(
        buildAskMessages({ settings, space: { aiEnabled: true }, question: "q", chips }),
      ).toEqual({
        ok: false,
        reason: "ai-off",
      });
    }
  });

  it("refuses when the AI is off for the space, even with the settings on", () => {
    expect(buildAskMessages({ ...ON, space: { aiEnabled: false }, question: "q", chips })).toEqual({
      ok: false,
      reason: "ai-off",
    });
  });

  it("says the AI is off before it looks at anything else", () => {
    const off = { ...ON, space: { aiEnabled: false } };
    expect(buildAskMessages({ ...off, question: "", chips: [] })).toEqual({
      ok: false,
      reason: "ai-off",
    });
  });

  it("refuses a blank question", () => {
    for (const question of ["", "   ", "\n\t"]) {
      expect(buildAskMessages({ ...ON, question, chips })).toEqual({
        ok: false,
        reason: "empty-question",
      });
    }
  });

  it("refuses a question that is too long instead of cutting it", () => {
    expect(
      buildAskMessages({ ...ON, question: "q".repeat(MAX_ASK_QUESTION_CHARS + 1), chips }),
    ).toEqual({ ok: false, reason: "question-too-long" });
    expect(
      buildAskMessages({ ...ON, question: "q".repeat(MAX_ASK_QUESTION_CHARS), chips }).ok,
    ).toBe(true);
  });
});

describe("buildAskMessages: properties", () => {
  const text = fc.string({ unit: "grapheme", maxLength: 400 });
  const chip: fc.Arbitrary<AskChip> = fc.oneof(
    text.map((t): AskChip => ({ kind: "selection", text: t })),
    fc
      .tuple(text, fc.option(text, { nil: undefined }))
      .map(([t, command]): AskChip => ({ kind: "lastOutput", text: t, command })),
    text.map((t): AskChip => ({ kind: "screen", text: t })),
    fc.tuple(text, text).map(([title, t]): AskChip => ({ kind: "tab", title, text: t })),
  );
  const secretIn = (chipOf: AskChip): AskChip => {
    const planted = `pre ${KEY} post`;
    if (chipOf.kind === "tab") return { ...chipOf, text: planted };
    return { ...chipOf, text: planted };
  };

  it("never lets a secret planted in any chip or in the question reach the messages", () => {
    fc.assert(
      fc.property(
        fc.array(chip, { maxLength: 5 }),
        fc.nat(4),
        fc.integer({ min: 1, max: 200 }),
        (chips, at, limit) => {
          const planted = chips.map((c, i) => (i === at ? secretIn(c) : c));
          const built = ask(`question ${KEY}`, planted, { maxChipChars: limit });
          expect(JSON.stringify(built.messages)).not.toContain(KEY);
          expect(built.preview).not.toContain(KEY);
          expect(built.redactions).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("builds a preview equal to the messages, and no chip text longer than the limit", () => {
    fc.assert(
      fc.property(
        fc.array(chip, { maxLength: 5 }),
        fc.integer({ min: 1, max: 100 }),
        (chips, limit) => {
          const built = ask("a question", chips, { maxChipChars: limit });
          expect(built.preview).toBe(previewOfMessages(built.messages));
          expect(built.messages).toHaveLength(2);
          expect(built.cuts.every((cut) => cut.removed > 0 && cut.index < chips.length)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("refuses every input when the AI is off, and builds none when it is on only in one place", () => {
    const off = fc.constantFrom(
      { settings: {}, space: { aiEnabled: true } },
      { settings: { ai: { enabled: true } }, space: { aiEnabled: false } },
      { settings: { ai: { enabled: false } }, space: { aiEnabled: false } },
    );
    fc.assert(
      fc.property(off, fc.string(), fc.array(chip, { maxLength: 4 }), (where, question, chips) => {
        expect(buildAskMessages({ ...where, question, chips })).toEqual({
          ok: false,
          reason: "ai-off",
        });
      }),
      { numRuns: 100 },
    );
  });
});
