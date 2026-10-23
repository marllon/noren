import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOREN_DUSK, THEMES, contrastRatio } from "@noren/model";
import { SPACE_COLORS } from "./spaces";
import { themeVariables } from "./theme";

// The stylesheet of the dense settings screen (NOR-F20-21b), read as text: what its section may and may not
// hold, so the glass style cannot move, no color is written into it and every word it draws keeps its
// contrast on any color a space can have. That the screen draws with it, and how, is
// e2e/dense-settings.spec.ts.

const here = new URL("./", import.meta.url);
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const stylesCss = strip(readFileSync(new URL("styles.css", here), "utf8"));
const tokensCss = strip(readFileSync(new URL("style-tokens.css", here), "utf8"));

const DENSE = ':root[data-nr-style="dense"]';
/** The first rule of the dense settings section, which comes right after the dense window section. */
const START = `${DENSE} .dialog-backdrop:has(> .settings-dialog) {`;
/** The first rule of the glass section, which comes after it. */
const END = ".glass-backdrop {";

const section = (): string => {
  const start = stylesCss.indexOf(START);
  const end = stylesCss.indexOf(END);
  expect(
    start,
    "the dense settings section starts with the backdrop of the screen",
  ).toBeGreaterThan(0);
  expect(end, "the glass section is there").toBeGreaterThan(start);
  return stylesCss.slice(start, end);
};

/** Every selector of a block of rules, one by one: a list is split at its commas, a block of an at-rule is read too. */
function selectorsOf(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let head = "";
  for (const char of css) {
    if (char === "{") {
      const text = head.trim();
      if (!text.startsWith("@")) {
        for (const part of text.split(",")) if (part.trim() !== "") out.push(part.trim());
      }
      head = "";
      depth += 1;
    } else if (char === "}") {
      head = "";
      depth -= 1;
    } else {
      head += char;
    }
  }
  expect(depth).toBe(0);
  return out;
}

/** The text between the braces of the first rule whose selector is `selector` alone. */
function rule(selector: string): string {
  const text = section();
  const start = text.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return text.slice(text.indexOf("{", start) + 1, text.indexOf("}", start));
}

describe("the dense settings section of the stylesheet", () => {
  it("comes after the dense window section and before the glass section, so the test that keeps the glass section under its own attribute still holds", () => {
    const window = stylesCss.indexOf(`${DENSE} .app .titlebar {`);
    expect(window).toBeGreaterThan(0);
    expect(stylesCss.indexOf(START)).toBeGreaterThan(window);
    expect(stylesCss.indexOf(START)).toBeLessThan(stylesCss.indexOf(END));
  });

  it("keeps every rule under the dense attribute, so the glass style does not move", () => {
    const selectors = selectorsOf(section());
    expect(selectors.length).toBeGreaterThan(150);
    for (const selector of selectors) {
      expect(selector.startsWith(DENSE), selector).toBe(true);
    }
  });

  it("lists no alternatives inside a function (the test above reads every comma as the end of a selector)", () => {
    for (const selector of selectorsOf(section())) {
      expect(selector, selector).not.toMatch(/:(?:is|where|not|has)\([^)]*,/);
    }
  });

  it("writes no color: everything is a token, a mix of tokens or a keyword", () => {
    const text = section();
    expect(text).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(text).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
  });

  it("asks only for variables that something sets", () => {
    const text = section();
    const defined = new Set<string>([
      ...[...tokensCss.matchAll(/(--[a-z-]+)\s*:/g)].map((match) => match[1] ?? ""),
      ...Object.keys(themeVariables(NOREN_DUSK)),
      // Set by the page: the color of the active space.
      "--nr-space-color",
      // Set by a component: how far a slider is (Slider) and the colors of a theme in its miniature (ThemeThumbnail).
      "--nr-slider-fill",
      "--thumb-term-bg",
      "--thumb-term-fg",
      // Set by a rule of the section itself, on the dialog.
      ...[...text.matchAll(/(--settings-[a-z-]+)\s*:/g)].map((match) => match[1] ?? ""),
    ]);
    const used = new Set([...text.matchAll(/var\((--[a-z-]+)/g)].map((match) => match[1] ?? ""));
    expect(used.size).toBeGreaterThan(15);
    for (const name of used) expect(defined.has(name), name).toBe(true);
  });

  it("draws the highlight of the space where the screen is lit, never the accent of the theme", () => {
    const text = section();
    expect(text).not.toContain("--nr-accent");
    expect(text).toContain("var(--nr-highlight)");
  });

  it("draws every word it generates with a text alternative that is empty, so a screen reader hears the real name only", () => {
    // (`content:` alone: not `justify-content:` and the like.)
    const generated = [...section().matchAll(/(?<![-\w])content:\s*([^;]+);/g)].map(
      (match) => match[1] ?? "",
    );
    expect(generated.length).toBeGreaterThanOrEqual(7);
    for (const value of generated) {
      // An empty `content: ""` is a box, not a word; the rest (a number, a check, a key, a mark) has a text alternative.
      if (value.trim() === '""') continue;
      expect(value, value).toMatch(/\/\s*""\s*$/);
    }
  });

  it("keeps the strips and the controls at the size of the design", () => {
    expect(rule(`${DENSE} .space-dialog.settings-dialog`)).toContain(
      "grid-template-rows: 32px auto minmax(0, 1fr) auto",
    );
    expect(rule(`${DENSE} .settings-header h2`)).toContain("height: 32px");
    expect(rule(`${DENSE} .settings-search-field`)).toContain("height: 30px");
    expect(rule(`${DENSE} .settings-nav-item`)).toContain("height: 26px");
    expect(rule(`${DENSE} .settings-footer`)).toContain("min-height: 24px");
    expect(rule(`${DENSE} .settings-dialog .settings-switch`)).toMatch(
      /width: 36px;[\s\S]*height: 18px/,
    );
    expect(rule(`${DENSE} .settings-dialog .settings-switch::after`)).toMatch(
      /width: 12px;[\s\S]*height: 12px/,
    );
    expect(rule(`${DENSE} .settings-dialog .settings-link`)).toContain("min-height: 24px");
    expect(rule(`${DENSE} .settings-style-thumb`)).toMatch(/width: 120px;[\s\S]*height: 70px/);
    expect(rule(`${DENSE} .space-dialog.settings-dialog`)).toContain("--settings-nav: 220px");
    expect(rule(`${DENSE} .settings-sections`)).toContain("max-width: 880px");
  });

  it("is square: no corner is rounded but the key that closes the screen, the little pictures of the two styles and the track and the handle of a slider", () => {
    const radiusOf = (body: string): string[] =>
      [...body.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => (match[1] ?? "").trim());
    const rounded = [...section().matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, , body]) => radiusOf(body ?? "").some((value) => value !== "0"))
      .map(([, selector]) => (selector ?? "").trim().replace(/\s+/g, " "));
    expect(rounded.sort()).toEqual(
      [
        `${DENSE} .settings-close`,
        `${DENSE} .settings-style-side, ${DENSE} .settings-style-main`,
        `${DENSE} .settings-style-thumb`,
        `${DENSE} .settings-content .settings-number > .settings-slider::-webkit-slider-runnable-track`,
        `${DENSE} .settings-content .settings-number > .settings-slider::-webkit-slider-thumb`,
      ].sort(),
    );
  });

  it("gives a section name one line, cut inside its own box if the column is narrower than its name (finding 343)", () => {
    const item = rule(`${DENSE} .settings-nav-item`);
    expect(item).toContain("white-space: nowrap");
    expect(item).toContain("text-overflow: ellipsis");
    expect(item).toContain("overflow: hidden");
    expect(item).toContain("display: block");
  });

  it("numbers the sections with a counter, not with words in the page", () => {
    const text = section();
    expect(text).toContain("counter-reset: settings-section");
    expect(text).toContain("counter-increment: settings-section");
    expect(text).toContain('content: counter(settings-section, decimal-leading-zero) / ""');
  });

  it("does not move a thing: a transition of the base is the only motion left (the one reduced-motion turns off)", () => {
    expect(section()).not.toMatch(/\b(?:animation|transition)\s*:/);
  });
});

// The words of the screen drawn in the color of the highlight are pulled toward the text, so they keep their
// contrast whatever color a space has and whatever theme is on. The mix and the surfaces are the ones of
// the section and of style-tokens.css; the arithmetic is done here, over the real themes and the real colors.

type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((at) => Number.parseInt(value.slice(at, at + 2), 16)) as Rgb;
};
const toHex = (rgb: Rgb): string =>
  `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
/** `color-mix(in srgb, a share%, b)`, as the browser works it out for two opaque colors. */
const mix = (a: string, share: number, b: string): string => {
  const [x, y] = [toRgb(a), toRgb(b)];
  return toHex([0, 1, 2].map((at) => (x[at] ?? 0) * share + (y[at] ?? 0) * (1 - share)) as Rgb);
};

describe("the colors of the words of the screen", () => {
  it("states the mixes the arithmetic below follows", () => {
    const text = section();
    expect(text).toContain(
      "--settings-on: color-mix(in srgb, var(--nr-highlight) 45%, var(--nr-text))",
    );
    expect(rule(`${DENSE}[data-nr-scheme="light"] .space-dialog.settings-dialog`)).toContain(
      "--settings-on: color-mix(in srgb, var(--nr-highlight) 15%, var(--nr-text))",
    );
    expect(text).toContain(
      "--settings-soft: color-mix(in srgb, var(--nr-highlight) 14%, transparent)",
    );
    expect(tokensCss).toMatch(
      /--nr-bar-bg:\s*color-mix\(in srgb, var\(--nr-bg\) 55%, var\(--nr-surface\)\)/,
    );
    expect(rule(`${DENSE} .settings-nav-item`)).toContain(
      "color: color-mix(in srgb, var(--nr-muted) 30%, var(--nr-text))",
    );
  });

  // The gray of a theme (muted) is only held to 3:1 by the model, and the text of the weakest themes (Noren Dune
  // is 4.7:1 on its own page) leaves little room to a mix: the two themes the app starts with are held to
  // 4.5:1 (the e2e spec runs axe over those two as well) and the other six to 3:1 (the floor the model holds the gray of every theme to), on every color of a space.
  for (const theme of THEMES) {
    const floor = theme.id === "noren-dusk" || theme.id === "noren-paper" ? 4.5 : 3;
    it(`keep ${floor}:1 in ${theme.name}, on any of the ${SPACE_COLORS.length} colors a space can have`, () => {
      const { bg, surface, text, muted } = theme.ui;
      const bar = mix(bg, 0.55, surface);
      if (theme.id === "noren-dusk" || theme.id === "noren-paper") {
        // The names of the sections, the numbers, the file name and the explanations.
        const grays = [
          ["a section name", mix(muted, 0.3, text), bar],
          ["a number and the file name", muted, bar],
          ["an explanation", muted, bg],
        ] as const;
        for (const [what, color, under] of grays) {
          expect(contrastRatio(color, under), what).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const { value: highlight } of SPACE_COLORS) {
        // 45% of the highlight on a dark theme, 15% on a light one (the two rules above).
        const on = mix(highlight, theme.kind === "light" ? 0.15 : 0.45, text);
        // A word in the color of the highlight, over the column, over the page, and over the tint of the
        // current section (14% of the highlight over the strip) or of the chosen card or theme.
        const lit = (under: string): string => mix(highlight, 0.14, under);
        for (const [what, under] of [
          ["the slash of the search, over the strip", bar],
          ["a word over the page", bg],
          ["the number of the current section", lit(bar)],
          ["the mark of the theme or the card in use", lit(bg)],
          ["the mark of the card in use, over the field", lit(bar)],
        ] as const) {
          expect(contrastRatio(on, under), `${what}, ${highlight}`).toBeGreaterThanOrEqual(floor);
        }
        // The text of the section that is current keeps its contrast over its tint.
        expect(
          contrastRatio(text, lit(bar)),
          `a current name, ${highlight}`,
        ).toBeGreaterThanOrEqual(floor);
      }
    });
  }
});

describe("what docs/THEMING.md says of the dense settings screen", () => {
  const root = new URL("../../../", import.meta.url);
  const doc = readFileSync(new URL("docs/THEMING.md", root), "utf8");
  const source = readFileSync(new URL("SettingsDialog.tsx", here), "utf8");

  it("lists the one new part, and the app has it", () => {
    expect(doc).toContain("| `settings-crumb`");
    expect(source).toContain('data-nr-part="settings-crumb"');
  });

  it("has its section, tells what the design shows and the app has not, and says the glass screen did not move", () => {
    expect(doc).toContain("### The dense settings screen");
    const text = doc.slice(doc.indexOf("### The dense settings screen"));
    for (const left of ["ctrl+f", "open config.jsonc", "salvo 21:58"]) {
      expect(text, left).toContain(left);
    }
    expect(text).toContain("the glass screen does not move");
    // The sentences of the older sections that said the dense screen had its old look are gone.
    expect(doc).not.toContain("the dense screen keeps its size (960 by 720 px)");
    expect(doc).not.toContain("a row of two buttons, as it had");
  });
});
