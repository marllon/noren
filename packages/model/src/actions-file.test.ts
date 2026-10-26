import { describe, expect, it } from "vitest";
import { ACTIONS_FILE_PATH, parseActionsFile } from "./index";

const file = (actions: unknown[]) => JSON.stringify({ actions });

const loop = { id: "loop", label: "Loop", command: "loop", stop: "loop parar", tab: "loop" };
const dev = { id: "dev", label: "Dev server", command: "pnpm dev", tab: "dev" };

function reasonOf(source: string): string {
  const result = parseActionsFile(source);
  if (result.ok) throw new Error("expected the file to be refused");
  return result.reason;
}

describe("parseActionsFile", () => {
  it("lives at .noren/actions.json", () => {
    expect(ACTIONS_FILE_PATH).toBe(".noren/actions.json");
  });

  it("accepts the documented example, keeping the optional stop only where it was given", () => {
    const result = parseActionsFile(file([loop, dev]));
    expect(result).toEqual({ ok: true, actions: [loop, dev] });
    if (result.ok) expect("stop" in (result.actions[1] ?? {})).toBe(false);
  });

  it("accepts an empty list and a file with a byte order mark", () => {
    expect(parseActionsFile(file([]))).toEqual({ ok: true, actions: [] });
    expect(parseActionsFile(`${String.fromCharCode(0xfeff)}${file([dev])}`)).toEqual({
      ok: true,
      actions: [dev],
    });
  });

  it("trims the text fields", () => {
    const result = parseActionsFile(file([{ ...dev, label: "  Dev  " }]));
    expect(result.ok && result.actions[0]?.label).toBe("Dev");
  });

  it.each(["id", "label", "command", "tab"])("refuses an action without %s", (field) => {
    const rest = Object.fromEntries(Object.entries(dev).filter(([key]) => key !== field));
    const reason = reasonOf(file([loop, rest]));
    expect(reason).toContain(`actions[1].${field}`);
  });

  it.each([
    ["id", 3],
    ["label", null],
    ["command", ["pnpm", "dev"]],
    ["tab", true],
    ["stop", 0],
  ])("refuses a %s of the wrong type", (field, value) => {
    expect(reasonOf(file([{ ...loop, [field]: value }]))).toContain(`actions[0].${field}`);
  });

  it.each(["id", "label", "command", "stop", "tab"])("refuses an empty or blank %s", (field) => {
    expect(reasonOf(file([{ ...loop, [field]: "" }]))).toContain(`actions[0].${field}`);
    expect(reasonOf(file([{ ...loop, [field]: "   " }]))).toContain(`actions[0].${field}`);
  });

  it("accepts stopWaits true or false, and keeps it only where it was given", () => {
    const waits = { ...loop, stopWaits: true };
    const result = parseActionsFile(file([waits, { ...dev, stopWaits: false }, loop]));
    expect(result).toEqual({ ok: true, actions: [waits, { ...dev, stopWaits: false }, loop] });
    if (result.ok) expect("stopWaits" in (result.actions[2] ?? {})).toBe(false);
  });

  it.each([["true"], [1], [0], [null], [["true"]], [{}]])(
    "refuses a stopWaits that is not true or false (%j)",
    (value) => {
      const reason = reasonOf(file([{ ...loop, stopWaits: value }]));
      expect(reason).toContain("actions[0].stopWaits");
      expect(reason).toContain("stopWaits must be true or false");
    },
  );

  it("refuses a repeated id and names it", () => {
    const reason = reasonOf(file([loop, dev, { ...dev, label: "Again", tab: "other" }]));
    expect(reason).toContain('Duplicate action id "dev"');
    expect(reason).toContain("actions[2].id");
  });

  it("refuses a file that is not an object with an actions list", () => {
    expect(reasonOf("[]")).not.toBe("");
    expect(reasonOf("null")).not.toBe("");
    expect(reasonOf("{}")).toContain("actions");
    expect(reasonOf('{"actions": {}}')).toContain("actions");
    expect(reasonOf(file(["dev"]))).toContain("actions[0]");
  });

  it("returns a reason, and does not throw, for broken JSON", () => {
    for (const broken of ["", "{", '{"actions": [}', "not json", '{"actions": [],}']) {
      expect(reasonOf(broken)).toMatch(/^Not valid JSON/);
    }
  });
});
