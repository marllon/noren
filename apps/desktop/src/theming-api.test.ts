import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOD_LAYER_ORDER, NOREN_DUSK, wrapModCss } from "@noren/model";
import { themeVariables } from "./theme";

// docs/THEMING.md promises names to the people who write mods. These tests hold the promise to the
// code: every variable the theme sets is documented and the other way round, and every part, state
// and attribute the tables list is there in the source of the interface. The example mods are held
// to the same tables and to the layer wrapper. (That the cascade really works is e2e/mods.spec.ts.)

const here = new URL("./", import.meta.url);
const root = new URL("../../../", import.meta.url);
const doc = readFileSync(new URL("docs/THEMING.md", root), "utf8");

/** The source files of the interface, by name. */
const sources: Record<string, string> = Object.fromEntries(
  readdirSync(here)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name))
    .map((name) => [name, readFileSync(new URL(name, here), "utf8")]),
);

/** The rows of the first table under a heading, as the cells of each row (header and rule left out). */
function tableUnder(heading: string): string[][] {
  const start = doc.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`THEMING.md has no "${heading}"`);
  const lines = doc.slice(start + heading.length + 2).split("\n");
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith("|")) {
      inTable = true;
      const cells = line
        .slice(1, line.lastIndexOf("|"))
        .split("|")
        .map((cell) => cell.trim());
      rows.push(cells);
    } else if (inTable) {
      break;
    }
  }
  // The first row names the columns and the second is the rule under them.
  return rows.slice(2);
}

/** What is between backticks in a cell. */
const code = (cell: string | undefined): string[] =>
  [...(cell ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");

/** The files that set `data-nr-part="name"`. */
const filesWithPart = (name: string): string[] =>
  Object.entries(sources)
    .filter(([, text]) => text.includes(`data-nr-part="${name}"`))
    .map(([file]) => file);

describe("the variables in docs/THEMING.md", () => {
  const documented = tableUnder("#### Variables").map(([name]) => code(name)[0] ?? "");

  it("are exactly the ones the theme sets", () => {
    expect([...documented].sort()).toEqual(Object.keys(themeVariables(NOREN_DUSK)).sort());
  });

  it("are all named --nr-", () => {
    expect(documented.length).toBeGreaterThan(0);
    for (const name of documented) expect(name).toMatch(/^--nr-[a-z-]+$/);
  });
});

describe("the parts in docs/THEMING.md", () => {
  const rows = tableUnder("#### Parts");

  it("lists parts", () => {
    expect(rows.map(([part]) => code(part)[0])).toContain("sidebar");
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  it("each exist in the interface", () => {
    for (const [part] of rows) {
      const name = code(part)[0] ?? "";
      expect(filesWithPart(name), `data-nr-part="${name}"`).not.toEqual([]);
    }
  });

  it("each state is one the part is given in the file that sets the part", () => {
    for (const [part, , states] of rows) {
      const name = code(part)[0] ?? "";
      for (const state of code(states)) {
        const files = filesWithPart(name);
        const given = files.some(
          (file) =>
            (sources[file] ?? "").includes("data-nr-state=") &&
            (sources[file] ?? "").includes(`"${state}"`),
        );
        expect(given, `${name}: data-nr-state="${state}"`).toBe(true);
      }
    }
  });

  it("have no repeats", () => {
    const names = rows.map(([part]) => code(part)[0]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the other attributes in docs/THEMING.md", () => {
  const rows = tableUnder("#### Other attributes");

  it("each exist in the interface", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const [attribute] of rows) {
      const name = code(attribute)[0] ?? "";
      expect(name).toMatch(/^data-nr-[a-z-]+$/);
      const found = Object.values(sources).some((text) => text.includes(`${name}=`));
      expect(found, name).toBe(true);
    }
  });

  it("with the values the interface gives them where the values are written out", () => {
    const indicator = rows.find(([attribute]) => code(attribute)[0] === "data-nr-indicator");
    for (const value of code(indicator?.[2])) {
      const found = Object.values(sources).some((text) =>
        text.includes(`data-nr-indicator="${value}"`),
      );
      expect(found, `data-nr-indicator="${value}"`).toBe(true);
    }
  });
});

describe("the layers", () => {
  const appCss = readFileSync(new URL("app.css", here), "utf8");
  const stylesCss = readFileSync(new URL("styles.css", here), "utf8");

  it("are declared in app.css exactly as every mod declares them", () => {
    const statement = appCss
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .find((line) => line.startsWith("@layer"));
    expect(statement).toBe(MOD_LAYER_ORDER);
  });

  it("put the terminal library in vendor and the style of the app in base, and nothing outside", () => {
    const rules = appCss.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    expect(rules.split("\n").filter((line) => line.trim() !== "")).toEqual([
      MOD_LAYER_ORDER,
      '@import "@xterm/xterm/css/xterm.css" layer(vendor);',
      '@import "./styles.css" layer(base);',
    ]);
    // The stylesheet of the app brings no layer of its own, so a mod is always after all of it.
    expect(stylesCss).not.toMatch(/@layer|@import/);
  });

  it("are the only way the app reaches its CSS", () => {
    expect(sources["main.tsx"]).toContain('import "./app.css";');
    expect(sources["main.tsx"]).not.toContain("styles.css");
    for (const [file, text] of Object.entries(sources)) {
      // A stylesheet imported anywhere else would sit outside the layers, above every mod.
      if (file !== "main.tsx") expect(text, file).not.toMatch(/import\s+["'][^"']*\.css["']/);
      expect(text, file).not.toContain("xterm/css/xterm.css");
    }
  });
});

describe("the example mods in examples/mods", () => {
  const folder = new URL("examples/mods/", root);
  const files = readdirSync(folder).filter((name) => name.endsWith(".css"));
  const partNames = new Set(tableUnder("#### Parts").map(([part]) => code(part)[0]));
  const variables = new Set(tableUnder("#### Variables").map(([name]) => code(name)[0]));

  it("are the three the guide lists", () => {
    const listed = [...doc.matchAll(/^\| `([a-z-]+\.css)` +\|/gm)].map((match) => match[1]);
    expect(files.sort()).toEqual(["accent-bar.css", "dim-unfocused.css", "tinted-sidebar.css"]);
    expect(listed.sort()).toEqual(files);
  });

  it.each(files)("%s is a valid mod name, wraps in the layer and says what it does", (name) => {
    expect(name).toMatch(/^[a-z][a-z0-9-]*\.css$/);
    const text = readFileSync(new URL(name, folder), "utf8");
    expect(text.startsWith("/*")).toBe(true);
    const wrapped = wrapModCss(text);
    expect(wrapped.ok).toBe(true);
  });

  it.each(files)("%s uses only variables, parts and states the guide lists", (name) => {
    const text = readFileSync(new URL(name, folder), "utf8");
    // Comments may name the same things; the rules are what must be listed.
    const rules = text.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, variable] of rules.matchAll(/var\((--[a-z-]+)/g)) {
      expect(variables.has(variable), `${name}: ${variable}`).toBe(true);
    }
    for (const [, part] of rules.matchAll(/\[data-nr-part="([a-z-]+)"\]/g)) {
      expect(partNames.has(part), `${name}: data-nr-part="${part}"`).toBe(true);
    }
    for (const [, attribute] of rules.matchAll(/\[(data-nr-[a-z-]+)/g)) {
      expect(["data-nr-part", "data-nr-state", "data-nr-focused"]).toContain(attribute);
    }
  });

  it.each(files)("%s has no color of its own: it takes them from the theme", (name) => {
    const rules = readFileSync(new URL(name, folder), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\(/i);
  });
});
