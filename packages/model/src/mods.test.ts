import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MOD_LAYER_ORDER,
  isReservedModName,
  isValidModFileName,
  modWarnings,
  movedMod,
  planMods,
  sameModList,
  withMod,
  wrapModCss,
} from "./mods";

describe("isValidModFileName", () => {
  // The same cases as `mod_file_names_are_plain_names_ending_in_dot_css` in crates/noren-core/src/mods.rs:
  // the two sides must agree on what a mod file is.
  const VALID = [
    "a.css",
    "compact-tabs.css",
    "Sidebar_v2.css",
    "dark.theme.css",
    "7.css",
    "con-x.css",
    "nul2.css",
    `${"a".repeat(64)}.css`,
  ];
  const INVALID = [
    "",
    ".css",
    "css",
    "a",
    "a.CSS",
    "a.css ",
    "a.css.bak",
    "a.txt",
    "-a.css",
    "_a.css",
    ".a.css",
    "a b.css",
    "a/b.css",
    "a\\b.css",
    "../a.css",
    "..\\a.css",
    "a:b.css",
    "a\u0000.css",
    "café.css",
    "con.css",
    "CON.css",
    "Aux.v2.css",
    "com1.css",
    "LPT9.css",
    `${"a".repeat(65)}.css`,
  ];

  it.each(VALID)("accepts %j", (name) => {
    expect(isValidModFileName(name)).toBe(true);
  });

  it.each(INVALID)("refuses %j", (name) => {
    expect(isValidModFileName(name)).toBe(false);
  });

  it("refuses what is not text", () => {
    for (const value of [undefined, null, 3, {}, ["a.css"]]) {
      expect(isValidModFileName(value)).toBe(false);
    }
  });

  it("knows the device names of Windows, in any case, before the first dot", () => {
    for (const name of ["con", "CON", "Prn.v2", "aux", "nul", "com1", "lpt9", "COM9.x"]) {
      expect(isReservedModName(name)).toBe(true);
    }
    for (const name of ["console", "com0", "com10", "lpt0", "x.con", "nul2"]) {
      expect(isReservedModName(name)).toBe(false);
    }
  });

  it("never lets a path through", () => {
    // Names near the rule, so a valid one turns up now and then.
    const near = fc.stringMatching(/^[A-Za-z0-9._\\/:-]{0,12}(\.css)?$/);
    fc.assert(
      fc.property(fc.oneof(fc.string(), near), (name) => {
        if (isValidModFileName(name)) {
          // Only ASCII letters and digits, and the three marks of the rule: no separator, no drive
          // letter, no control character, nothing a path is made of.
          expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
          expect(name.startsWith(".")).toBe(false);
          expect(name.endsWith(".css")).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe("wrapModCss", () => {
  const wrapped = (css: string): string => {
    const result = wrapModCss(css);
    if (!result.ok) throw new Error(result.reason);
    return result.css;
  };

  it("wraps the text in the layer, after the statement that fixes the order of the layers", () => {
    const css = ".a { color: red; }\n";
    expect(wrapped(css)).toBe(`${MOD_LAYER_ORDER}\n@layer mods {\n${css}\n}\n`);
    expect(MOD_LAYER_ORDER).toBe("@layer vendor, base, mods;");
  });

  it("keeps the text as it is, comments and line breaks included", () => {
    const css =
      "/* a mod */\r\n.a {\r\n  color: red;\r\n}\r\n@media (min-width: 1px) { .b { top: 0 } }";
    expect(wrapped(css)).toContain(css);
  });

  it("drops a byte order mark, which would join the first selector", () => {
    const css = wrapped("﻿.a { top: 0 }");
    expect(css).not.toContain("﻿");
    expect(css).toContain("@layer mods {\n.a { top: 0 }");
  });

  it("wraps an empty file and one with only a comment", () => {
    expect(wrapped("")).toBe(`${MOD_LAYER_ORDER}\n@layer mods {\n\n}\n`);
    expect(wrapped("/* nothing yet */")).toContain("/* nothing yet */");
  });

  it("refuses a closing brace that closes nothing, saying the line", () => {
    const result = wrapModCss(".a { top: 0 }\n}\n.b { top: 1 }");
    expect(result).toEqual({
      ok: false,
      reason: 'line 2 has a "}" that closes nothing, which would end the mod\'s layer early',
    });
    expect(wrapModCss("}").ok).toBe(false);
    expect(wrapModCss("} body { outline: 1px solid red } .x {").ok).toBe(false);
  });

  it("does not count a brace in a comment, a string or an address", () => {
    const texts = [
      "/* } */ .a { top: 0 }",
      '.a::after { content: "}" }',
      ".a::after { content: '}' }",
      '.a::after { content: "\\"}" }',
      ".a { background: url(data:image/svg+xml,%3Csvg%3E}%3C/svg%3E) }",
      ".a { background: URL( data:x,} ) }",
      '.a { background: url("x}") }',
      ".a { background: url(x\\)}) }",
    ];
    for (const text of texts) expect(wrapModCss(text).ok, text).toBe(true);
  });

  it("counts a brace in a name that only ends in url", () => {
    // `my-url(` is not the function, so its contents are read as CSS and the `}` closes nothing.
    expect(wrapModCss(".a { top: my-url(} ) }").ok).toBe(false);
    // Nor are a hash, an at-keyword, a number with a unit or a name with a dash before it.
    for (const head of ["#url(", "@url(", "5url(", "-url(", "--url(", "x_url("]) {
      expect(wrapModCss(`.a { top: ${head}} ) }`).ok, head).toBe(false);
    }
  });

  it("reads url( written with escapes the way CSS does", () => {
    // `\75 rl(` is `url(`: the address runs to the parenthesis and its braces are not braces.
    expect(wrapModCss(".a { background: \\75 rl(}) }").ok).toBe(true);
    expect(wrapModCss(".a { background: U\\52 L( } ) }").ok).toBe(true);
    expect(wrapModCss(".a { background: \\000075rl(x}) }").ok).toBe(true);
    // Found by the end-to-end test that feeds hostile texts to a real browser: the address of this
    // `url(` runs to the first parenthesis, so the `}` after it closes nothing.
    expect(wrapModCss("\\75 rl(@media all {')}.x{top:0}:").ok).toBe(false);
  });

  it("does not count an escaped brace, which is a letter of a name", () => {
    expect(wrapModCss(".a\\{b { top: 0 }").ok).toBe(true);
    expect(wrapModCss(".a\\} { top: 0 }").ok).toBe(true);
    expect(wrapModCss(".a\\7b  { top: 0 }").ok).toBe(true);
    expect(wrapModCss(".a { top: 0 } \\}").ok).toBe(true);
    // A backslash before a line break escapes nothing: the brace after the break counts.
    expect(wrapModCss(".a { top: 0 }\\\n}").ok).toBe(false);
  });

  it("closes what the mod leaves open, so the wrapper stays closed", () => {
    expect(wrapped(".a { top: 0")).toBe(`${MOD_LAYER_ORDER}\n@layer mods {\n.a { top: 0\n}\n}\n`);
    expect(wrapped(".a { .b { top: 0")).toContain("top: 0\n}}\n}\n");
    // A comment that is not ended is ended; a string ends at the line break the wrapper adds.
    expect(wrapped("/* never ended")).toContain("/* never ended*/\n");
    expect(wrapped('.a { content: "open')).toContain('content: "open\n}\n}\n');
  });

  it("treats a string as ended by a line break that is not escaped", () => {
    // The string ends at the line break, so the brace after it counts: one closes the rule, the
    // next one closes nothing.
    expect(wrapModCss('.a { content: "open\n}').ok).toBe(true);
    expect(wrapModCss('.a { content: "open\n} }').ok).toBe(false);
    // An escaped line break continues the string.
    expect(wrapModCss('.a { content: "open\\\n}" }').ok).toBe(true);
  });

  it("never throws, whatever the text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const result = wrapModCss(text);
        expect(typeof result.ok).toBe("boolean");
      }),
      { numRuns: 1000 },
    );
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom("{", "}", '"', "'", "/*", "*/", "\\", "url(", ")", "(", "\n", "a"),
          {
            maxLength: 40,
          },
        ),
        (pieces) => {
          const result = wrapModCss(pieces.join(""));
          if (result.ok) {
            // Whatever the pieces were, the text starts and ends the way the wrapper writes it.
            expect(result.css.startsWith(`${MOD_LAYER_ORDER}\n@layer mods {\n`)).toBe(true);
            expect(result.css.endsWith("\n}\n")).toBe(true);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("planMods", () => {
  const file = (name: string, text = ".a { top: 0 }") => ({ name, text });
  const files = [file("a.css"), file("b.css"), file("c.css")];

  it("applies the global mods in order, then the ones of the space", () => {
    const plan = planMods(["c.css", "a.css"], ["b.css"], files);
    expect(plan.applied.map((mod) => mod.name)).toEqual(["c.css", "a.css", "b.css"]);
    expect(plan.missing).toEqual([]);
    expect(plan.rejected).toEqual([]);
  });

  it("applies a mod once, where the later list puts it", () => {
    expect(planMods(["a.css", "b.css"], ["a.css"], files).applied.map((mod) => mod.name)).toEqual([
      "b.css",
      "a.css",
    ]);
    expect(planMods(["a.css", "a.css", "b.css"], [], files).applied.map((m) => m.name)).toEqual([
      "a.css",
      "b.css",
    ]);
  });

  it("gives the css already wrapped in its layer", () => {
    const plan = planMods(["a.css"], [], [file("a.css", ".x { top: 1px }")]);
    expect(plan.applied).toEqual([
      { name: "a.css", css: `${MOD_LAYER_ORDER}\n@layer mods {\n.x { top: 1px }\n}\n` },
    ]);
  });

  it("leaves out a name with no file, and keeps going", () => {
    const plan = planMods(["gone.css", "a.css"], ["also-gone.css", "gone.css"], files);
    expect(plan.applied.map((mod) => mod.name)).toEqual(["a.css"]);
    expect(plan.missing).toEqual(["also-gone.css", "gone.css"]);
  });

  it("treats a name that is not a mod name as missing", () => {
    const plan = planMods(["../a.css", "con.css", ""], [], [file("../a.css")]);
    expect(plan.applied).toEqual([]);
    expect(plan.missing).toEqual(["../a.css", "con.css", ""]);
  });

  it("leaves out a mod that would end its layer, with the reason, and keeps the others", () => {
    const plan = planMods(["bad.css", "a.css"], [], [file("bad.css", "} .x {"), file("a.css")]);
    expect(plan.applied.map((mod) => mod.name)).toEqual(["a.css"]);
    expect(plan.rejected).toEqual([
      { name: "bad.css", reason: expect.stringContaining("closes nothing") },
    ]);
  });

  it("applies nothing when nothing is on", () => {
    expect(planMods([], [], files)).toEqual({ applied: [], missing: [], rejected: [] });
  });

  it("says in sentences what it left out", () => {
    const plan = planMods(["gone.css", "bad.css"], [], [file("bad.css", "}")]);
    expect(modWarnings(plan)).toEqual([
      'The mod "gone.css" is turned on but is not in the mods folder, so it is ignored.',
      expect.stringMatching(/^The mod "bad.css" is ignored: line 1 has a "}" that closes nothing/),
    ]);
    expect(modWarnings({ applied: [], missing: [], rejected: [] })).toEqual([]);
  });
});

describe("the lists of mods", () => {
  it("turns a mod on at the end, once, and off", () => {
    expect(withMod(["a.css"], "b.css", true)).toEqual(["a.css", "b.css"]);
    expect(withMod(["a.css", "b.css"], "a.css", true)).toEqual(["a.css", "b.css"]);
    expect(withMod(["a.css", "b.css"], "a.css", false)).toEqual(["b.css"]);
    expect(withMod(["a.css"], "z.css", false)).toEqual(["a.css"]);
  });

  it("moves a mod and stops at the ends", () => {
    const list = ["a.css", "b.css", "c.css"];
    expect(movedMod(list, "a.css", 1)).toEqual(["b.css", "a.css", "c.css"]);
    expect(movedMod(list, "c.css", -1)).toEqual(["a.css", "c.css", "b.css"]);
    expect(movedMod(list, "a.css", -1)).toEqual(list);
    expect(movedMod(list, "c.css", 1)).toEqual(list);
    expect(movedMod(list, "a.css", 5)).toEqual(["b.css", "c.css", "a.css"]);
    expect(movedMod(list, "nope.css", 1)).toEqual(list);
  });

  it("never changes the list it is given", () => {
    const list = Object.freeze(["a.css", "b.css"]);
    expect(withMod(list, "c.css", true)).toEqual(["a.css", "b.css", "c.css"]);
    expect(movedMod(list, "a.css", 1)).toEqual(["b.css", "a.css"]);
  });

  it("compares lists by name and order", () => {
    expect(sameModList(["a.css", "b.css"], ["a.css", "b.css"])).toBe(true);
    expect(sameModList(["a.css", "b.css"], ["b.css", "a.css"])).toBe(false);
    expect(sameModList(["a.css"], [])).toBe(false);
    expect(sameModList([], [])).toBe(true);
  });

  it("moves keep the same names", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom("a.css", "b.css", "c.css", "d.css"), { maxLength: 4 }),
        fc.constantFrom("a.css", "b.css", "z.css"),
        fc.integer({ min: -6, max: 6 }),
        (list, name, delta) => {
          const moved = movedMod(list, name, delta);
          expect([...moved].sort()).toEqual([...list].sort());
        },
      ),
    );
  });
});
