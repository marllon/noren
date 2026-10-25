import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOREN_DUSK, contrastRatio } from "@noren/model";
import { SPACE_COLORS } from "./spaces";
import { themeVariables } from "./theme";

// The stylesheet of the dense window (NOR-F20-21a), read as text: what the dense section may and may not
// hold, so the glass style cannot move and no color is written into it. That the page draws with it, and
// how, is e2e/dense-window.spec.ts.

const here = new URL("./", import.meta.url);
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const stylesCss = strip(readFileSync(new URL("styles.css", here), "utf8"));
const tokensCss = strip(readFileSync(new URL("style-tokens.css", here), "utf8"));

const DENSE = ':root[data-nr-style="dense"]';
/**
 * The first rule of the dense window section and the first of the dense settings section (NOR-F20-21b,
 * tested in dense-settings.test.ts), which comes right after it; the glass section follows that one.
 */
const START = `${DENSE} .app .titlebar {`;
const END = `${DENSE} .dialog-backdrop:has(> .settings-dialog) {`;

const section = (): string => {
  const start = stylesCss.indexOf(START);
  const end = stylesCss.indexOf(END);
  expect(start, "the dense section starts with the title bar").toBeGreaterThan(0);
  expect(end, "the dense settings section is there").toBeGreaterThan(start);
  return stylesCss.slice(start, end);
};

/** Every selector of a block of rules, one by one (a list is split at its commas). */
function selectorsOf(css: string): string[] {
  return [...css.matchAll(/(?:^|\})\s*([^{}@]+)\{/g)].flatMap((match) =>
    (match[1] ?? "")
      .split(",")
      .map((selector) => selector.trim())
      .filter((selector) => selector !== ""),
  );
}

describe("the dense window section of the stylesheet", () => {
  it("comes before the glass section, so the test that keeps the glass section under its own attribute still holds", () => {
    expect(stylesCss.indexOf(START)).toBeLessThan(stylesCss.indexOf(END));
    expect(stylesCss.indexOf(END)).toBeLessThan(stylesCss.indexOf(".glass-backdrop {"));
  });

  it("keeps every rule under the dense attribute, so the glass style does not move", () => {
    const selectors = selectorsOf(section());
    expect(selectors.length).toBeGreaterThan(150);
    for (const selector of selectors) {
      expect(selector.startsWith(DENSE), selector).toBe(true);
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
      ...[...tokensCss.matchAll(/(--nr-[a-z-]+)\s*:/g)].map((match) => match[1] ?? ""),
      ...Object.keys(themeVariables(NOREN_DUSK)),
      // Set by the page: the color of the active space, the surface at the opacity of the window.
      "--nr-space-color",
      "--nr-surface-glass",
      // Set inline on each block of the Projects section: the color of its space.
      "--nr-project-color",
      // Set by a rule of the section itself, for the agent ring of a pane.
      "--agent-color",
    ]);
    const used = new Set([...text.matchAll(/var\((--[a-z-]+)/g)].map((match) => match[1] ?? ""));
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) expect(defined.has(name), name).toBe(true);
  });

  it("gives the pane header the width of the pane to decide by, and lets it give way in steps", () => {
    const text = section();
    expect(text).toContain("container-type: inline-size");
    for (const width of [300, 240, 150, 100, 480]) {
      expect(text, `${width}px`).toContain(`@container (max-width: ${width}px)`);
    }
  });

  it("keeps the strips of the window at the height of the design", () => {
    const text = section();
    const heightOf = (selector: string): string | undefined =>
      new RegExp(`${selector.replace(/[.\\[\]"=-]/g, "\\$&")} \\{[^}]*?\\bheight: (\\d+px)`).exec(
        text,
      )?.[1];
    expect(heightOf(`${DENSE} .app .titlebar`)).toBe("32px");
    expect(heightOf(`${DENSE} .app .pane-bar`)).toBe("24px");
    expect(heightOf(`${DENSE} .app-body .space-switcher`)).toBe("30px");
    expect(heightOf(`${DENSE} .app-body .sidebar-settings`)).toBe("28px");
    expect(text).toMatch(/\.dense-toolbar \{[^}]*min-height: 30px/);
    expect(text).toMatch(/\.status-bar \{[^}]*min-height: 24px/);
  });

  it("gives a long name an ellipsis inside its own box", () => {
    const text = section();
    for (const selector of [
      ".titlebar-crumb-text",
      ".space-label",
      ".favorite-label",
      ".sidebar-agent-name",
      ".pane-bar-title",
      ".pane-bar-path",
    ]) {
      const rule = new RegExp(`${selector.replace(".", "\\.")} \\{[^}]*text-overflow: ellipsis`);
      expect(text, selector).toMatch(rule);
    }
  });
});

describe("what the dense window adds to the tokens", () => {
  /** The text between the braces of the first rule that is `selector` alone. */
  const rule = (selector: string): string => {
    const start = tokensCss.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return tokensCss.slice(tokensCss.indexOf("{", start) + 1, tokensCss.indexOf("}", start));
  };

  it("works the strips and the tints out from the theme, in a block the two styles share", () => {
    // The last bare `:root` block of the file.
    const at = tokensCss.lastIndexOf(":root {");
    const block = tokensCss.slice(tokensCss.indexOf("{", at) + 1, tokensCss.indexOf("}", at));
    for (const name of [
      "--nr-bar-bg",
      "--nr-chip-bg",
      "--nr-head-bg",
      "--nr-waiting-text",
      "--nr-running-text",
    ]) {
      expect(block, name).toContain(`${name}:`);
    }
    // They are not part of a token set of a style (those have the same names in both).
    expect(rule(`${DENSE}`)).not.toContain("--nr-bar-bg");
    expect(rule(':root[data-nr-style="glass"]')).not.toContain("--nr-bar-bg");
  });

  it("pulls the state colors toward the text where they are the color of words", () => {
    expect(tokensCss).toMatch(
      /--nr-waiting-text:\s*color-mix\(in srgb, var\(--nr-state-waiting\) 70%, var\(--nr-text\)\)/,
    );
    expect(tokensCss).toMatch(
      /--nr-running-text:\s*color-mix\(in srgb, var\(--nr-state-running\) 70%, var\(--nr-text\)\)/,
    );
  });
});

describe("the four highlight colors of the dense design", () => {
  it("are colors a space can have, and the dark text of the status bar keeps 4.5:1 on every one", () => {
    const dense = ["#2ee6d6", "#b4ff39", "#ffb547", "#ff5ca8"];
    const values = SPACE_COLORS.map((color) => color.value);
    const onHighlight = /--nr-on-highlight:\s*(#[0-9a-f]{6})/i.exec(tokensCss)?.[1] ?? "";
    expect(onHighlight).not.toBe("");
    for (const color of dense) {
      expect(values, color).toContain(color);
      expect(contrastRatio(onHighlight, color), color).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("the hover corner of a pane", () => {
  it("is gone from the stylesheet: both styles give a terminal pane a header with the buttons in sight", () => {
    expect(stylesCss).not.toContain("pane-corner");
  });
});
