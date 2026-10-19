import { describe, expect, it } from "vitest";
import { editConfigText, parseConfigText } from "@noren/model";
import type { Config } from "@noren/model";
import { planSave, shownSettings } from "./settings-screen";
import {
  AFTER_HOURS_PROBLEM,
  ARCHIVE_PATHS,
  DEFAULT_ARCHIVE_VALUES,
  DEFAULT_TERMINAL_VALUES,
  FONT_SIZE_PROBLEM,
  LINE_HEIGHT_PROBLEM,
  SCROLLBACK_PROBLEM,
  TERMINAL_PATHS,
  archiveValuesOf,
  fontChoice,
  numberOfText,
  planArchive,
  planTerminal,
  schemaProblem,
  shownArchive,
  shownTerminal,
  terminalValuesOf,
} from "./settings-sections";

const COMMENTED = `// My Noren settings.
{
  "terminal": {
    "font": { "size": 16 }, // my size
    /* the cursor */
    "cursor": { "style": "bar" },
  },
  // Keep tabs a while.
  "archive": { "enabled": true },
}
`;

/** The file after saving `draft` over `text`, as the screen does it: the plan, the edit, the check. */
function saved(text: string, draft: Parameters<typeof planSave>[1]): string {
  const read = parseConfigText(text);
  if (!read.ok) throw new Error("the text of the test is not a valid file");
  const plan = planSave(read.config, draft);
  const next = editConfigText(text, plan.changes);
  expect(parseConfigText(next).ok).toBe(true);
  return next;
}

describe("the values in force", () => {
  it("are the defaults for a file that says nothing", () => {
    expect(terminalValuesOf({})).toEqual(DEFAULT_TERMINAL_VALUES);
    expect(archiveValuesOf({})).toEqual(DEFAULT_ARCHIVE_VALUES);
    expect(DEFAULT_TERMINAL_VALUES).toEqual({
      fontFamily: "Cascadia Mono, Consolas, DejaVu Sans Mono, monospace",
      fontSize: 14,
      lineHeight: 1,
      ligatures: false,
      cursorStyle: "block",
      cursorBlink: true,
      scrollback: 10_000,
      bell: "none",
    });
    expect(DEFAULT_ARCHIVE_VALUES).toEqual({ enabled: true, afterHours: 12 });
  });

  it("take every setting of the file, off and zero included", () => {
    const config: Config = {
      terminal: {
        font: { family: "Hack, monospace", size: 18, lineHeight: 1.4, ligatures: true },
        cursor: { style: "underline", blink: false },
        scrollback: 0,
        bell: "both",
      },
      archive: { enabled: false, afterHours: 0.5 },
    };
    expect(terminalValuesOf(config)).toEqual({
      fontFamily: "Hack, monospace",
      fontSize: 18,
      lineHeight: 1.4,
      ligatures: true,
      cursorStyle: "underline",
      cursorBlink: false,
      scrollback: 0,
      bell: "both",
    });
    expect(archiveValuesOf(config)).toEqual({ enabled: false, afterHours: 0.5 });
  });

  it("show the draft over them, the numbers as text", () => {
    const config: Config = { terminal: { font: { size: 16 } } };
    expect(shownTerminal(config, undefined).fontSize).toBe("16");
    expect(shownTerminal(config, { fontSize: "1" }).fontSize).toBe("1");
    expect(shownTerminal(config, { bell: "sound" }).bell).toBe("sound");
    expect(shownArchive({}, undefined)).toEqual({ enabled: true, afterHours: "12" });
    expect(shownArchive({}, { afterHours: "" }).afterHours).toBe("");
    expect(shownSettings(config, { archive: { enabled: false } }).archive.enabled).toBe(false);
  });

  it("have a place in the file for each terminal setting", () => {
    expect(Object.values(TERMINAL_PATHS).map((path) => path.join("."))).toEqual([
      "terminal.font.family",
      "terminal.font.size",
      "terminal.font.lineHeight",
      "terminal.font.ligatures",
      "terminal.cursor.style",
      "terminal.cursor.blink",
      "terminal.scrollback",
      "terminal.bell",
    ]);
    expect(ARCHIVE_PATHS.afterHours.join(".")).toBe("archive.afterHours");
  });
});

describe("numberOfText and schemaProblem", () => {
  it("read a number with blanks and a sign, and nothing else", () => {
    expect(numberOfText(" 13.5 ")).toBe(13.5);
    expect(numberOfText(".5")).toBe(0.5);
    expect(numberOfText("-2")).toBe(-2);
    for (const text of ["", "  ", "abc", "1e3", "1,5", "12px", "0x10", "Infinity"]) {
      expect(numberOfText(text)).toBeUndefined();
    }
  });

  it("ask the schema of the file", () => {
    expect(schemaProblem(["terminal", "font", "size"], 20)).toBeUndefined();
    expect(schemaProblem(["terminal", "font", "size"], 500)).toBeDefined();
    expect(schemaProblem(["terminal", "bell"], "loud")).toBeDefined();
    expect(schemaProblem(["terminal", "font", "family"], "url(http://x)")).toContain("font");
    expect(schemaProblem(["archive", "afterHours"], 0)).toBeDefined();
  });
});

describe("planTerminal", () => {
  it("writes only what is not the value in force, in the order of the file", () => {
    const plan = planTerminal(
      {},
      {
        bell: "visual",
        fontSize: "16",
        cursorBlink: false,
        cursorStyle: "block",
        scrollback: "5000",
      },
    );
    expect(plan.problems).toEqual({});
    expect(plan.changes.map((c) => [c.path.join("."), "value" in c ? c.value : undefined])).toEqual(
      [
        ["terminal.font.size", 16],
        ["terminal.cursor.blink", false],
        ["terminal.scrollback", 5000],
        ["terminal.bell", "visual"],
      ],
    );
  });

  it("writes nothing for a change put back where it was, or for no draft", () => {
    expect(planTerminal({}, undefined).changes).toEqual([]);
    expect(
      planTerminal({}, { fontSize: "14", lineHeight: "1.0", ligatures: false }).changes,
    ).toEqual([]);
    expect(planTerminal({ terminal: { font: { size: 16 } } }, { fontSize: "16" }).changes).toEqual(
      [],
    );
  });

  it("trims the font list and keeps the names as they are", () => {
    const plan = planTerminal({}, { fontFamily: "  Fira Code,  monospace " });
    expect(plan.changes).toEqual([
      { path: ["terminal", "font", "family"], value: "Fira Code,  monospace" },
    ]);
    const choice = planTerminal({}, { fontFamily: fontChoice("Cascadia Code") });
    expect(choice.changes).toEqual([
      { path: ["terminal", "font", "family"], value: "Cascadia Code, monospace" },
    ]);
  });

  it.each([
    ["fontSize", "5", FONT_SIZE_PROBLEM],
    ["fontSize", "73", FONT_SIZE_PROBLEM],
    ["fontSize", "big", FONT_SIZE_PROBLEM],
    ["fontSize", "", FONT_SIZE_PROBLEM],
    ["lineHeight", "0.5", LINE_HEIGHT_PROBLEM],
    ["lineHeight", "3.1", LINE_HEIGHT_PROBLEM],
    ["scrollback", "-1", SCROLLBACK_PROBLEM],
    ["scrollback", "100001", SCROLLBACK_PROBLEM],
    ["scrollback", "10.5", SCROLLBACK_PROBLEM],
  ] as const)("refuses %s = %j and writes nothing", (key, text, problem) => {
    const plan = planTerminal({}, { [key]: text });
    expect(plan.problems[key]).toBe(problem);
    expect(plan.changes).toEqual([]);
  });

  it("refuses a font list that is not names, with the words of the schema", () => {
    for (const text of ["", "url(http://x/y.woff)", "a;b", "{x}", "Fira, , Hack"]) {
      const plan = planTerminal({}, { fontFamily: text });
      expect(plan.problems.fontFamily, text).toBeTypeOf("string");
      expect(plan.changes).toEqual([]);
    }
  });

  it("keeps the good settings of a draft that has a bad one in it as changes, and reports the bad one", () => {
    const plan = planTerminal({}, { fontSize: "20", scrollback: "many" });
    expect(plan.changes).toEqual([{ path: ["terminal", "font", "size"], value: 20 }]);
    expect(Object.keys(plan.problems)).toEqual(["scrollback"]);
  });
});

describe("planArchive", () => {
  it("writes the switch and the hours that differ", () => {
    expect(planArchive({}, { enabled: false, afterHours: "0.5" }).changes).toEqual([
      { path: ["archive", "enabled"], value: false },
      { path: ["archive", "afterHours"], value: 0.5 },
    ]);
    expect(planArchive({}, { enabled: true, afterHours: "12" }).changes).toEqual([]);
    expect(planArchive({}, undefined).changes).toEqual([]);
  });

  it.each(["0", "-3", "", "soon", "1e2"])("refuses %j hours and writes nothing", (text) => {
    const plan = planArchive({}, { afterHours: text });
    expect(plan.problems.afterHours).toBe(AFTER_HOURS_PROBLEM);
    expect(plan.changes).toEqual([]);
  });
});

describe("saving into a file written by hand", () => {
  it("replaces only the value of a setting the file has and keeps every comment", () => {
    const out = saved(COMMENTED, { terminal: { fontSize: "18", bell: "both" } });
    expect(out).toContain("// My Noren settings.");
    expect(out).toContain("// my size");
    expect(out).toContain("/* the cursor */");
    expect(out).toContain("// Keep tabs a while.");
    const read = parseConfigText(out);
    expect(read.ok && read.config.terminal).toEqual({
      font: { size: 18 },
      cursor: { style: "bar" },
      bell: "both",
    });
    expect(out).toContain('"font": { "size": 18 }, // my size');
  });

  it("adds the archive hours next to the switch the file has", () => {
    const out = saved(COMMENTED, { archive: { afterHours: "2" } });
    expect(out).toContain("// Keep tabs a while.");
    expect(out).toBe(COMMENTED.replace('"enabled": true }', '"enabled": true, "afterHours": 2 }'));
  });

  it("does not write when the draft only has a value the schema refuses", () => {
    const read = parseConfigText(COMMENTED);
    if (!read.ok) throw new Error("not valid");
    const plan = planSave(read.config, {
      terminal: { fontSize: "900" },
      archive: { afterHours: "0" },
    });
    expect(plan.changes).toEqual([]);
    expect(plan.terminalProblems.fontSize).toBe(FONT_SIZE_PROBLEM);
    expect(plan.archiveProblems.afterHours).toBe(AFTER_HOURS_PROBLEM);
  });

  it("creates the sections in a file that has none, in the order of the documentation", () => {
    const out = saved('// only a comment\n{\n  "notifications": { "enabled": false }\n}\n', {
      archive: { enabled: false },
      terminal: { cursorBlink: false },
    });
    expect(out.startsWith("// only a comment")).toBe(true);
    const read = parseConfigText(out);
    expect(read.ok && read.config).toEqual({
      terminal: { cursor: { blink: false } },
      notifications: { enabled: false },
      archive: { enabled: false },
    });
    expect(out.indexOf('"terminal"')).toBeLessThan(out.indexOf('"notifications"'));
    expect(out.indexOf('"notifications"')).toBeLessThan(out.indexOf('"archive"'));
  });
});
