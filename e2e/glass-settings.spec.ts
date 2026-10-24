import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { readPixels } from "./png-pixels";
import {
  closeSettings,
  configSaveCount,
  configText,
  denseOf,
  seedConfig,
} from "./settings-fixture";

// The settings screen of the glass style (NOR-F20-19, D23), as in the approved design
// (`vidro-configuracoes`): one card of glass over the window, a header with the title, the search and
// the X, a column of sections with an icon on each, and rows of a label with its explanation on the
// left and its control on the right, with the controls of the design (a switch, a row of buttons in a
// track, a slider with its number in the mono type, boxes, lists and buttons of 34 px), the two cards
// of the interface style, the card of the picture of the background and the gallery of themes. What
// every field writes, the search and the keyboard are what they were: the specs of those run under
// this style (the default) and are not repeated here, except where the control looks or sits
// differently. The dense style does not change, and a test says so. The classic look of the controls
// and the grid of 8 px are checked in the specs they were written in, which start from the dense style.
// Everything runs on the `FakeBackend` of web mode.

interface Hook {
  paneIds(): string[];
  setImagePick(path: string | null): void;
  setSystemTransparencyReduced(reduced: boolean): void;
}
type HookWindow = Window & { __norenTest?: Hook };

type Mode = "dark" | "light";
type Language = "en" | "pt-BR";

const THEME: Record<Mode, string> = { dark: "noren-dusk", light: "noren-paper" };

/** What the screen says in each language, for the names the tests look for. */
const WORDS = {
  en: {
    settings: "Settings",
    close: "Close",
    search: "Search settings",
    style: "Interface style",
    glass: "Glass",
    dense: "Dense technical",
    glassNote: "translucent, rounded corners",
    side: "Sidebar side",
    left: "Left",
    right: "Right",
    paneHeaders: "Pane headers",
    sidebarWidth: "Sidebar width",
    chooseImage: "Choose image…",
    removeImage: "Remove",
    language: "Language",
    nothing: "No setting matches",
  },
  "pt-BR": {
    settings: "Configurações",
    close: "Fechar",
    search: "Buscar nas configurações",
    style: "Estilo da interface",
    glass: "Vidro",
    dense: "Técnico denso",
    glassNote: "translúcido, cantos arredondados",
    side: "Lado da barra lateral",
    left: "Esquerda",
    right: "Direita",
    paneHeaders: "Cabeçalhos dos painéis",
    sidebarWidth: "Largura da barra lateral",
    chooseImage: "Escolher imagem…",
    removeImage: "Remover",
    language: "Idioma",
    nothing: "Nenhuma configuração corresponde",
  },
} as const;

/** A picture of one pixel the fake chooser can hand over. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** The sections of the column, in order: the part name, the name in each language. */
const SECTIONS = [
  ["appearance", "Appearance", "Aparência"],
  ["themes", "Themes", "Temas"],
  ["window", "Window", "Janela"],
  ["background", "Background", "Fundo"],
  ["terminal", "Terminal", "Terminal"],
  ["profiles", "Profiles", "Perfis"],
  ["shortcuts", "Shortcuts", "Atalhos"],
  ["notifications", "Notifications", "Notificações"],
  ["archive", "Auto-archive", "Arquivamento automático"],
  ["ai", "AI", "IA"],
  ["mods", "Mods", "Mods"],
  ["gallery", "Gallery", "Galeria"],
  ["sync", "Sync", "Sincronização"],
  ["updates", "Updates", "Atualizações"],
  ["import", "Import", "Importar"],
] as const;

interface StartOptions {
  language?: Language;
  mode?: Mode;
  style?: "glass" | "dense";
  /** The rest of `appearance`, as JSON text: `"window": { "opacity": 0.3 }`. */
  appearance?: string;
  width?: number;
  height?: number;
  /** Top-level keys of the file, as JSON text: `"mods": ["quiet.css"]`. */
  top?: string;
  /** CSS files for the mods folder (the web build keeps them in the browser storage). */
  mods?: Record<string, string>;
}

/** Opens the page with a settings file, waits for the first pane, and opens the settings screen. */
async function start(page: Page, options: StartOptions = {}): Promise<Locator> {
  const language = options.language ?? "en";
  const mode = options.mode ?? "dark";
  await page.setViewportSize({ width: options.width ?? 1280, height: options.height ?? 800 });
  if (options.mods !== undefined) {
    await page.addInitScript(
      ({ key, value }) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      { key: "noren.web.mods", value: JSON.stringify(options.mods) },
    );
  }
  const lang = language === "pt-BR" ? '"language": "pt-BR", ' : "";
  const more = options.appearance === undefined ? "" : `, ${options.appearance}`;
  const top = options.top === undefined ? "" : `, ${options.top}`;
  await seedConfig(
    page,
    `{ ${lang}"appearance": { "theme": "${THEME[mode]}", "style": "${options.style ?? "glass"}"${more} }${top} }\n`,
  );
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  // The terminal takes the focus once its shell is up; the keyboard waits for that.
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeFocused();
  await page.getByRole("button", { name: WORDS[language].settings, exact: true }).first().click();
  const screen = page.getByRole("dialog", { name: WORDS[language].settings, exact: true });
  await expect(screen).toBeVisible();
  return screen;
}

const rowOf = (screen: Locator, key: string): Locator => screen.locator(`[data-nr-row="${key}"]`);
const sectionOf = (screen: Locator, id: string): Locator =>
  screen.locator(`[data-nr-part="settings-${id}"]`);
const navItem = (screen: Locator, id: string): Locator =>
  screen.locator(`[data-nr-part="settings-nav-${id}"]`);
const searchBox = (screen: Locator): Locator => screen.locator('[data-nr-part="settings-search"]');
const written = (page: Page) => async (): Promise<string> => (await configText(page)) ?? "";

/** One computed property of an element, or of its pseudo-element (`::after`). */
const style = (locator: Locator, property: string, pseudo?: string): Promise<string> =>
  locator.evaluate(
    (element, arg) => getComputedStyle(element, arg.pseudo ?? null).getPropertyValue(arg.property),
    { property, pseudo },
  );

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not on screen");
  return found;
};

interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A computed color as 0 to 255 channels and an alpha, whichever form the browser writes it in. */
function parseColor(css: string): Color {
  const value = css.trim();
  const srgb = /^color\(srgb ([0-9.]+) ([0-9.]+) ([0-9.]+)(?: \/ ([0-9.]+))?\)$/.exec(value);
  if (srgb !== null) {
    const [, r, g, b, a] = srgb;
    return { r: Number(r) * 255, g: Number(g) * 255, b: Number(b) * 255, a: a ? Number(a) : 1 };
  }
  const parts = /^rgba?\(([^)]+)\)$/
    .exec(value)?.[1]
    ?.split(/[\s,/]+/)
    .filter((p) => p !== "");
  if (parts === undefined || parts.length < 3) throw new Error(`not a color: ${css}`);
  return {
    r: Number(parts[0]),
    g: Number(parts[1]),
    b: Number(parts[2]),
    a: parts.length === 4 ? Number(parts[3]) : 1,
  };
}

/** The color of the highlight (the color of the active space) as the page computes it. */
const highlightCss = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = "var(--nr-highlight)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });

const highlight = async (page: Page): Promise<Color> => parseColor(await highlightCss(page));

function expectSameColor(actual: Color, wanted: Color, label: string): void {
  expect(actual.r, `${label} red`).toBeCloseTo(wanted.r, -0.5);
  expect(actual.g, `${label} green`).toBeCloseTo(wanted.g, -0.5);
  expect(actual.b, `${label} blue`).toBeCloseTo(wanted.b, -0.5);
}

const COMBOS: readonly (readonly [Language, Mode])[] = [
  ["en", "dark"],
  ["en", "light"],
  ["pt-BR", "dark"],
  ["pt-BR", "light"],
];

test.describe("the card of glass", () => {
  test("the screen is a card of glass: size, corners, line, blur and fill", async ({ page }) => {
    const screen = await start(page);
    expect(await style(screen, "border-top-left-radius")).toBe("14px");
    expect(await style(screen, "border-top-width")).toBe("1px");
    expect(await style(screen, "backdrop-filter")).toContain("blur(28px)");
    expect(await style(screen, "box-shadow")).not.toBe("none");
    // 0.62 (the glass of the panes) and 0.12 more: it is all text.
    expect(parseColor(await style(screen, "background-color")).a).toBeCloseTo(0.74, 2);
    // A card with the gap of the window around it, at most 1120 by 860.
    const at = await box(screen);
    expect(at.width).toBe(1120);
    expect(at.height).toBe(784);
    expect(at.x).toBe(80);
    expect(at.y).toBe(8);
  });

  test("a big window does not stretch it past 1120 by 860", async ({ page }) => {
    const screen = await start(page, { width: 1600, height: 1000 });
    const at = await box(screen);
    expect(at.width).toBe(1120);
    expect(at.height).toBe(860);
  });

  for (const [alpha, opacity] of [
    [0.42, 0.3],
    [0.82, 0.7],
    [1, 0.88],
    [1, 1],
  ] as const) {
    test(`the fill follows the transparency of the interface: ${opacity} makes ${alpha}`, async ({
      page,
    }) => {
      const screen = await start(page, { appearance: `"window": { "opacity": ${opacity} }` });
      expect(parseColor(await style(screen, "background-color")).a).toBeCloseTo(alpha, 2);
    });
  }

  test("with prefers-reduced-transparency the card is solid and sharp, and keeps its shape", async ({
    page,
  }) => {
    const screen = await start(page);
    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    await expect.poll(async () => parseColor(await style(screen, "background-color")).a).toBe(1);
    expect(await style(screen, "backdrop-filter")).toBe("none");
    expect(await style(screen, "border-top-left-radius")).toBe("14px");
  });

  test("with the transparency effects of the system off the card is solid, and it comes back when they are on", async ({
    page,
  }) => {
    const screen = await start(page);
    expect(parseColor(await style(screen, "background-color")).a).toBeCloseTo(0.74, 2);
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setSystemTransparencyReduced(true),
    );
    await expect.poll(async () => parseColor(await style(screen, "background-color")).a).toBe(1);
    expect(await style(screen, "backdrop-filter")).toBe("none");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setSystemTransparencyReduced(false),
    );
    await expect
      .poll(async () => parseColor(await style(screen, "background-color")).a)
      .toBeCloseTo(0.74, 2);
  });

  test("the dense style has a screen of its own (NOR-F20-21b): the window under its title bar, square corners, no glass, no icons", async ({
    page,
  }) => {
    const screen = await start(page, { style: "dense" });
    // It fills the window under the title bar (32 px) instead of floating over it as a card.
    const at = await box(screen);
    expect([at.x, at.y, at.width, at.height]).toEqual([0, 32, 1280, 768]);
    expect(await style(screen, "backdrop-filter")).toBe("none");
    expect(parseFloat(await style(screen, "border-top-left-radius"))).toBe(0);
    await expect(screen.locator(".settings-nav-icon")).toHaveCount(0);
    // The search has its frame (with a slash, not the magnifier), and the style is the two cards, as in
    // the glass; Appearance opens with them, the language after.
    await expect(screen.locator('[data-nr-part="settings-search-field"]')).toHaveCount(1);
    await expect(screen.locator('[data-nr-part="settings-search-field"] svg')).toHaveCount(0);
    await expect(screen.locator('[data-nr-part="settings-style-card"]')).toHaveCount(2);
    const first = sectionOf(screen, "appearance").locator("[data-nr-row]").first();
    await expect(first).toHaveAttribute("data-nr-row", "appearance.style");
    const group = rowOf(screen, "appearance.style").getByRole("group", { name: "Interface style" });
    await expect(group.getByRole("radio")).toHaveCount(2);
    await expect(group.locator(".settings-segmented")).toHaveCount(0);
  });
});

test.describe("the header", () => {
  for (const [language, mode] of COMBOS) {
    test(`${language}, ${mode} theme: the title, the search with its magnifier and the X at the far end`, async ({
      page,
    }) => {
      const words = WORDS[language];
      const screen = await start(page, { language, mode });
      const header = screen.locator(".settings-header");
      expect((await box(header)).height).toBe(60);
      const title = screen.getByRole("heading", { name: words.settings, exact: true, level: 2 });
      expect(await style(title, "font-size")).toBe("18px");
      expect(await style(title, "font-weight")).toBe("600");
      // The search: a frame of 36 px and 10px corners with the magnifier in it and the box beside it.
      const frame = screen.locator('[data-nr-part="settings-search-field"]');
      expect(await style(frame, "height")).toBe("36px");
      expect(await style(frame, "border-top-left-radius")).toBe("10px");
      await expect(frame.locator("svg")).toHaveCount(1);
      await expect(frame.getByRole("searchbox", { name: words.search, exact: true })).toBeVisible();
      expect((await box(frame)).width).toBeLessThanOrEqual(420);
      // The X is at the end of the header, 12 px from its right edge.
      const close = screen.getByRole("button", { name: words.close, exact: true });
      const closeAt = await box(close);
      const headerAt = await box(header);
      expect([closeAt.width, closeAt.height]).toEqual([36, 36]);
      expect(Math.round(headerAt.x + headerAt.width - (closeAt.x + closeAt.width))).toBe(12);
    });
  }

  test("the frame of the search shows the focus, and the box inside has no ring of its own", async ({
    page,
  }) => {
    const screen = await start(page);
    const frame = screen.locator('[data-nr-part="settings-search-field"]');
    // The screen opens with the keyboard in the search; the focus moved away takes the ring away.
    await screen.getByRole("button", { name: "Close", exact: true }).focus();
    expect(await style(frame, "outline-style")).toBe("none");
    await searchBox(screen).focus();
    expect(await style(frame, "outline-style")).toBe("solid");
    expect(await style(frame, "outline-width")).toBe("2px");
    expect(await style(searchBox(screen), "outline-style")).toBe("none");
  });
});

test.describe("the column of sections", () => {
  for (const [language, mode] of COMBOS) {
    test(`${language}, ${mode} theme: an icon and the name of every section, one row lit`, async ({
      page,
    }) => {
      const screen = await start(page, { language, mode });
      const nav = screen.getByRole("navigation", {
        name: /^(Settings sections|Seções das configurações)$/,
      });
      await expect(nav.getByRole("button")).toHaveCount(SECTIONS.length);
      for (const [id, en, pt] of SECTIONS) {
        const item = navItem(screen, id);
        await expect(item.locator("svg.settings-nav-icon"), id).toHaveCount(1);
        await expect(item.locator("svg")).toHaveAttribute("aria-hidden", "true");
        await expect(item, id).toHaveAccessibleName(language === "en" ? en : pt);
        expect((await box(item)).height, id).toBe(36);
        expect(await style(item, "border-top-left-radius"), id).toBe("9px");
      }
      // The one in view is lit and says it is the current one; the others are not filled.
      const lit = nav.locator('[aria-current="true"]');
      await expect(lit).toHaveCount(1);
      await expect(lit).toHaveAttribute("data-nr-part", "settings-nav-appearance");
      expect(parseColor(await style(lit, "background-color")).a).toBeGreaterThan(0.05);
      expect(parseColor(await style(navItem(screen, "themes"), "background-color")).a).toBe(0);
      expect((await box(nav)).width).toBe(232);
    });
  }

  test("a click lights the row of its section and brings the section to the top; the keys move in the column", async ({
    page,
  }) => {
    const screen = await start(page);
    await navItem(screen, "terminal").click();
    await expect(navItem(screen, "terminal")).toHaveAttribute("aria-current", "true");
    await expect(navItem(screen, "appearance")).not.toHaveAttribute("aria-current", "true");
    expect(
      parseColor(await style(navItem(screen, "terminal"), "background-color")).a,
    ).toBeGreaterThan(0.05);
    await navItem(screen, "terminal").focus();
    await page.keyboard.press("ArrowDown");
    await expect(navItem(screen, "profiles")).toBeFocused();
    expect(await style(navItem(screen, "profiles"), "outline-style")).toBe("solid");
    await page.keyboard.press("End");
    await expect(navItem(screen, "import")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(navItem(screen, "appearance")).toBeFocused();
  });

  for (const language of ["en", "pt-BR"] as const) {
    for (const width of [1280, 900, 720] as const) {
      test(`${language}, ${width} px wide: the longest name of a section is not cut`, async ({
        page,
      }) => {
        const screen = await start(page, { language, width });
        const cut = await screen.evaluate((root) =>
          [...root.querySelectorAll<HTMLElement>(".settings-nav-label")]
            .filter((label) => label.scrollWidth > label.clientWidth + 1)
            .map((label) => label.textContent),
        );
        expect(cut).toEqual([]);
        // A name that does not fit in one line goes to a second one: the column does not scroll sideways.
        const nav = screen.locator('[data-nr-part="settings-nav"]');
        expect(await nav.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      });
    }
  }
});

test.describe("the rows", () => {
  test("a label and its explanation stand at one left edge in every section, the controls end at one right edge", async ({
    page,
  }) => {
    const screen = await start(page, {
      top: '"mods": ["quiet.css"]',
      mods: { "quiet.css": "body {}", "loud.css": "body {}" },
    });
    await screen.getByRole("button", { name: "Add SSH profile", exact: true }).click();
    const found = await screen.evaluate((root) => {
      const form = root.querySelector(".settings-form");
      if (form === null) throw new Error("no form");
      const origin = form.getBoundingClientRect().left;
      const shown = (element: Element) => element.getClientRects().length > 0;
      const edge = (selector: string, side: "left" | "right"): number[] =>
        [...root.querySelectorAll(`.settings-content ${selector}`)]
          .filter(shown)
          .map((element) => Math.round(element.getBoundingClientRect()[side] - origin));
      return {
        labels: edge(
          [
            ".settings-number > .settings-option > :is(span, label)",
            ".settings-toggle > .settings-option > span",
            ".settings-choice-head",
            ".settings-action > .settings-explain-text",
            ".settings-gallery-text",
          ].join(", "),
          "left",
        ),
        // The switches of a mod sit at the left of the column (the order buttons are at its right).
        controls: edge(
          [
            ".settings-number > .settings-option > :is(select, textarea)",
            ".settings-number:not(:has(> .settings-slider)) > .settings-option > input",
            ".settings-number > .settings-slider ~ .settings-option > input",
            ".settings-number > .settings-path-choose",
            ".settings-toggle > .settings-option > input",
            ".settings-choices",
            ".settings-action-buttons",
            ".settings-sync-buttons",
          ].join(", "),
          "right",
        ),
        modSwitches: edge(".settings-mod .settings-toggle > .settings-option > input", "left"),
        modMoves: edge(".settings-mod-move", "right"),
        form: Math.round(form.getBoundingClientRect().width),
      };
    });
    expect(found.labels.length).toBeGreaterThan(40);
    expect(found.controls.length).toBeGreaterThan(40);
    expect([...new Set(found.labels)]).toHaveLength(1);
    // The column of the controls is 260 px wide and ends 32 px from the edge of the content.
    const rights = [
      ...new Set(found.controls.filter((right) => !found.modSwitches.includes(right - 40))),
    ];
    expect(rights.length, JSON.stringify(rights)).toBeLessThanOrEqual(2);
    // The labels are on the left of the controls, with room between them.
    expect(Math.max(...rights) - (found.labels[0] ?? 0)).toBeGreaterThanOrEqual(480);
    // A mod: its switch at the left of the column, the order buttons at the right end of it.
    expect(new Set(found.modSwitches).size).toBe(1);
    expect(new Set(found.modMoves).size).toBe(1);
    expect(found.modMoves[0]).toBe(Math.max(...rights));
  });

  test("a row has 14 px over and under it and a line between it and the next; a note has none", async ({
    page,
  }) => {
    const screen = await start(page);
    const row = rowOf(screen, "appearance.side");
    expect(await style(row, "padding-top")).toBe("14px");
    expect(await style(row, "padding-bottom")).toBe("14px");
    expect(await style(row, "border-top-width")).toBe("1px");
    expect(parseColor(await style(row, "border-top-color")).a).toBeCloseTo(0.06, 2);
    // The first row of a section has no line above it.
    const first = sectionOf(screen, "appearance").locator("[data-nr-row]").first();
    expect(await style(first, "border-top-width")).toBe("0px");
    // The explanation under a label is gray and 12 px, the label itself is medium.
    const ligatures = rowOf(screen, "terminal.ligatures");
    await ligatures.scrollIntoViewIfNeeded();
    expect(await style(ligatures.locator(".settings-explain"), "font-size")).toBe("12px");
    expect(await style(ligatures.locator(".settings-option > span"), "font-weight")).toBe("500");
  });

  test("a section has its heading of 15 px, and the sections are 28 px apart in a column of 780 px", async ({
    page,
  }) => {
    const screen = await start(page);
    const heading = sectionOf(screen, "themes").locator("h3");
    expect(await style(heading, "font-size")).toBe("15px");
    expect(await style(heading, "font-weight")).toBe("600");
    expect(await style(screen.locator(".settings-sections"), "row-gap")).toBe("28px");
    expect((await box(screen.locator(".settings-sections"))).width).toBeLessThanOrEqual(780);
    expect(await style(screen.locator(".settings-content"), "padding-left")).toBe("32px");
  });
});

test.describe("the two cards of the interface style", () => {
  for (const [language, mode] of COMBOS) {
    test(`${language}, ${mode} theme: Appearance opens with them, each a radio named by its style and described by its line`, async ({
      page,
    }) => {
      const words = WORDS[language];
      const screen = await start(page, { language, mode });
      const first = sectionOf(screen, "appearance").locator("[data-nr-row]").first();
      await expect(first).toHaveAttribute("data-nr-row", "appearance.style");
      const group = first.getByRole("group", { name: words.style, exact: true });
      await expect(group.getByRole("radio")).toHaveCount(2);
      const glass = group.getByRole("radio", { name: words.glass, exact: true });
      const dense = group.getByRole("radio", { name: words.dense, exact: true });
      await expect(glass).toBeChecked();
      await expect(dense).not.toBeChecked();
      await expect(glass).toHaveAccessibleDescription(words.glassNote);
      // The little pictures: the glass one is two cards over a landscape, the dense one a ruled grid.
      await expect(group.locator('[data-nr-thumb="glass"] .settings-style-side')).toHaveCount(1);
      await expect(group.locator('[data-nr-thumb="dense"] .settings-style-status')).toHaveCount(1);
      for (const thumb of await group.locator(".settings-style-thumb").all()) {
        expect((await box(thumb)).height).toBe(120);
        await expect(thumb).toHaveAttribute("aria-hidden", "true");
      }
      // The chosen card has the line of the highlight and a filled mark; the other has neither.
      const cards = group.locator('[data-nr-part="settings-style-card"]');
      const chosen = cards.nth(0);
      const other = cards.nth(1);
      expectSameColor(
        parseColor(await style(chosen, "border-top-color")),
        await highlight(page),
        "chosen card",
      );
      // A line of 1.5px is drawn as one device pixel at 100%: the page computes 1px.
      expect(await style(chosen, "border-top-width")).toBe("1px");
      expect(parseColor(await style(other, "border-top-color")).a).toBeLessThan(0.2);
      expect(await style(chosen.locator(".settings-style-mark"), "border-top-width")).toBe("5px");
      expect(await style(other.locator(".settings-style-mark"), "border-top-width")).toBe("1px");
      // Two cards of one width side by side, 12 px apart.
      const [one, two] = [await box(chosen), await box(other)];
      expect(one.width).toBeCloseTo(two.width, 0);
      expect(Math.round(two.x - (one.x + one.width))).toBe(12);
      // Under the name of the group, the line that says what it is for.
      await expect(first.locator(".settings-explain")).toBeVisible();
    });
  }

  test("a click on a card chooses it, writes only the style, and the window follows at once", async ({
    page,
  }) => {
    const screen = await start(page);
    const before = (await configText(page)) ?? "";
    const group = rowOf(screen, "appearance.style").getByRole("group", { name: "Interface style" });
    await group.locator('[data-nr-part="settings-style-card"]').nth(1).click();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "dense");
    await expect.poll(written(page)).toMatch(/"style":\s*"dense"/);
    const after = (await configText(page)) ?? "";
    expect(after.replace(/"style":\s*"dense"/, '"style": "glass"')).toBe(before);
    // The screen is the dense one at once (it fills the window under the title bar), and the same two cards
    // choose the style there.
    await expect(screen.locator('[data-nr-part="settings-style-card"]')).toHaveCount(2);
    expect((await box(screen)).width).toBe(1280);
    await expect(
      rowOf(screen, "appearance.style").getByRole("radio", { name: "Glass", exact: true }),
    ).toBeVisible();
    await rowOf(screen, "appearance.style")
      .getByRole("radio", { name: "Glass", exact: true })
      .check();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "glass");
    await expect(screen.locator('[data-nr-part="settings-style-card"]')).toHaveCount(2);
  });

  test("the arrow keys move the choice from one card to the other, and the focus is seen on the card", async ({
    page,
  }) => {
    const screen = await start(page);
    const group = rowOf(screen, "appearance.style").getByRole("group", { name: "Interface style" });
    const glass = group.getByRole("radio", { name: "Glass", exact: true });
    // The ring is for the keyboard: Tab from the search reaches the card.
    await searchBox(screen).focus();
    for (let tab = 0; tab < 3; tab += 1) await page.keyboard.press("Tab");
    await expect(glass).toBeFocused();
    const card = group.locator('[data-nr-part="settings-style-card"]').first();
    expect(await style(card, "outline-style")).toBe("solid");
    expect(await style(card, "outline-width")).toBe("2px");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "dense");
    await expect.poll(written(page)).toMatch(/"style":\s*"dense"/);
  });

  test("the search finds the cards by the line about each style, and Appearance keeps the row", async ({
    page,
  }) => {
    const screen = await start(page, { language: "pt-BR" });
    await searchBox(screen).fill("translúcido");
    await expect(rowOf(screen, "appearance.style")).toBeVisible();
    await expect(rowOf(screen, "appearance.language")).toBeHidden();
    await expect(navItem(screen, "terminal")).toHaveCount(0);
  });
});

test.describe("the controls", () => {
  test("the switch is 40 by 24 with a knob of 20 that slides 16, and on it is the highlight; it sits at the right end of the column", async ({
    page,
  }) => {
    const screen = await start(page);
    const row = rowOf(screen, "appearance.paneHeaders");
    const pane = row.getByRole("switch", { name: "Pane headers", exact: true });
    await pane.scrollIntoViewIfNeeded();
    const facts = () =>
      pane.evaluate((element) => {
        const knob = getComputedStyle(element, "::after");
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          track: getComputedStyle(element).backgroundColor,
          radius: getComputedStyle(element).borderTopLeftRadius,
          knob: [knob.width, knob.height, knob.top, knob.left],
          move: knob.transform,
        };
      });
    const off = await facts();
    expect([off.width, off.height]).toEqual([40, 24]);
    expect(off.knob).toEqual(["20px", "20px", "2px", "2px"]);
    expect(off.move).toBe("none");
    expect(parseFloat(off.radius)).toBeGreaterThanOrEqual(12);
    expect(parseColor(off.track).a).toBeLessThan(0.3);
    // At the right end of the control column: 260 px wide, 32 px from the edge of the content.
    const control = await box(row.locator(".settings-switch"));
    const content = await box(screen.locator(".settings-content"));
    expect(
      Math.round(content.x + content.width - (control.x + control.width)),
    ).toBeGreaterThanOrEqual(32);
    await pane.click();
    await expect.poll(async () => (await facts()).move).toBe("matrix(1, 0, 0, 1, 16, 0)");
    expectSameColor(parseColor((await facts()).track), await highlight(page), "the track");
    await expect.poll(written(page)).toContain('"paneHeaders": true');
    await pane.focus();
    await page.keyboard.press("Space");
    await expect(pane).not.toBeChecked();
    expect(await style(pane, "outline-style")).toBe("solid");
    await expect.poll(written(page)).toContain('"paneHeaders": false');
  });

  for (const [language, mode] of COMBOS) {
    test(`${language}, ${mode} theme: a choice of two is a row in a track, the chosen one lit, and a click writes it`, async ({
      page,
    }) => {
      const words = WORDS[language];
      const screen = await start(page, { language, mode });
      const row = rowOf(screen, "appearance.side");
      const group = row.getByRole("group", { name: words.side, exact: true });
      const track = group.locator(".settings-segmented");
      expect(await style(track, "padding-top")).toBe("3px");
      expect(await style(track, "border-top-left-radius")).toBe("10px");
      expect(parseColor(await style(track, "background-color")).a).toBeGreaterThan(0.02);
      const options = group.locator("label");
      await expect(options).toHaveCount(2);
      for (const option of await options.all()) {
        expect((await box(option)).height).toBe(30);
        expect(await style(option, "border-top-left-radius")).toBe("8px");
      }
      const lit = group.locator("label:has(input:checked)");
      const dim = group.locator("label:has(input:not(:checked))");
      expect(parseColor(await style(lit, "background-color")).a).toBeGreaterThan(0.08);
      expect(parseColor(await style(dim, "background-color")).a).toBe(0);
      expect(await style(lit, "font-weight")).toBe("500");
      await group.getByRole("radio", { name: words.right, exact: true }).check();
      await expect(group.getByRole("radio", { name: words.right, exact: true })).toBeChecked();
      await expect.poll(written(page)).toContain('"position": "right"');
      expect(
        parseColor(await style(group.locator("label:has(input:checked)"), "background-color")).a,
      ).toBeGreaterThan(0.08);
      await group.getByRole("radio", { name: words.right, exact: true }).focus();
      await page.keyboard.press("ArrowLeft");
      await expect(group.getByRole("radio", { name: words.left, exact: true })).toBeChecked();
    });
  }

  test("a number with a range: the slider and, at the right end, its number in the mono type; both write", async ({
    page,
  }) => {
    const screen = await start(page);
    const row = rowOf(screen, "appearance.width");
    const slider = row.getByRole("slider", { name: "Sidebar width", exact: true });
    const number = row.getByRole("textbox");
    const [sliderAt, numberAt] = [await box(slider), await box(number)];
    // The slider first, its number after it on the same line, inside one column of 260 px.
    expect(sliderAt.x + sliderAt.width).toBeLessThanOrEqual(numberAt.x);
    expect(
      Math.abs(sliderAt.y + sliderAt.height / 2 - (numberAt.y + numberAt.height / 2)),
    ).toBeLessThan(4);
    expect(Math.round(numberAt.x + numberAt.width - sliderAt.x)).toBe(260);
    expect(await style(number, "font-family")).toContain("Geist Mono");
    expect(await style(number, "text-align")).toBe("right");
    // The box is plain text until the pointer or the keys are on it.
    expect(parseColor(await style(number, "border-top-color")).a).toBe(0);
    await number.focus();
    expect(parseColor(await style(number, "border-top-color")).a).toBeGreaterThan(0.05);
    // The handle is the highlight, 16 px wide, and the track is filled with the highlight up to it: the pixels say so.
    const want = await highlight(page);
    const near = (rgb: readonly number[]): boolean =>
      Math.abs((rgb[0] ?? 0) - want.r) <= 2 &&
      Math.abs((rgb[1] ?? 0) - want.g) <= 2 &&
      Math.abs((rgb[2] ?? 0) - want.b) <= 2;
    const pixelAt = async (fraction: number): Promise<readonly number[]> => {
      const pixels = readPixels(await slider.screenshot());
      return pixels.at(Math.round(fraction * (pixels.width - 1)), Math.round(pixels.height / 2));
    };
    const sliderWidth = (await box(slider)).width;
    await slider.focus();
    await page.keyboard.press("End");
    expect(near(await pixelAt(0.25)), "filled track").toBe(true);
    expect(near(await pixelAt(1 - 8 / sliderWidth)), "the handle at the end").toBe(true);
    await page.keyboard.press("Home");
    expect(near(await pixelAt(0.5)), "empty track").toBe(false);
    expect(near(await pixelAt(8 / sliderWidth)), "the handle at the start").toBe(true);
    expect(await style(slider, "height")).toBe("16px");
    // The page says how far the handle is, 0 to 1, for the fill.
    const fillAt = () =>
      slider.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--nr-slider-fill"));
    expect(Number(await fillAt())).toBe(0);
    await page.keyboard.press("End");
    expect(Number(await fillAt())).toBe(1);
    // The handle writes when it stops, the number when it is typed; the other follows.
    await slider.focus();
    await page.keyboard.press("End");
    await expect(number).toHaveValue("480");
    await expect.poll(written(page)).toContain('"width": 480');
    await number.fill("300");
    await expect(slider).toHaveValue("300");
    await expect.poll(written(page)).toContain('"width": 300');
  });

  test("a number the file does not hold yet shows the one in force in the muted color", async ({
    page,
  }) => {
    const screen = await start(page);
    const row = rowOf(screen, "background.opacity");
    await row.scrollIntoViewIfNeeded();
    const number = row.getByRole("textbox");
    await expect(number).toHaveValue("");
    expect(await number.getAttribute("placeholder")).toBe("0.6");
    const placeholder = await number.evaluate((el) => getComputedStyle(el, "::placeholder").color);
    expect(parseColor(placeholder).a).toBe(1);
  });

  test("a list and a box are 34 px with 9px corners, and a list chooses at once", async ({
    page,
  }) => {
    const screen = await start(page);
    const language = rowOf(screen, "appearance.language").getByRole("combobox");
    expect((await box(language)).height).toBe(34);
    expect(await style(language, "border-top-left-radius")).toBe("9px");
    expect((await box(language)).width).toBe(260);
    await rowOf(screen, "terminal.bell").scrollIntoViewIfNeeded();
    const bell = rowOf(screen, "terminal.bell").getByRole("combobox");
    await bell.selectOption({ label: "Flash and beep" });
    await expect.poll(written(page)).toContain('"bell": "both"');
    const fonts = rowOf(screen, "terminal.fontList").getByRole("textbox");
    await fonts.scrollIntoViewIfNeeded();
    expect((await box(fonts)).height).toBe(34);
    expect(await style(fonts, "border-top-left-radius")).toBe("9px");
    expect((await box(fonts)).width).toBe(260);
    await fonts.focus();
    expect(await style(fonts, "outline-style")).toBe("solid");
  });

  test("a button is 34 px with 9px corners, the one that chooses a picture is tinted with the highlight", async ({
    page,
  }) => {
    const screen = await start(page);
    const choose = screen.getByRole("button", { name: "Choose image…", exact: true });
    await choose.scrollIntoViewIfNeeded();
    expect((await box(choose)).height).toBe(34);
    expect(await style(choose, "border-top-left-radius")).toBe("9px");
    expectSameColor(
      parseColor(await style(choose, "border-top-color")),
      await highlight(page),
      "line",
    );
    expect(await style(choose, "font-weight")).toBe("600");
    const remove = screen.getByRole("button", { name: "Remove", exact: true }).first();
    expect((await box(remove)).height).toBe(34);
    expect(parseColor(await style(remove, "border-top-color")).a).toBeLessThan(0.3);
    await expect(remove).toBeDisabled();
  });

  test("the gallery of themes: the one in use is ringed with the highlight, a click uses another", async ({
    page,
  }) => {
    const screen = await start(page);
    const cards = screen.locator('[data-nr-part="theme-card"]');
    const dusk = cards.filter({ hasText: "Noren Dusk" }).locator(".theme-pick");
    const paper = cards.filter({ hasText: "Noren Paper" }).locator(".theme-pick");
    await dusk.scrollIntoViewIfNeeded();
    await expect(dusk).toHaveAttribute("aria-pressed", "true");
    expect(await style(dusk, "border-top-width")).toBe("1px");
    expectSameColor(
      parseColor(await style(dusk, "border-top-color")),
      await highlight(page),
      "ring",
    );
    expect(parseColor(await style(paper, "border-top-color")).a).toBe(0);
    expect(await style(dusk, "border-top-left-radius")).toBe("10px");
    expect((await box(dusk.locator(".theme-thumb"))).height).toBe(54);
    await paper.click();
    await expect.poll(written(page)).toContain('"theme": "noren-paper"');
    await expect(paper).toHaveAttribute("aria-pressed", "true");
  });
});

test("the theme editor, opened from the settings of the dense style, is the dense one and not the glass one: its switch has a line and its buttons are not the 34 px ones (the glass editor has its own spec, glass-editor.spec.ts, the dense one dense-editor.spec.ts)", async ({
  page,
}) => {
  const screen = await start(page, { style: "dense" });
  await sectionOf(screen, "themes").scrollIntoViewIfNeeded();
  await screen.getByRole("button", { name: "Customize Noren Dusk", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Theme editor", exact: true });
  await expect(editor).toBeVisible();
  const ligatures = editor.getByRole("switch", { name: "Ligatures", exact: true });
  await ligatures.scrollIntoViewIfNeeded();
  // The classic switch has a line around its track; the glass one of the settings screen has none.
  expect(await style(ligatures, "border-top-width")).toBe("1px");
  expect(await style(ligatures, "border-top-color")).not.toBe("rgba(0, 0, 0, 0)");
  // A button of the editor is not the 34 px button of the settings screen.
  const cancel = editor.getByRole("button", { name: "Cancel", exact: true });
  expect((await box(cancel)).height).toBeLessThan(34);
  expect(await style(cancel, "border-top-left-radius")).not.toBe("9px");
  await cancel.click();
  await expect(editor).toHaveCount(0);
});

test.describe("the picture of the background", () => {
  test("a card with the miniature, the name of the file and the two buttons, above the box of the path", async ({
    page,
  }) => {
    await page.addInitScript(
      ({ pixel }) => {
        window.localStorage.setItem(
          "noren.web.images",
          JSON.stringify({ "fixtures/sky.png": pixel }),
        );
      },
      { pixel: PIXEL },
    );
    const screen = await start(page);
    const picker = screen.locator('[data-nr-part="background-picker"]');
    await picker.scrollIntoViewIfNeeded();
    // With no picture: the miniature says so, the name is empty and Remove is off.
    await expect(picker.locator('[data-nr-part="background-picker-name"]')).toHaveText("");
    await expect(screen.locator('[data-nr-part="background-remove"]')).toBeDisabled();
    expect(await style(picker, "border-top-left-radius")).toBe("12px");
    const thumb = await box(picker.locator(".background-thumb"));
    expect([thumb.width, thumb.height]).toEqual([112, 68]);
    // The card is above the box of the path, and the width of its row.
    const pathBox = rowOf(screen, "background.image").getByRole("textbox");
    expect((await box(picker)).y + (await box(picker)).height).toBeLessThanOrEqual(
      (await box(pathBox)).y,
    );
    // A file from the chooser of the system: the card says its name, the box has its path, the file has it.
    await page.evaluate(() => (window as HookWindow).__norenTest?.setImagePick("fixtures/sky.png"));
    await screen.getByRole("button", { name: "Choose image…", exact: true }).click();
    await expect(picker.locator('[data-nr-part="background-picker-name"]')).toHaveText("sky.png");
    await expect(pathBox).toHaveValue("fixtures/sky.png");
    await expect.poll(written(page)).toContain('"image": "fixtures/sky.png"');
    await expect(screen.locator('[data-nr-part="background-remove"]')).toBeEnabled();
    await screen.locator('[data-nr-part="background-remove"]').click();
    await expect(picker.locator('[data-nr-part="background-picker-name"]')).toHaveText("");
    await expect(pathBox).toHaveValue("");
  });

  test("a name far too long is cut inside its own box, and the card does not scroll sideways", async ({
    page,
  }) => {
    const longName = `${"a-picture-with-a-very-long-name-".repeat(6)}.png`;
    await page.addInitScript(
      ({ name, pixel }) => {
        window.localStorage.setItem("noren.web.images", JSON.stringify({ [name]: pixel }));
      },
      { name: longName, pixel: PIXEL },
    );
    const screen = await start(page, {
      width: 900,
      appearance: `"background": { "image": "${longName}" }`,
    });
    const picker = screen.locator('[data-nr-part="background-picker"]');
    await picker.scrollIntoViewIfNeeded();
    await expect(picker.locator('[data-nr-part="background-picker-name"]')).toHaveText(longName);
    expect(
      await screen.locator(".settings-content").evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(0);
    const info = picker.locator('[data-nr-part="background-picker-name"]');
    const [pickerAt, infoAt] = [await box(picker), await box(info)];
    expect(infoAt.x + infoAt.width).toBeLessThanOrEqual(pickerAt.x + pickerAt.width);
  });
});

test.describe("the search", () => {
  test("it keeps what has its words, the magnifier stays, Escape empties it and Enter does nothing", async ({
    page,
  }) => {
    const screen = await start(page);
    await searchBox(screen).fill("cursor");
    await expect(rowOf(screen, "terminal.cursorShape")).toBeVisible();
    await expect(rowOf(screen, "terminal.cursorBlinks")).toBeVisible();
    await expect(rowOf(screen, "terminal.fontSize")).toBeHidden();
    await expect(rowOf(screen, "appearance.side")).toBeHidden();
    await expect(navItem(screen, "appearance")).toHaveCount(0);
    await expect(navItem(screen, "terminal")).toHaveCount(1);
    await expect(screen.locator('[data-nr-part="settings-search-field"] svg')).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(searchBox(screen)).toHaveValue("cursor");
    await page.keyboard.press("Escape");
    await expect(searchBox(screen)).toHaveValue("");
    await expect(screen).toBeVisible();
    await expect(navItem(screen, "appearance")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(screen).toHaveCount(0);
  });

  for (const language of ["en", "pt-BR"] as const) {
    test(`${language}: a search with nothing to show says so`, async ({ page }) => {
      const screen = await start(page, { language });
      await searchBox(screen).fill("zzzzqq");
      await expect(screen.locator('[data-nr-part="settings-search-none"]')).toContainText(
        WORDS[language].nothing,
      );
      await expect(screen.getByRole("navigation").getByRole("button")).toHaveCount(0);
    });
  }
});

test.describe("narrow windows and long names", () => {
  for (const [language, mode] of COMBOS) {
    for (const width of [900, 720] as const) {
      test(`${language}, ${mode} theme, ${width} px wide: no label, explanation, button or card is wider than its box, in any section`, async ({
        page,
      }) => {
        const screen = await start(page, {
          language,
          mode,
          width,
          mods: { "quiet.css": "body {}" },
        });
        const report = await screen.evaluate((root) => {
          const content = root.querySelector<HTMLElement>('[data-nr-part="settings-content"]');
          if (content === null) throw new Error("no content");
          const wide: string[] = [];
          const watched = [
            ".settings-option > span",
            ".settings-option > label",
            ".settings-label",
            ".settings-explain",
            ".settings-hint",
            ".settings-link",
            ".settings-style-name",
            ".settings-style-note",
            ".settings-style-line",
            ".theme-name",
            ".theme-meta",
            ".settings-nav-label",
            "h3",
            "label",
            "button",
          ].join(", ");
          for (const element of root.querySelectorAll<HTMLElement>(watched)) {
            if (element.getClientRects().length === 0) continue;
            const over = element.scrollWidth - element.clientWidth;
            // A box that scrolls on its own (the table of the bench) or is cut on purpose (an ellipsis on a file name) is not it.
            if (over > 1 && getComputedStyle(element).textOverflow !== "ellipsis") {
              wide.push(`${element.tagName}.${element.className} +${over}`);
            }
          }
          return {
            wide: wide.slice(0, 8),
            content: content.scrollWidth - content.clientWidth,
            dialog: root.scrollWidth - root.clientWidth,
          };
        });
        expect(report.wide, "boxes wider than themselves").toEqual([]);
        expect(report.content, "the content scrolls to the side").toBeLessThanOrEqual(0);
        expect(report.dialog, "the screen scrolls to the side").toBeLessThanOrEqual(0);
      });
    }
  }

  test("at 720 px the control column gives way to the labels and the rows still read", async ({
    page,
  }) => {
    const screen = await start(page, { width: 720, language: "pt-BR" });
    const row = rowOf(screen, "appearance.width");
    const label = await box(row.locator(".settings-option > span"));
    const control = await box(row.getByRole("slider"));
    expect(label.x + label.width).toBeLessThanOrEqual(control.x);
    expect(label.width).toBeGreaterThanOrEqual(120);
    const at = await box(screen);
    expect(at.width).toBe(704);
  });
});

test.describe("the keyboard", () => {
  test("Tab goes from the search to the X, then into the column of sections, in that order", async ({
    page,
  }) => {
    const screen = await start(page);
    await searchBox(screen).focus();
    await page.keyboard.press("Tab");
    await expect(screen.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(navItem(screen, "appearance")).toBeFocused();
    await page.keyboard.press("Tab");
    // The next stop is the first control of the content, the cards of the style.
    await expect(
      rowOf(screen, "appearance.style").getByRole("radio", { name: "Glass", exact: true }),
    ).toBeFocused();
  });

  test("Escape closes the screen, and the X closes it; what was changed is already written", async ({
    page,
  }) => {
    const screen = await start(page);
    await rowOf(screen, "appearance.paneHeaders").getByRole("switch").click();
    await expect.poll(() => configSaveCount(page)).toBe(1);
    await page.keyboard.press("Escape");
    await expect(screen).toHaveCount(0);
    expect((await configText(page)) ?? "").toContain('"paneHeaders": true');
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await closeSettings(page);
  });
});

test.describe("axe", () => {
  for (const [language, mode] of COMBOS) {
    test(`${language}, ${mode} theme: the screen at 900 px, searched and not, and with the focus on a card`, async ({
      page,
    }) => {
      const words = WORDS[language];
      const screen = await start(page, { language, mode, width: 900 });
      await expectNoAxeViolations(page, `glass settings ${language} ${mode}`);
      await rowOf(screen, "appearance.style")
        .getByRole("radio", { name: words.glass, exact: true })
        .focus();
      await expectNoAxeViolations(page, `glass settings ${language} ${mode}, a card focused`);
      await searchBox(screen).fill("fonte");
      await expectNoAxeViolations(page, `glass settings ${language} ${mode}, searched`);
      await searchBox(screen).fill("zzzzqq");
      await expectNoAxeViolations(page, `glass settings ${language} ${mode}, nothing found`);
    });
  }

  test("the dense screen has no violation either (its look is the old one)", async ({ page }) => {
    await start(page, { style: "dense" });
    await expectNoAxeViolations(page, "dense settings");
  });

  test("the screen with the glass solid (the system has transparency off) has no violation", async ({
    page,
  }) => {
    await start(page);
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setSystemTransparencyReduced(true),
    );
    await expect(page.locator("html")).toHaveAttribute("data-nr-transparency", "reduced");
    await expectNoAxeViolations(page, "glass settings, transparency off");
  });
});

test("the dense config helper starts a screen the classic specs can measure", async ({ page }) => {
  // The classic specs (the grid of 8 px, the switch in the accent, the box left of its slider) start
  // from this file: a page that opens on it is the dense one.
  await seedConfig(page, denseOf('{ "appearance": { "theme": "noren-dusk" } }\n'));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-nr-style", "dense");
});
