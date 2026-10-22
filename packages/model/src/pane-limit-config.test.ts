import { describe, expect, it } from "vitest";
import {
  ConfigSchema,
  DEFAULT_MAX_PANES,
  DEFAULT_RIGHT_CLICK,
  DEFAULT_TERMINAL_OPTIONS,
  MAX_MAX_PANES,
  MIN_MAX_PANES,
  RIGHT_CLICK_ACTIONS,
  configJsonSchema,
  createDefaultWorkspace,
  createSequentialIds,
  editConfigText,
  layoutPanes,
  paneLimitOf,
  parseConfigText,
  parseState,
  reduce,
  terminalOptionsOf,
} from "./index";
import type { Action, ReducerContext, Workspace } from "./index";
import { testContext } from "./test-helpers";

// `terminal.maxPanes` and `terminal.rightClick` of config.jsonc: the most panes a tab holds (8 by
// default, within a range, refused outside it) and what a right click in the terminal does (a menu by
// default). The reducer takes the limit in its context; the app hands it the one of the settings.

const settingsOf = (text: string) => {
  const parsed = parseConfigText(text);
  if (!parsed.ok) throw new Error(`not valid: ${parsed.errors.map((e) => e.message).join("; ")}`);
  return parsed.config.terminal;
};

/** A workspace with one tab of one pane, and the way to split its first pane. */
function oneTab(): { ws: Workspace; itemId: string; paneId: string } {
  const ws = createDefaultWorkspace({ newId: createSequentialIds("d") });
  const item = Object.values(ws.spaces[0]?.items ?? {})[0];
  const pane = item && layoutPanes(item.layout)[0];
  if (!item || !pane) throw new Error("the default workspace has no tab");
  return { ws, itemId: item.id, paneId: pane.id };
}

/** How many panes the tab holds. */
function panesIn(ws: Workspace, itemId: string): number {
  const item = ws.spaces[0]?.items[itemId];
  return item ? layoutPanes(item.layout).length : -1;
}

/** Splits the first pane of the tab again and again until the model refuses; returns how many panes it holds. */
function paneCountAfterSplitting(limit: ReducerContext["maxPanes"]): number {
  const { ws: start, itemId, paneId } = oneTab();
  const base = testContext().ctx;
  const ctx: ReducerContext = limit === undefined ? base : { ...base, maxPanes: limit };
  const split: Action = { type: "pane/split", itemId, paneId, dir: "row", side: "after" };
  let ws = start;
  for (let step = 0; step < 40; step++) {
    const next = reduce(ws, split, ctx);
    if (next === ws) break;
    ws = next;
  }
  return panesIn(ws, itemId);
}

describe("the limit of panes of a tab", () => {
  it("is 8 when nothing sets it", () => {
    expect(DEFAULT_MAX_PANES).toBe(8);
    expect(paneLimitOf(undefined)).toBe(8);
    expect(paneLimitOf({})).toBe(8);
    expect(paneLimitOf(settingsOf('{ "terminal": { "scrollback": 100 } }'))).toBe(8);
    expect(paneCountAfterSplitting(undefined)).toBe(8);
  });

  it("is the one the file sets, anywhere in its range", () => {
    expect(MIN_MAX_PANES).toBe(2);
    expect(MAX_MAX_PANES).toBe(16);
    for (const wanted of [MIN_MAX_PANES, 3, 4, 8, 12, MAX_MAX_PANES]) {
      const limit = paneLimitOf(settingsOf(`{ "terminal": { "maxPanes": ${wanted} } }`));
      expect(limit).toBe(wanted);
      expect(paneCountAfterSplitting(limit), `a limit of ${wanted}`).toBe(wanted);
    }
  });

  it("refuses the split past it and changes nothing", () => {
    const { ws, itemId, paneId } = oneTab();
    const ctx: ReducerContext = { ...testContext().ctx, maxPanes: 3 };
    const split: Action = { type: "pane/split", itemId, paneId, dir: "column", side: "after" };
    let grown = ws;
    for (let n = 0; n < 2; n++) grown = reduce(grown, split, ctx);
    expect(panesIn(grown, itemId)).toBe(3);
    expect(reduce(grown, split, ctx)).toBe(grown);
    // The default of eight lets the same workspace go on.
    expect(reduce(grown, split, testContext().ctx)).not.toBe(grown);
  });

  it("keeps a value outside the range inside it, for a caller that skipped the schema", () => {
    expect(paneLimitOf({ maxPanes: 0 })).toBe(MIN_MAX_PANES);
    expect(paneLimitOf({ maxPanes: -5 })).toBe(MIN_MAX_PANES);
    expect(paneLimitOf({ maxPanes: 99 })).toBe(MAX_MAX_PANES);
    expect(paneLimitOf({ maxPanes: 5.4 })).toBe(5);
    expect(paneLimitOf({ maxPanes: Number.NaN })).toBe(DEFAULT_MAX_PANES);
    expect(paneLimitOf({ maxPanes: Number.POSITIVE_INFINITY })).toBe(DEFAULT_MAX_PANES);
  });

  it("is refused by the file when it is out of its range or not a whole number, naming the setting", () => {
    for (const value of ["1", "0", "-3", "17", "100", "4.5", '"many"', "null", "true", "{}"]) {
      const result = parseConfigText(`{ "terminal": { "maxPanes": ${value} } }`);
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.path, value).toBe("terminal.maxPanes");
      expect(result.errors[0]?.message.length, value).toBeGreaterThan(0);
    }
    expect(ConfigSchema.safeParse({ terminal: { maxPanes: 2 } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ terminal: { maxPanes: 16 } }).success).toBe(true);
  });

  it("is in the JSON Schema with its range, its description and its default", () => {
    const schema = configJsonSchema() as {
      properties: {
        terminal: {
          properties: Record<
            string,
            { default?: unknown; description?: string; minimum?: number; maximum?: number }
          >;
        };
      };
    };
    const entry = schema.properties.terminal.properties["maxPanes"];
    expect(entry?.default).toBe(8);
    expect(entry?.minimum).toBe(2);
    expect(entry?.maximum).toBe(16);
    expect(entry?.description).toContain("panes");
  });

  it("is written into the file at its own place, keeping the rest", () => {
    const text = `{
  "terminal": {
    "scrollback": 5000, // mine
  },
}
`;
    const edited = editConfigText(text, [{ path: ["terminal", "maxPanes"], value: 6 }]);
    expect(edited).toContain("// mine");
    expect(edited).toContain('"maxPanes": 6');
    expect(paneLimitOf(settingsOf(edited))).toBe(6);
  });

  it("lets a saved tab that has more panes than the limit be read", () => {
    // Lowering the limit never closes a pane: a state that holds more panes than the limit of now is
    // still a state (the app reads it against the most the settings could ever allow).
    const { ws, itemId, paneId } = oneTab();
    const ctx: ReducerContext = { ...testContext().ctx, maxPanes: 12 };
    const split: Action = { type: "pane/split", itemId, paneId, dir: "row", side: "after" };
    let wide = ws;
    for (let n = 0; n < 11; n++) wide = reduce(wide, split, ctx);
    const text = JSON.stringify(wide);
    expect(parseState(text).ok).toBe(false);
    expect(parseState(text, { maxPanes: MAX_MAX_PANES }).ok).toBe(true);
  });
});

describe("terminal.rightClick", () => {
  it("is the menu when the file says nothing", () => {
    expect(DEFAULT_RIGHT_CLICK).toBe("menu");
    expect(DEFAULT_TERMINAL_OPTIONS.rightClick).toBe("menu");
    expect(terminalOptionsOf(undefined).rightClick).toBe("menu");
    expect(terminalOptionsOf({ scrollback: 100 }).rightClick).toBe("menu");
  });

  it("takes each choice the file makes", () => {
    expect([...RIGHT_CLICK_ACTIONS]).toEqual(["menu", "copy-or-paste", "paste"]);
    for (const choice of RIGHT_CLICK_ACTIONS) {
      const settings = settingsOf(`{ "terminal": { "rightClick": "${choice}" } }`);
      expect(terminalOptionsOf(settings).rightClick).toBe(choice);
    }
  });

  it("changes nothing else of the options", () => {
    const options = terminalOptionsOf({ rightClick: "copy-or-paste" });
    expect({ ...options, rightClick: "menu" }).toEqual(DEFAULT_TERMINAL_OPTIONS);
  });

  it("refuses a choice it does not have, naming the setting", () => {
    for (const value of ['"native"', '"copy"', '""', "1", "true", "null"]) {
      const result = parseConfigText(`{ "terminal": { "rightClick": ${value} } }`);
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.path, value).toBe("terminal.rightClick");
    }
  });

  it("is in the JSON Schema with its choices and its default", () => {
    const schema = configJsonSchema() as {
      properties: {
        terminal: { properties: Record<string, { default?: unknown; enum?: string[] }> };
      };
    };
    const entry = schema.properties.terminal.properties["rightClick"];
    expect(entry?.default).toBe("menu");
    expect(entry?.enum).toEqual(["menu", "copy-or-paste", "paste"]);
  });
});
