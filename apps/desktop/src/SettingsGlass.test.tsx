import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { GLASS_PANEL_OPACITY } from "@noren/model";
import { setLanguage, t } from "./i18n";
import { SearchField, SectionIcon, StyleCards } from "./SettingsGlass";
import { SETTINGS_SECTIONS } from "./settings-nav";

// The parts of the glass settings screen the dense one does not have (NOR-F20-19): the icon on each
// section of the column, the magnifier of the search and the two cards of the interface style,
// rendered to markup; the sheet tokens and the rules of the glass section read as text; and the
// parts docs/THEMING.md lists. How the screen looks, writes and answers the keys is in
// e2e/glass-settings.spec.ts.

const here = new URL("./", import.meta.url);
const root = new URL("../../../", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, here), "utf8");
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokensCss = strip(read("style-tokens.css"));
const stylesCss = strip(read("styles.css"));
const doc = readFileSync(new URL("docs/THEMING.md", root), "utf8");

afterEach(() => setLanguage("en"));

/** The text between the braces of the first rule whose selector is `selector`, in `css`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule "${selector}"`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

const GLASS = ':root[data-nr-style="glass"]';

describe("SectionIcon", () => {
  it("is a drawing for each section, hidden from a screen reader, and no two alike", () => {
    const drawn = SETTINGS_SECTIONS.map((section) =>
      renderToStaticMarkup(<SectionIcon section={section} />),
    );
    for (const html of drawn) {
      expect(html).toContain('class="lucide');
      expect(html).toContain("settings-nav-icon");
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('width="16"');
    }
    expect(new Set(drawn).size).toBe(SETTINGS_SECTIONS.length);
  });
});

describe("SearchField", () => {
  it("holds the magnifier and the box it is given, in one frame", () => {
    const html = renderToStaticMarkup(
      <SearchField style="glass">
        <input type="search" aria-label="Search settings" />
      </SearchField>,
    );
    expect(html).toContain('data-nr-part="settings-search-field"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('<input type="search" aria-label="Search settings"');
    // The magnifier comes first, as in the design.
    expect(html.indexOf("<svg")).toBeLessThan(html.indexOf("<input"));
  });

  it("holds the slash of the dense design, and no magnifier, before the box", () => {
    const html = renderToStaticMarkup(
      <SearchField style="dense">
        <input type="search" aria-label="Search settings" />
      </SearchField>,
    );
    expect(html).toContain('data-nr-part="settings-search-field"');
    expect(html).not.toContain("<svg");
    expect(html).toContain('<span class="settings-search-slash" aria-hidden="true">/</span>');
    expect(html.indexOf("settings-search-slash")).toBeLessThan(html.indexOf("<input"));
  });
});

describe("StyleCards", () => {
  const options = [
    { value: "glass", label: "Glass", note: "translucent, rounded corners" },
    { value: "dense", label: "Dense technical", note: "compact, square corners" },
  ] as const;
  const render = (value: "glass" | "dense", hint?: string): string =>
    renderToStaticMarkup(
      <StyleCards
        legend="Interface style"
        field="appearance.style"
        {...(hint === undefined ? {} : { hint })}
        name="settings-style"
        value={value}
        options={options}
        onChange={() => undefined}
      />,
    );

  it("is a group named by its legend, with a radio button for each style in one group of the page", () => {
    const html = render("glass", "Changes the look of the whole app.");
    expect(html).toContain('role="group"');
    expect(html).toMatch(/aria-labelledby="([^"]+)"/);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/name="settings-style"/g)).toHaveLength(2);
    expect(html).toContain("Interface style");
    expect(html).toContain("Changes the look of the whole app.");
  });

  it("marks the one in force as checked, and only that one", () => {
    expect(render("glass").match(/checked=""/g)).toHaveLength(1);
    const dense = render("dense");
    expect(dense.match(/checked=""/g)).toHaveLength(1);
    expect(dense).toMatch(
      /<input[^>]*checked=""[^>]*data-nr-style-option|data-nr-style-option="dense"/,
    );
  });

  it("describes each radio button by the line about its style, so its name is the style alone", () => {
    const html = render("glass");
    for (const option of options) {
      const id = new RegExp(
        `<input type="radio"[^>]*aria-describedby="([^"]+)"[^>]*/?>[\\s\\S]*?id="\\1"[^>]*>${option.note}`,
      ).exec(html);
      // Each card points at the id of its own line.
      expect(id, option.value).not.toBeNull();
    }
    // The line, the mark and the picture are for the eyes: the name of the button is the style.
    expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html).toContain('data-nr-thumb="glass"');
    expect(html).toContain('data-nr-thumb="dense"');
  });

  it("draws the glass as two cards over a landscape and the dense as a ruled grid with a status bar", () => {
    const html = render("glass");
    for (const part of ["settings-style-ridge", "settings-style-side", "settings-style-main"]) {
      expect(html).toContain(part);
    }
    for (const part of [
      "settings-style-bar",
      "settings-style-rail",
      "settings-style-grid",
      "settings-style-status",
    ]) {
      expect(html).toContain(part);
    }
  });

  it("marks each card as a part and as an option of its style, for a mod and for the tests", () => {
    const html = render("glass");
    expect(html.match(/data-nr-part="settings-style-card"/g)).toHaveLength(2);
    expect(html).toContain('data-nr-style-option="glass"');
    expect(html).toContain('data-nr-style-option="dense"');
    expect(html).toContain('data-nr-part="settings-style"');
  });
});

describe("the words of the cards", () => {
  it("say what each style is in both languages, and the line about both styles is not the same", () => {
    const en = [
      t("settings.styleGlassNote"),
      t("settings.styleDenseNote"),
      t("settings.interfaceStyleHint"),
    ];
    setLanguage("pt-BR");
    const pt = [
      t("settings.styleGlassNote"),
      t("settings.styleDenseNote"),
      t("settings.interfaceStyleHint"),
    ];
    for (const text of [...en, ...pt]) expect(text.length).toBeGreaterThan(10);
    expect(new Set(en).size).toBe(3);
    expect(new Set(pt).size).toBe(3);
    expect(pt).not.toEqual(en);
    // The line is a sentence of the design: it says the themes stay.
    expect(pt[2]).toContain("temas");
    expect(en[2]).toContain("themes");
  });
});

describe("the sheet tokens", () => {
  it("fill the card at the opacity of the panes plus 0.12, and blur it by 28px, under glass", () => {
    const glass = rule(tokensCss, `${GLASS}`);
    const fill = /--nr-glass-sheet:\s*([^;]+);/.exec(glass)?.[1] ?? "";
    expect(fill).toContain("var(--nr-bg)");
    const plus = /min\(1, var\(--nr-opacity, ([0-9.]+)\) \+ ([0-9.]+)\)/.exec(fill);
    expect(plus, fill).not.toBeNull();
    expect(Number(plus?.[1])).toBe(GLASS_PANEL_OPACITY);
    expect(Number(plus?.[2])).toBe(0.12);
    expect(glass).toContain("--nr-glass-blur-sheet: blur(28px)");
  });

  it("are solid and sharp under dense, and in both ways of asking for opaque panels under glass", () => {
    const dense = rule(tokensCss, ':root[data-nr-style="dense"]');
    expect(dense).toContain("--nr-glass-sheet: var(--nr-bg)");
    expect(dense).toContain("--nr-glass-blur-sheet: none");
    const media = tokensCss.slice(
      tokensCss.indexOf("@media (prefers-reduced-transparency: reduce)"),
    );
    expect(rule(media, GLASS)).toContain("--nr-glass-sheet: var(--nr-bg)");
    expect(rule(media, GLASS)).toContain("--nr-glass-blur-sheet: none");
    const system = rule(tokensCss, `${GLASS}[data-nr-transparency="reduced"]`);
    expect(system).toContain("--nr-glass-sheet: var(--nr-bg)");
    expect(system).toContain("--nr-glass-blur-sheet: none");
  });

  it("keep the colors of the pictures of the styles and the shadow of the card in the token file, lighter shadow for a light theme", () => {
    const base = rule(tokensCss, ":root");
    for (const name of [
      "--nr-sheet-shadow",
      "--nr-sample-glass-sky",
      "--nr-sample-glass-ridge",
      "--nr-sample-dense-bg",
      "--nr-sample-dense-accent",
    ]) {
      expect(base, name).toContain(name);
    }
    expect(rule(tokensCss, ':root[data-nr-scheme="light"]')).toContain("--nr-sheet-shadow");
    // The sheet of styles.css has no color of its own: it asks for these.
    expect(stylesCss).toContain("var(--nr-sheet-shadow)");
    expect(stylesCss).toContain("var(--nr-sample-glass-sky)");
  });
});

describe("the glass section of the settings screen", () => {
  // From the first rule of the section to the end of the sheet.
  const section = stylesCss.slice(
    stylesCss.indexOf(`${GLASS} .dialog-backdrop:has(> .settings-dialog)`),
  );
  const at = (selector: string): string => rule(stylesCss, selector);

  it("makes the screen the card of the design: 14px corners, the sheet fill and blur, a line and a shadow", () => {
    const card = at(`${GLASS} .space-dialog.settings-dialog`);
    expect(card).toContain("border-radius: var(--nr-radius-side)");
    expect(card).toContain("background: var(--nr-glass-sheet)");
    expect(card).toContain("backdrop-filter: var(--nr-glass-blur-sheet)");
    expect(card).toContain("box-shadow: var(--nr-sheet-shadow)");
    expect(card).toContain("width: min(1120px");
    expect(card).toContain("height: min(860px");
    // The control column is 260px and the labels have a gap of 16px, the nav 232.
    expect(card).toContain("--settings-control: 260px");
    expect(card).toContain("--settings-gap: 16px");
    expect(card).toContain("--settings-nav: 232px");
  });

  it("sizes the parts as the design does", () => {
    expect(at(`${GLASS} .settings-header`)).toContain("height: 60px");
    expect(at(`${GLASS} .settings-header h2`)).toContain("font-size: 18px");
    expect(at(`${GLASS} .settings-search-field`)).toContain("height: 36px");
    expect(at(`${GLASS} .settings-nav-item`)).toContain("min-height: 36px");
    expect(at(`${GLASS} .settings-row`)).toContain("padding: 14px 0");
    expect(at(`${GLASS} .settings-sections`)).toContain("max-width: 780px");
    expect(at(`${GLASS} .settings-dialog .settings-switch`)).toContain("width: 40px");
    expect(at(`${GLASS} .settings-dialog .settings-switch`)).toContain("height: 24px");
    expect(at(`${GLASS} .settings-dialog .settings-link`)).toContain("min-height: 34px");
  });

  it("never cuts the name of a section with an ellipsis: it goes to a second line", () => {
    const label = at(`${GLASS} .settings-nav-label`);
    expect(label).not.toContain("text-overflow");
    expect(label).not.toContain("white-space: nowrap");
    expect(label).toContain("overflow-wrap: anywhere");
  });

  it("asks for the highlight, not for a color, for what is on, chosen or focused", () => {
    expect(at(`${GLASS} .settings-dialog .settings-switch:checked`)).toContain(
      "var(--nr-highlight)",
    );
    expect(at(`${GLASS} .settings-style-card:has(input:checked)`)).toContain("var(--nr-highlight)");
    expect(at(`${GLASS} .settings-content .theme-pick[aria-pressed="true"]`)).toContain(
      "var(--nr-highlight)",
    );
    expect(at(`${GLASS} .settings-search-field:focus-within`)).toContain("var(--nr-highlight)");
  });

  it("touches only glass: every selector of the section starts with the glass attribute", () => {
    const selectors = [...section.matchAll(/(?:^|\})\s*([^{}@]+)\{/g)].flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((selector) => selector.trim())
        .filter((selector) => selector !== ""),
    );
    expect(selectors.length).toBeGreaterThan(100);
    for (const selector of selectors) expect(selector.startsWith(GLASS), selector).toBe(true);
  });
});

describe("the parts docs/THEMING.md lists", () => {
  const parts = [
    "settings-search-field",
    "settings-style",
    "settings-style-card",
    "background-picker-name",
    "background-choose",
    "background-remove",
  ];

  it("has a row for each of the new parts, and the app has the part", () => {
    const source = ["SettingsGlass.tsx", "BackgroundPicker.tsx"].map(read).join("\n");
    for (const part of parts) {
      expect(doc, part).toContain(`| \`${part}\``);
      expect(source, part).toContain(`"${part}"`);
    }
  });

  it("lists the two sheet variables in the table of the style variables", () => {
    expect(doc).toContain("`--nr-glass-sheet`");
    expect(doc).toContain("`--nr-glass-blur-sheet`");
  });
});
