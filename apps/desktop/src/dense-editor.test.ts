import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOREN_DUSK, THEMES, contrastRatio } from "@noren/model";
import { SPACE_COLORS } from "./spaces";
import { themeVariables } from "./theme";

// The stylesheet of the dense theme editor (NOR-F20-21c), read as text: what its section may and may not
// hold, so the glass editor and the settings screen cannot move, no color is written into it, nothing in it
// reaches a thing that is not the editor and every word it draws keeps its contrast on any theme and any
// color a space can have. That the editor draws with it, and how, is e2e/dense-editor.spec.ts.

const here = new URL("./", import.meta.url);
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const stylesCss = strip(readFileSync(new URL("styles.css", here), "utf8"));
const tokensCss = strip(readFileSync(new URL("style-tokens.css", here), "utf8"));

const DENSE = ':root[data-nr-style="dense"]';
/** The first rule of the dense theme editor section, which comes right after the dense settings section. */
const START = `${DENSE} .dialog-backdrop:has(> .theme-editor) {`;
/** The first rule of the glass section, which comes after it. */
const END = ".glass-backdrop {";

const section = (): string => {
  const start = stylesCss.indexOf(START);
  const end = stylesCss.indexOf(END);
  expect(start, "the section starts with the backdrop of the editor").toBeGreaterThan(0);
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

describe("the dense theme editor section of the stylesheet", () => {
  it("comes after the dense settings section and before the glass section, so the test that keeps the glass section under its own attribute still holds", () => {
    const settings = stylesCss.indexOf(`${DENSE} .dialog-backdrop:has(> .settings-dialog) {`);
    expect(settings).toBeGreaterThan(0);
    expect(stylesCss.indexOf(START)).toBeGreaterThan(settings);
    expect(stylesCss.indexOf(START)).toBeLessThan(stylesCss.indexOf(END));
  });

  it("keeps every rule under the dense attribute, so the glass style does not move", () => {
    const selectors = selectorsOf(section());
    expect(selectors.length).toBeGreaterThan(120);
    for (const selector of selectors) {
      expect(selector.startsWith(DENSE), selector).toBe(true);
    }
  });

  it("reaches nothing but the editor: every selector names it (the editor is a portal outside the settings screen, and a rule without that reach leaks into what shares a class with it)", () => {
    for (const selector of selectorsOf(section())) {
      expect(selector, selector).toMatch(/\.theme-editor\b/);
      // And none of the screens the editor is opened from or shares classes with.
      expect(selector, selector).not.toMatch(
        /\.settings-dialog|\.settings-content|\.settings-sections/,
      );
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
      // Set by a component: how far a slider is (Slider) and the column of a color of the table (ThemeEditorDialog).
      "--nr-slider-fill",
      "--ansi-at",
      // Set by a rule of the section itself, on the dialog or on a slider.
      ...[...text.matchAll(/(--editor-[a-z-]+)\s*:/g)].map((match) => match[1] ?? ""),
    ]);
    const used = new Set([...text.matchAll(/var\((--[a-z-]+)/g)].map((match) => match[1] ?? ""));
    expect(used.size).toBeGreaterThan(14);
    for (const name of used) expect(defined.has(name), name).toBe(true);
  });

  it("draws the highlight of the space where the editor is lit, never the accent of the theme", () => {
    const text = section();
    expect(text).not.toContain("--nr-accent");
    expect(text).toContain("var(--nr-highlight)");
  });

  it("draws every word it generates with a text alternative that is empty, so a screen reader hears the real name only", () => {
    const generated = [...section().matchAll(/(?<![-\w])content:\s*([^;]+);/g)].map(
      (match) => match[1] ?? "",
    );
    expect(generated.length).toBeGreaterThanOrEqual(1);
    for (const value of generated) {
      if (value.trim() === '""') continue;
      expect(value, value).toMatch(/\/\s*""\s*$/);
    }
  });

  it("keeps the strips, the rows and the controls at the size of the design", () => {
    const dialog = rule(`${DENSE} .space-dialog.theme-editor`);
    expect(dialog).toContain("grid-template-rows: 32px minmax(0, 1fr) auto auto 24px");
    expect(dialog).toContain("--editor-label: 130px");
    expect(dialog).toContain("--editor-props: 320px");
    expect(rule(`${DENSE} .theme-editor > h2`)).toContain("height: 32px");
    expect(rule(`${DENSE} .theme-editor > .dialog-actions button`)).toContain("height: 22px");
    expect(rule(`${DENSE} .theme-editor-footer`)).toContain("min-height: 24px");
    expect(rule(`${DENSE} .theme-editor .theme-editor-group > legend`)).toContain("height: 28px");
    expect(rule(`${DENSE} .theme-editor-group .theme-color`)).toContain("min-height: 30px");
    expect(rule(`${DENSE} .theme-editor input.theme-swatch`)).toMatch(
      /width: 16px;[\s\S]*height: 16px/,
    );
    expect(rule(`${DENSE} .theme-editor .settings-switch`)).toMatch(
      /width: 36px;[\s\S]*height: 18px/,
    );
    expect(rule(`${DENSE} .theme-editor .settings-switch::after`)).toMatch(
      /width: 12px;[\s\S]*height: 12px/,
    );
    expect(rule(`${DENSE} .theme-editor .theme-palette .theme-color-boxes`)).toContain(
      "height: 26px",
    );
    expect(rule(`${DENSE} .theme-editor-group .background-thumb`)).toMatch(
      /width: 48px;[\s\S]*height: 28px/,
    );
    expect(rule(`${DENSE} .theme-editor .settings-link`)).toContain("min-height: 24px");
    expect(rule(`${DENSE} .theme-editor-body`)).toContain(
      "grid-template-columns: minmax(0, 1fr) var(--editor-props)",
    );
  });

  it("is square: no corner is rounded but the track and the handle of a slider", () => {
    const radiusOf = (body: string): string[] =>
      [...body.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => (match[1] ?? "").trim());
    const rounded = [...section().matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, , body]) => radiusOf(body ?? "").some((value) => value !== "0"))
      .map(([, selector]) => (selector ?? "").trim().replace(/\s+/g, " "));
    expect(rounded.sort()).toEqual(
      [
        `${DENSE} .theme-editor-group .settings-number > .settings-slider::-webkit-slider-runnable-track`,
        `${DENSE} .theme-editor-group .settings-number > .settings-slider::-webkit-slider-thumb`,
      ].sort(),
    );
  });

  it("does not move a thing: a transition of the base is the only motion left (the one reduced-motion turns off)", () => {
    expect(section()).not.toMatch(/\b(?:animation|transition)\s*:/);
  });

  it("is a page of the window under its title bar, like the settings screen", () => {
    const backdrop = rule(`${DENSE} .dialog-backdrop:has(> .theme-editor)`);
    expect(backdrop).toContain("inset: 32px 0 0");
    expect(backdrop).toContain("background: var(--nr-bg)");
    const dialog = rule(`${DENSE} .space-dialog.theme-editor`);
    expect(dialog).toContain("width: 100%");
    expect(dialog).toContain("height: 100%");
    expect(dialog).toContain("border-radius: 0");
    expect(dialog).toContain("box-shadow: none");
  });

  it("gives the buttons their place in the header, and the one that saves the highlight with the dark text", () => {
    const save = rule(`${DENSE} .theme-editor > .dialog-actions .primary`);
    expect(save).toContain("background: var(--nr-highlight)");
    expect(save).toContain("color: var(--nr-on-highlight)");
    expect(rule(`${DENSE} .theme-editor > .dialog-actions`)).toContain("grid-area: actions");
    expect(rule(`${DENSE} .theme-editor > h2`)).toContain("grid-area: title");
  });

  it("lays the sixteen colors out as a table of eight columns, which is a list where the column is narrower than eight of them need", () => {
    expect(rule(`${DENSE} .theme-editor .theme-palette`)).toContain(
      "grid-template-columns: 76px repeat(8, minmax(0, 1fr))",
    );
    expect(rule(`${DENSE} .theme-editor-side`)).toContain("container: editor-side / inline-size");
    const text = section();
    expect(text).toContain("@container editor-side (max-width: 719px)");
    // Eight columns of a swatch and seven characters at 11px (6.6px each) with their padding need about 700px.
    expect(rule(`${DENSE} .theme-editor .theme-palette-name`)).toContain(
      "grid-column: calc(var(--ansi-at) + 1)",
    );
  });

  it("breaks a sentence anywhere in the editor, so a path with no space in it cannot push a column sideways", () => {
    const hint = rule(`${DENSE} .theme-editor .settings-hint`);
    expect(hint).toContain("overflow-wrap: anywhere");
    expect(hint).toContain("min-width: 0");
  });

  it("gives the columns that scroll a thin bar, as the settings screen does", () => {
    const text = section();
    for (const part of ["controls", "side", "body"]) {
      expect(text).toMatch(new RegExp(`\\.theme-editor-${part}::-webkit-scrollbar[,{ ]`));
    }
    expect(text).toContain("::-webkit-scrollbar-button");
  });
});

// The words of the editor that are drawn in a color of the state (the green of the reading that holds, the amber of
// the one that does not and of what is unsaved) or in the gray of the theme keep their contrast, whatever theme is on.
// The tokens are the ones of style-tokens.css (mixes of the state color and the text color); the arithmetic is done
// here, over the real themes. The gray of a theme (muted) is only held to 3:1 by the model, so the two
// themes the app starts with (the ones the e2e spec runs axe over) are held to 4.5:1 and the rest to 3:1.

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

/** The state colors of each scheme, as style-tokens.css sets them under the dense style. */
const STATE = {
  dark: { running: "#4ade80", waiting: "#ffb547" },
  light: { running: "#15803d", waiting: "#b45309" },
} as const;

describe("the colors of the words of the editor", () => {
  it("states the mixes the arithmetic below follows", () => {
    expect(tokensCss).toMatch(
      /--nr-bar-bg:\s*color-mix\(in srgb, var\(--nr-bg\) 55%, var\(--nr-surface\)\)/,
    );
    expect(tokensCss).toMatch(
      /--nr-running-text:\s*color-mix\(in srgb, var\(--nr-state-running\) 70%, var\(--nr-text\)\)/,
    );
    expect(tokensCss).toMatch(
      /--nr-waiting-text:\s*color-mix\(in srgb, var\(--nr-state-waiting\) 70%, var\(--nr-text\)\)/,
    );
    expect(tokensCss).toMatch(/--nr-state-running:\s*#4ade80/);
    expect(tokensCss).toMatch(/--nr-state-waiting:\s*#ffb547/);
    expect(tokensCss).toMatch(/--nr-state-running:\s*#15803d/);
    expect(tokensCss).toMatch(/--nr-state-waiting:\s*#b45309/);
    expect(rule(`${DENSE} .theme-editor-group .background-picker-info`)).toContain(
      "color: color-mix(in srgb, var(--nr-muted) 30%, var(--nr-text))",
    );
    expect(rule(`${DENSE} .space-dialog.theme-editor`)).toContain(
      "--editor-hover: color-mix(in srgb, var(--nr-text) 7%, transparent)",
    );
  });

  for (const theme of THEMES) {
    const floor = theme.id === "noren-dusk" || theme.id === "noren-paper" ? 4.5 : 3;
    it(`keep ${floor}:1 in ${theme.name}`, () => {
      const { bg, surface, text, muted } = theme.ui;
      const bar = mix(bg, 0.55, surface);
      const { running, waiting } = STATE[theme.kind];
      const green = mix(running, 0.7, text);
      const amber = mix(waiting, 0.7, text);
      const quiet = mix(muted, 0.3, text);
      const lit = (under: string): string => mix(text, 0.07, under);
      const checks = [
        // The gray: the title, the headings, the hints and the name at the foot sit on the bar or the column; the words of the head of the preview and of the table sit on the page.
        ["the gray on the bars and the column of boxes", muted, bar],
        ["the gray on the page", muted, bg],
        // The reading that holds (green) and the one that does not (amber) sit on the page.
        ["the reading that holds", green, bg],
        ["the reading that does not", amber, bg],
        // The unsaved mark of the crumb, the count at the foot and the strip of a failure sit on the bars.
        ["what is unsaved, on the bars", amber, bar],
        // The name of the picture, between the gray and the text.
        ["the name of the picture, on the column of boxes", quiet, bar],
        // The text of a button or of a kind option under the pointer is a veil of the text over the bar.
        ["the text of a button under the pointer", text, lit(bar)],
        ["the text of the kind under the pointer", text, lit(bg)],
      ] as const;
      for (const [what, front, under] of checks) {
        expect(contrastRatio(front, under), what).toBeGreaterThanOrEqual(floor);
      }
    });
  }

  it("keeps the dark text of a fill of the highlight at 4.5:1 on every color a space can have (the button that saves, the kind that is chosen, the word at the foot)", () => {
    const value = /--nr-on-highlight:\s*(#[0-9a-f]{6})\s*;/i.exec(tokensCss)?.[1];
    expect(value).toBeDefined();
    for (const color of SPACE_COLORS) {
      expect(contrastRatio(value as string, color.value), color.name).toBeGreaterThanOrEqual(4.5);
      // The button that saves, under the pointer: the highlight with 12% of white over it.
      expect(
        contrastRatio(value as string, mix(color.value, 0.88, "#ffffff")),
        color.name,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("what docs/THEMING.md says of the dense theme editor", () => {
  const root = new URL("../../../", import.meta.url);
  const doc = readFileSync(new URL("docs/THEMING.md", root), "utf8");
  const source = readFileSync(new URL("ThemeEditorDialog.tsx", here), "utf8");

  it("lists the new parts, and the app has them", () => {
    for (const part of [
      "theme-editor-crumb",
      "theme-editor-footer",
      "theme-editor-contrast-muted",
    ]) {
      expect(doc, part).toContain(`| \`${part}\``);
      expect(source, part).toContain(`data-nr-part="${part}"`);
    }
  });

  it("has its section, tells what the design shows and the app has not, and says the glass editor did not move", () => {
    expect(doc).toContain("### The dense theme editor");
    const text = doc.slice(doc.indexOf("### The dense theme editor"));
    for (const left of [
      "ctrl+z",
      "exportar .json",
      "themes\\grafite-neon.json",
      "espaço entre painéis",
    ]) {
      expect(text, left).toContain(left);
    }
    expect(text).toContain("the glass editor does not move");
    // The sentences of the older sections that said the dense editor kept its dialog are gone.
    expect(doc).not.toContain("the dense editor keeps its dialog of 1040 px");
  });
});
