import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { NOREN_DUSK, NOREN_PAPER, contrastRatio } from "@noren/model";
import type { Backend, Theme } from "@noren/model";
import { setAppearancePreview } from "./appearance-preview";
import { setLanguage } from "./i18n";
import { SPACE_COLORS } from "./spaces";
import { ThemeEditorDialog } from "./ThemeEditorDialog";

// The theme editor under the two styles (NOR-F20-20): the markup it renders under glass (the name in
// the header, the hint and the reading of the contrast in the head of the preview, the picker with
// the name of the file) and under dense (as it was), the tokens it adds, the section of the style
// sheet read as text and the parts docs/THEMING.md lists. How it looks, edits and saves is in
// e2e/glass-editor.spec.ts (and e2e/theme-editor.spec.ts, which runs under glass).

const here = new URL("./", import.meta.url);
const root = new URL("../../../", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, here), "utf8");
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokensCss = strip(read("style-tokens.css"));
const stylesCss = strip(read("styles.css"));
const doc = readFileSync(new URL("docs/THEMING.md", root), "utf8");

afterEach(() => {
  setLanguage("en");
  setAppearancePreview(undefined);
});

const GLASS = ':root[data-nr-style="glass"]';

/** The text between the braces of the first rule whose selector is `selector`, in `css`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule "${selector}"`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

const backend: Pick<Backend, "pickBackgroundImage" | "readBackgroundImage"> = {
  pickBackgroundImage: () => Promise.resolve(null),
  readBackgroundImage: () => Promise.reject(new Error("no picture")),
};

function render(source: Theme, own = false): string {
  return renderToStaticMarkup(
    <ThemeEditorDialog
      source={source}
      own={own}
      backend={backend}
      onSave={() => Promise.resolve(undefined)}
      onCancel={() => undefined}
    />,
  );
}

/** The markup between the opening of the element that carries `marker` and the opening of the one that carries `next`. */
function between(html: string, marker: string, next: string): string {
  const from = html.indexOf(marker);
  expect(from, marker).toBeGreaterThanOrEqual(0);
  const to = html.indexOf(next, from + marker.length);
  return html.slice(from, to < 0 ? undefined : to);
}

describe("the editor under the glass style (the default)", () => {
  const html = render(NOREN_DUSK);

  it("has the name of the theme in the header, with its label, and not in the first group", () => {
    const name = between(html, 'class="theme-editor-name"', 'class="theme-editor-body"');
    expect(name).toContain('data-nr-field="name"');
    expect(name).toContain('class="theme-editor-name-box"');
    expect(name).toMatch(/<label for="([^"]+)">Name<\/label><input id="\1"/);
    // The first group (the kind) has no name box.
    const general = between(html, 'data-nr-group="general"', 'data-nr-group="accent"');
    expect(general).not.toContain('data-nr-field="name"');
    expect(general).toContain('role="radiogroup"');
    expect(general).toContain("theme-editor-kinds");
  });

  it("puts the title, then the name, then the body, then the buttons, so the keyboard meets the boxes before the buttons", () => {
    const order = [
      html.indexOf("<h2"),
      html.indexOf('class="theme-editor-name"'),
      html.indexOf('class="theme-editor-body"'),
      html.indexOf('class="dialog-actions"'),
    ];
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("puts the hint and the reading of the contrast in the head of the preview, which has the title", () => {
    const head = between(html, 'class="theme-editor-side-head"', 'data-nr-part="theme-preview"');
    expect(head).toContain("<h3>Preview</h3>");
    expect(head).toContain("The preview shows every change at once");
    expect(head).toContain('data-nr-part="theme-editor-contrast"');
    expect(head).toContain('data-nr-state="ok"');
    expect(head).toContain("Text contrast 14.5 : 1");
    // The hint is not under the title of the dialog.
    expect(html.indexOf("theme-editor-hint")).toBeGreaterThan(
      html.indexOf('class="theme-editor-body"'),
    );
  });

  it("draws the marks of the badge as decoration", () => {
    const badge = between(html, 'data-nr-part="theme-editor-contrast"', "</span>");
    expect(badge).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("gives the picker the name of its file", () => {
    expect(html).toContain('data-nr-part="background-picker-name"');
  });

  it("keeps the nine groups, in their order, with their parts", () => {
    const groups = [...html.matchAll(/data-nr-group="([a-z]+)"/g)].map((match) => match[1]);
    expect(groups).toEqual([
      "general",
      "accent",
      "colors",
      "sidebar",
      "terminal",
      "font",
      "corners",
      "transparency",
      "picture",
    ]);
    expect(html).toContain('data-nr-part="theme-editor"');
    expect(html).toContain('data-nr-part="theme-preview"');
    expect(html).toContain('data-nr-part="theme-palette"');
  });

  it("says the reading in Portuguese too", () => {
    setLanguage("pt-BR");
    const pt = render(NOREN_DUSK);
    expect(pt).toContain("Contraste do texto 14.5 : 1");
    expect(pt).toContain(">Nome</label>");
  });

  it("turns the badge to low when the text does not hold the minimum on the background, and says the ratio it has", () => {
    const low: Theme = { ...NOREN_DUSK, ui: { ...NOREN_DUSK.ui, text: NOREN_DUSK.ui.bg } };
    const low1 = render(low);
    expect(low1).toContain('data-nr-state="low"');
    expect(low1).toContain("Text contrast 1.0 : 1");
    // The light theme says its own.
    const paper = render(NOREN_PAPER);
    expect(paper).toContain(
      `Text contrast ${contrastRatio(NOREN_PAPER.ui.text, NOREN_PAPER.ui.bg).toFixed(1)} : 1`,
    );
    expect(paper).toContain('data-nr-state="ok"');
  });
});

describe("the editor under the dense style (NOR-F20-21c)", () => {
  const dense = (): string => {
    setAppearancePreview({ layout: { style: "dense" } });
    return render(NOREN_DUSK);
  };

  it("keeps the name in the first group, with no box in the header", () => {
    const html = dense();
    expect(html).not.toContain("theme-editor-name");
    const general = between(html, 'data-nr-group="general"', 'data-nr-group="accent"');
    expect(general).toContain('data-nr-field="name"');
  });

  it("puts the sentence and the two readings of the contrast in the head of the preview, and the name of the file on the picker", () => {
    const html = dense();
    const head = between(html, 'class="theme-editor-side-head"', 'class="theme-preview"');
    expect(head).toContain("<h3>Preview</h3>");
    expect(head).toContain("theme-editor-hint");
    expect(head).toContain('data-nr-part="theme-editor-contrast"');
    expect(head).toContain('data-nr-part="theme-editor-contrast-muted"');
    expect(html.indexOf("theme-editor-hint")).toBeGreaterThan(
      html.indexOf('class="theme-editor-body"'),
    );
    expect(html).toContain("background-picker-name");
  });

  it("lays the sixteen colors out under the preview, not in the group of the terminal", () => {
    const html = dense();
    const terminal = between(html, 'data-nr-group="terminal"', 'data-nr-group="font"');
    expect(terminal).not.toContain("theme-palette");
    const side = between(html, 'class="theme-editor-side"', 'class="dialog-actions"');
    expect(side.indexOf('class="theme-preview"')).toBeLessThan(
      side.indexOf('data-nr-part="theme-palette"'),
    );
    // Every row says where its column is (the style sheet lays the table out with it).
    for (let at = 1; at <= 8; at += 1) expect(side).toContain(`style="--ansi-at:${at}"`);
  });

  it("draws the crumb (a picture: it is not part of the name of the dialog) and the foot, and says nothing is unsaved until something is", () => {
    const html = dense();
    expect(html).toMatch(
      /<h2 id="[^"]+">Theme editor<span class="theme-editor-crumb" aria-hidden="true"/,
    );
    expect(html).toContain('<span class="theme-editor-crumb-name">Noren Dusk copy</span>');
    expect(html).not.toContain("theme-editor-crumb-unsaved");
    const foot = between(html, 'class="theme-editor-footer"', "</div></div></div>");
    expect(foot).toContain('aria-hidden="true"');
    expect(foot).toContain(">Theme</span>");
    expect(foot).toContain("No changes");
  });

  it("keeps the buttons after the body, as a dialog has them, and the foot after the buttons", () => {
    const html = dense();
    expect(html.indexOf('class="dialog-actions"')).toBeGreaterThan(
      html.indexOf('class="theme-editor-body"'),
    );
    expect(html.indexOf('class="theme-editor-footer"')).toBeGreaterThan(
      html.indexOf('class="dialog-actions"'),
    );
  });

  it("has none of what only the glass editor draws", () => {
    const html = dense();
    expect(html).not.toContain("theme-editor-name-box");
    setAppearancePreview(undefined);
    const glass = render(NOREN_DUSK);
    expect(glass).not.toContain("theme-editor-crumb");
    expect(glass).not.toContain("theme-editor-footer");
    expect(glass).not.toContain("theme-editor-contrast-muted");
  });
});

describe("what the editor adds to the tokens", () => {
  it("--nr-on-highlight keeps 4.5:1 on every color a space can have", () => {
    const value = /--nr-on-highlight:\s*(#[0-9a-f]{6})\s*;/i.exec(tokensCss)?.[1];
    expect(value).toBeDefined();
    for (const color of SPACE_COLORS) {
      expect(contrastRatio(value as string, color.value), color.name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the moon of the landscape is the one of the design, outside the token sets of the styles", () => {
    expect(tokensCss).toMatch(/--nr-sample-glass-moon:\s*#f1e6cc;/i);
    expect(rule(tokensCss, ':root[data-nr-style="glass"]')).not.toContain("--nr-sample-glass-moon");
    expect(rule(tokensCss, ':root[data-nr-style="dense"]')).not.toContain("--nr-on-highlight");
  });
});

describe("the base rule of the editor (finding 352)", () => {
  it("defines the unit the switch is drawn in, which only the settings dialog defined", () => {
    expect(rule(stylesCss, ".space-dialog.theme-editor")).toContain("--su: 8px");
    // The settings dialog still defines its own, and the switch still asks for it.
    expect(rule(stylesCss, ".space-dialog.settings-dialog")).toContain("--su: 8px");
    expect(rule(stylesCss, ".settings-switch")).toContain("calc(var(--su) * 5)");
  });

  it("does not change what the dense editor looked like but for the switch: the kind keeps its label muted", () => {
    expect(rule(stylesCss, ".theme-editor-kind > span:first-child")).toContain(
      "color: var(--nr-muted)",
    );
    expect(rule(stylesCss, ".theme-editor-kinds")).toContain("display: contents");
  });
});

describe("the glass section of the editor", () => {
  // From the first rule of the section to the end of the sheet.
  const section = stylesCss.slice(stylesCss.indexOf(`${GLASS} .space-dialog.theme-editor {`));
  const at = (selector: string): string => rule(section, selector);

  it("makes the dialog the card of the design: the sheet fill and blur, 14px corners, a line and a shadow", () => {
    const card = at(`${GLASS} .space-dialog.theme-editor`);
    expect(card).toContain("background: var(--nr-glass-sheet)");
    expect(card).toContain("backdrop-filter: var(--nr-glass-blur-sheet)");
    expect(card).toContain("border-radius: var(--nr-radius-side)");
    expect(card).toContain("box-shadow: var(--nr-sheet-shadow)");
    expect(card).toContain("width: min(1120px");
    expect(card).toContain("height: min(860px");
    expect(card).toContain("grid-template-rows: minmax(60px, auto)");
  });

  it("sizes the parts as the design does", () => {
    expect(at(`${GLASS} .theme-editor > h2`)).toContain("font-size: 18px");
    expect(at(`${GLASS} .theme-editor-name-box`)).toContain("height: 34px");
    expect(at(`${GLASS} .theme-editor > .dialog-actions button`)).toContain("height: 34px");
    expect(at(`${GLASS} .theme-editor-body`)).toContain(
      "grid-template-columns: minmax(0, 1fr) 360px",
    );
    expect(at(`${GLASS} .theme-editor-group .theme-color-boxes`)).toContain("height: 30px");
    expect(at(`${GLASS} .theme-editor-group input.theme-swatch`)).toContain("width: 22px");
    expect(at(`${GLASS} .theme-editor-group input.theme-swatch`)).toContain("height: 22px");
    expect(at(`${GLASS} .theme-editor-group input.theme-hex`)).toContain(
      "font-family: var(--nr-font-mono)",
    );
    expect(at(`${GLASS} .theme-editor .settings-switch`)).toContain("width: 40px");
    expect(at(`${GLASS} .theme-editor .settings-switch`)).toContain("height: 24px");
    expect(at(`${GLASS} .theme-editor-group .settings-number:has(> .settings-slider)`)).toContain(
      "grid-template-columns: 112px minmax(0, 1fr) 48px",
    );
    expect(at(`${GLASS} .theme-editor-group .background-thumb`)).toContain("width: 54px");
    expect(at(`${GLASS} .theme-editor-group .background-thumb`)).toContain("height: 36px");
  });

  it("asks for the highlight, not for a color, for what is on, filled or focused", () => {
    expect(at(`${GLASS} .theme-editor .settings-switch:checked`)).toContain("var(--nr-highlight)");
    expect(at(`${GLASS} .theme-editor > .dialog-actions .primary`)).toContain(
      "var(--nr-highlight)",
    );
    expect(at(`${GLASS} .theme-editor > .dialog-actions .primary`)).toContain(
      "var(--nr-on-highlight)",
    );
    expect(at(`${GLASS} .theme-editor-name-box:focus-within`)).toContain("var(--nr-highlight)");
    expect(at(`${GLASS} .theme-editor-group .theme-color-boxes:focus-within`)).toContain(
      "var(--nr-highlight)",
    );
  });

  it("draws the landscape behind the preview from the tokens of the design, not from colors of its own", () => {
    expect(at(`${GLASS} .theme-editor .theme-preview`)).toContain(
      "background: var(--nr-sample-glass-sky)",
    );
    expect(at(`${GLASS} .theme-editor .theme-preview::before`)).toContain(
      "background: var(--nr-sample-glass-ridge)",
    );
    expect(at(`${GLASS} .theme-editor .theme-preview::after`)).toContain(
      "background: var(--nr-sample-glass-moon)",
    );
  });

  it("gives the columns that scroll a thin bar with no arrows, in the color of the text (the web view draws a thick one with arrows)", () => {
    for (const column of ["controls", "side", "body"]) {
      expect(section).toContain(`${GLASS} .theme-editor-${column}::-webkit-scrollbar`);
    }
    expect(section).toMatch(/::-webkit-scrollbar \{\s*width: 8px/);
    expect(section).toMatch(/::-webkit-scrollbar-button \{\s*display: none/);
    expect(section).toMatch(
      /::-webkit-scrollbar-thumb \{[^}]*color-mix\(in srgb, var\(--nr-text\) 28%, transparent\)/,
    );
  });

  it("never touches the preview itself: no rule of the section changes a color of the window it draws", () => {
    const window = at(`${GLASS} .theme-editor .tp-window`);
    expect(window).not.toMatch(/background|border|color|radius/);
  });

  it("touches only glass: every selector of the section starts with the glass attribute", () => {
    const selectors = [...section.matchAll(/(?:^|\})\s*([^{}@]+)\{/g)].flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((selector) => selector.trim())
        .filter((selector) => selector !== ""),
    );
    expect(selectors.length).toBeGreaterThan(40);
    for (const selector of selectors) expect(selector.startsWith(GLASS), selector).toBe(true);
  });
});

describe("docs/THEMING.md", () => {
  it("describes the glass editor and what it leaves out of the design", () => {
    expect(doc).toContain("### The glass theme editor");
    expect(doc).toContain("`theme-editor-contrast`");
    expect(doc).toContain("finding 352");
    expect(doc).toContain("the list of themes on the left");
  });

  it("lists the parts of the editor in the table of parts", () => {
    for (const part of ["theme-editor", "theme-preview", "theme-editor-contrast"]) {
      expect(doc, part).toMatch(new RegExp(`\\| \`${part}\`\\s+\\|`));
    }
  });
});
