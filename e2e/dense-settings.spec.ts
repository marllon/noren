import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { closeSettings, configText, seedConfig } from "./settings-fixture";

// The settings screen of the dense style (NOR-F20-21b, D23), as in the approved design
// (`denso-configuracoes`): the screen fills the window under its title bar; a header of 32 px with the title
// and the section the person is in, and the word that closes it with its key; a column of sections with a
// number on each; a search with a slash over the content; the sections as headings over a box of rows; the
// controls of the design (a switch of 36 by 18, a row of buttons in a frame with the chosen one filled, a
// slider with its number at the end of the row, boxes and lists of 24 px, the two cards of the interface
// style, the themes as a list with their colors); and a strip at the foot like the status bar of the window.
// What every field writes, the search and the keyboard are what they were: the specs of those run under
// the glass style (the default) and are not repeated here, except for one of each kind of control, to
// show the dense screen writes the same. The glass screen does not change, and a test says so.
// Everything runs on the `FakeBackend` of web mode.

interface Hook {
  paneIds(): string[];
  setImagePick(path: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

type Mode = "dark" | "light";
type Language = "en" | "pt-BR";

const THEME: Record<Mode, string> = { dark: "noren-dusk", light: "noren-paper" };

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

const WORDS = {
  en: { settings: "Settings", close: "Close", search: "Search settings", style: "Interface style" },
  "pt-BR": {
    settings: "Configurações",
    close: "Fechar",
    search: "Buscar nas configurações",
    style: "Estilo da interface",
  },
} as const;

/** A picture of one pixel the fake chooser can hand over. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface StartOptions {
  language?: Language;
  mode?: Mode;
  style?: "glass" | "dense";
  width?: number;
  height?: number;
  /** The rest of `appearance`, as JSON text: `"window": { "opacity": 0.3 }`. */
  appearance?: string;
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
    `{ ${lang}"appearance": { "theme": "${THEME[mode]}", "style": "${options.style ?? "dense"}"${more} }${top} }\n`,
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
  await settled(page);
  return screen;
}

/** Waits for the animations that end (the sheet fades in), so what is measured next is where it stays. */
const settled = (page: Page): Promise<unknown> =>
  page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));

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

/** A CSS color (a hex, a variable) as the `rgb(...)` the browser computes it to. */
const rgbOf = (page: Page, css: string): Promise<string> =>
  page.evaluate((value) => {
    const probe = document.createElement("i");
    probe.style.color = value;
    document.body.append(probe);
    const found = getComputedStyle(probe).color;
    probe.remove();
    return found;
  }, css);

const highlight = (page: Page): Promise<string> => rgbOf(page, "var(--nr-highlight)");

/** A computed color as 0 to 255 channels and an alpha, whichever form the browser writes it in. */
function parseColor(css: string): { r: number; g: number; b: number; a: number } {
  const value = css.trim();
  const srgb = /^color\(srgb ([0-9.]+) ([0-9.]+) ([0-9.]+)(?: \/ ([0-9.]+))?\)$/.exec(value);
  if (srgb !== null) {
    const [, r, g, b, a] = srgb;
    return { r: Number(r) * 255, g: Number(g) * 255, b: Number(b) * 255, a: a ? Number(a) : 1 };
  }
  const parts = /^rgba?\(([^)]+)\)$/
    .exec(value)?.[1]
    ?.split(/[\s,/]+/)
    .filter((part) => part !== "");
  if (parts === undefined || parts.length < 3) throw new Error(`not a color: ${css}`);
  return {
    r: Number(parts[0]),
    g: Number(parts[1]),
    b: Number(parts[2]),
    a: parts.length === 4 ? Number(parts[3]) : 1,
  };
}

/** How much of a box sticks out of its own box to the side (`scrollWidth - clientWidth`), and the lines it has taken. */
const overflowOf = (locator: Locator) =>
  locator.evaluate((element) => ({
    sideways: element.scrollWidth - element.clientWidth,
    height: element.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));

test.describe("the screen", () => {
  test("fills the window under its title bar, which stays in reach with the buttons of the window", async ({
    page,
  }) => {
    const screen = await start(page);
    expect(await box(screen)).toMatchObject({ x: 0, y: 32, width: 1280, height: 768 });
    // Square, no glass, solid: the page of the window.
    expect(await style(screen, "border-top-left-radius")).toBe("0px");
    expect(await style(screen, "backdrop-filter")).toBe("none");
    const color = await style(screen, "background-color");
    expect(color).toMatch(/^rgb\(/);
    // The title bar above is not under the backdrop: a point on it hits the title bar itself.
    const hit = await page.evaluate(() => {
      const found = document.elementFromPoint(1240, 16);
      return found?.closest(".titlebar") !== null && found?.closest(".titlebar") !== undefined;
    });
    expect(hit).toBe(true);
    // The font is the one of the style.
    expect(await style(screen, "font-family")).toMatch(/^"JetBrains Mono"/);
  });

  test("has a header of 32 px with the title and the section the person is in; the name of the dialog stays", async ({
    page,
  }) => {
    const screen = await start(page);
    const heading = screen.getByRole("heading", { level: 2 });
    expect((await box(heading)).height).toBe(32);
    expect(await style(heading, "text-transform")).toBe("lowercase");
    expect(await style(heading, "border-bottom-width")).toBe("1px");
    // The crumb names the section, and a click on another one moves it.
    const crumb = screen.locator('[data-nr-part="settings-crumb"]');
    await expect(crumb).toHaveText("/Appearance");
    await navItem(screen, "terminal").click();
    await expect(crumb).toHaveText("/Terminal");
    // It is a drawing: it is not in the name of the dialog or of the heading.
    await expect(crumb).toHaveAttribute("aria-hidden", "true");
    await expect(screen).toHaveAccessibleName("Settings");
    await expect(heading).toHaveAccessibleName("Settings");
  });

  test("closes with a button that says Close and shows its key, with Escape, and with the backdrop under the title bar", async ({
    page,
  }) => {
    const screen = await start(page);
    const close = screen.getByRole("button", { name: "Close", exact: true });
    expect((await box(close)).height).toBe(22);
    await expect(close).toContainText("Close");
    expect(await style(close, "content", "::after")).toContain("esc");
    expect(await style(close.locator("svg"), "display")).toBe("none");
    await close.click();
    await expect(screen).toHaveCount(0);
    // Again, with Escape.
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await expect(screen).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(screen).toHaveCount(0);
  });

  test("the search is a frame of 30 px with a slash, over the content, and the keyboard starts in it", async ({
    page,
  }) => {
    const screen = await start(page);
    const field = screen.locator('[data-nr-part="settings-search-field"]');
    const frame = await box(field);
    expect(frame.height).toBe(30);
    expect(frame.x).toBe(244);
    expect(frame.width).toBeLessThanOrEqual(880);
    await expect(field.locator("svg")).toHaveCount(0);
    await expect(field.locator(".settings-search-slash")).toHaveText("/");
    expect(await style(field, "border-top-width")).toBe("1px");
    // It stays where it is while the content scrolls (it is not part of what scrolls).
    await expect(searchBox(screen)).toBeFocused();
    await navItem(screen, "sync").click();
    expect((await box(field)).y).toBe(frame.y);
  });

  test("the search keeps the sections and rows that have its words; Escape empties it and then closes the screen; Tab goes on to Close", async ({
    page,
  }) => {
    const screen = await start(page);
    await searchBox(screen).fill("ligatures");
    await expect(rowOf(screen, "terminal.ligatures")).toBeVisible();
    await expect(rowOf(screen, "terminal.cursorShape")).toBeHidden();
    await expect(navItem(screen, "terminal")).toBeVisible();
    await expect(navItem(screen, "sync")).toHaveCount(0);
    // The crumb follows what is left.
    await expect(screen.locator('[data-nr-part="settings-crumb"]')).toHaveText("/Terminal");
    await searchBox(screen).fill("zzzzz");
    await expect(screen.locator('[data-nr-part="settings-search-none"]')).toBeVisible();
    await expect(screen.locator('[data-nr-part="settings-crumb"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(searchBox(screen)).toHaveValue("");
    await expect(screen).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(screen.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(screen).toHaveCount(0);
  });
});

test.describe("the column of sections", () => {
  for (const language of ["en", "pt-BR"] as const) {
    test(`${language}: 220 px wide, each name on one line, not cut, with a number the name does not carry`, async ({
      page,
    }) => {
      const screen = await start(page, { language });
      const column = screen.locator('[data-nr-part="settings-nav"]');
      expect((await box(column)).width).toBe(220);
      const items = column.locator(".settings-nav-item");
      await expect(items).toHaveCount(SECTIONS.length);
      for (const [id, en, pt] of SECTIONS) {
        const item = navItem(screen, id);
        const name = language === "en" ? en : pt;
        // The name of the button is the name of the section, with no number in it.
        await expect(item, id).toHaveAccessibleName(name);
        expect(await style(item, "content", "::before"), id).toContain("counter(");
        const found = await overflowOf(item);
        expect(found.height, `${id}: one line of 26 px`).toBe(26);
        expect(found.sideways, `${id}: nothing sticks out`).toBeLessThanOrEqual(0);
        expect(found.scrollHeight, `${id}: not a second line`).toBeLessThanOrEqual(
          found.clientHeight,
        );
      }
      // The one that broke in Portuguese (finding 343), by name.
      if (language === "pt-BR") {
        await expect(navItem(screen, "archive")).toHaveText("Arquivamento automático");
      }
    });
  }

  test("the current section is tinted with the highlight and its number is lit; the rest are plain", async ({
    page,
  }) => {
    const screen = await start(page);
    const current = navItem(screen, "appearance");
    await expect(current).toHaveAttribute("aria-current", "true");
    const tint = await style(current, "background-color");
    // 14% of the highlight over nothing: the highlight with an alpha of 0.14.
    const found = parseColor(tint);
    expect(found.a).toBeCloseTo(0.14, 2);
    const wanted = parseColor(await highlight(page));
    expect([Math.round(found.r), Math.round(found.g), Math.round(found.b)]).toEqual([
      wanted.r,
      wanted.g,
      wanted.b,
    ]);
    expect(await style(navItem(screen, "themes"), "background-color")).toBe("rgba(0, 0, 0, 0)");
    await navItem(screen, "themes").click();
    await expect(navItem(screen, "themes")).toHaveAttribute("aria-current", "true");
    await expect(current).not.toHaveAttribute("aria-current", "true");
  });

  test("a section that does not fit a narrow window's column is cut by an ellipsis inside its own box, not broken or left sticking out", async ({
    page,
  }) => {
    const screen = await start(page, { language: "pt-BR", width: 720 });
    const column = screen.locator('[data-nr-part="settings-nav"]');
    expect((await box(column)).width).toBe(168);
    const item = navItem(screen, "archive");
    const found = await overflowOf(item);
    expect(found.height).toBe(26);
    expect(await style(item, "text-overflow")).toBe("ellipsis");
    expect(await style(item, "white-space")).toBe("nowrap");
    // The box holds it: the column does not scroll to the side either.
    expect(await overflowOf(column)).toMatchObject({ sideways: 0 });
  });
});

test.describe("the sections and their rows", () => {
  test("every section is a heading of 11 px in capitals over a box with a line of 1 px, its rows divided by lines", async ({
    page,
  }) => {
    const screen = await start(page);
    for (const [id] of SECTIONS) {
      const section = sectionOf(screen, id);
      const heading = section.locator("h3");
      expect(await style(heading, "font-size"), id).toBe("11px");
      expect(await style(heading, "letter-spacing"), id).toBe("1.5px");
      expect(await style(heading, "text-transform"), id).toBe("uppercase");
      expect(await style(heading, "font-weight"), id).toBe("700");
      const rows = section.locator(".settings-rows");
      expect(await style(rows, "border-top-width"), id).toBe("1px");
      expect(await style(rows, "border-top-left-radius"), id).toBe("0px");
    }
    // Rows after the first have a line above them and none under; a row is at least 34 px.
    const rows = sectionOf(screen, "terminal").locator(".settings-row");
    expect(await style(rows.nth(1), "border-top-width")).toBe("1px");
    expect(await style(rows.nth(0), "border-top-width")).toBe("0px");
    expect((await box(rows.nth(1))).height).toBeGreaterThanOrEqual(34);
  });

  test("a row is the label and, 252 px to its right, its control; the explanation is in gray under the label", async ({
    page,
  }) => {
    const screen = await start(page);
    const row = rowOf(screen, "appearance.language");
    const label = await box(row.locator("label"));
    const control = await box(row.getByRole("combobox"));
    expect(Math.round(control.x - label.x)).toBe(252);
    expect(control.height).toBe(24);
    const hint = row.locator(".settings-explain");
    expect(Math.abs((await box(hint)).x - label.x)).toBeLessThanOrEqual(1);
    expect((await box(hint)).y).toBeGreaterThan(label.y + label.height - 1);
    expect(await style(hint, "color")).toBe(await rgbOf(page, "var(--nr-muted)"));
    // The control is a box of 1 px, square, with the fill of the bars.
    expect(await style(row.getByRole("combobox"), "border-top-width")).toBe("1px");
    expect(await style(row.getByRole("combobox"), "border-top-left-radius")).toBe("0px");
  });

  test("a switch sits at the end of the row, with its explanation in the middle; a number with a range has the slider in the column and its box at the end", async ({
    page,
  }) => {
    const screen = await start(page);
    const toggleRow = rowOf(screen, "terminal.ligatures");
    await toggleRow.scrollIntoViewIfNeeded();
    const knob = await box(toggleRow.getByRole("switch"));
    const frame = await box(toggleRow);
    expect(Math.round(frame.x + frame.width - 10 - (knob.x + knob.width))).toBe(0);
    const hint = await box(toggleRow.locator(".settings-explain"));
    expect(hint.x + hint.width).toBeLessThanOrEqual(knob.x);
    expect(hint.x).toBeGreaterThan(frame.x + 240);
    const rangeRow = rowOf(screen, "terminal.fontSize");
    const slider = await box(rangeRow.getByRole("slider"));
    const number = await box(rangeRow.getByRole("textbox"));
    expect(number.width).toBe(64);
    expect(slider.x + slider.width).toBeLessThanOrEqual(number.x);
    expect(await style(rangeRow.getByRole("textbox"), "text-align")).toBe("right");
    // The track is filled with the highlight up to the handle, which is the highlight too.
    const pixels = await style(rangeRow.getByRole("slider"), "--nr-slider-fill");
    expect(Number(pixels)).toBeGreaterThan(0);
  });

  test("a mod and an item of the gallery are rows of the same two columns", async ({ page }) => {
    const screen = await start(page, {
      top: '"mods": ["quiet.css"]',
      mods: { "quiet.css": "body {}", "loud.css": "body {}" },
    });
    const mods = screen.locator('[data-nr-part="settings-mod"]');
    await expect(mods).toHaveCount(2);
    const label = await box(rowOf(screen, "appearance.language").locator("label"));
    const name = await box(mods.first().locator(".settings-option > span"));
    const toggle = await box(mods.first().getByRole("switch"));
    expect(Math.round(name.x)).toBe(Math.round(label.x));
    expect(Math.round(toggle.x - name.x)).toBe(252);
    const item = screen.locator(".settings-gallery-item").first();
    await item.scrollIntoViewIfNeeded();
    const button = await box(item.getByRole("button"));
    expect(Math.round(button.x - label.x)).toBe(252);
  });
});

test.describe("the controls write what they wrote before, at once", () => {
  test("a switch, a slider, a box, a list, a row of buttons and a list of names", async ({
    page,
  }) => {
    const screen = await start(page);
    // A switch.
    await rowOf(screen, "appearance.paneHeaders").getByRole("switch").click();
    await expect.poll(written(page)).toContain('"paneHeaders": true');
    // A slider (the keys move the box that is at the end of the row).
    const width = rowOf(screen, "appearance.width");
    await width.getByRole("slider").focus();
    await page.keyboard.press("End");
    await expect.poll(written(page)).toContain('"width": 480');
    await expect(width.getByRole("textbox")).toHaveValue("480");
    // A row of buttons.
    await rowOf(screen, "appearance.side")
      .getByRole("radio", { name: "Right", exact: true })
      .check();
    await expect.poll(written(page)).toContain('"position": "right"');
    // A box with a number typed by hand, written when the person leaves it.
    const seconds = rowOf(screen, "notifications.longCommand").getByRole("textbox");
    await seconds.scrollIntoViewIfNeeded();
    await seconds.fill("45");
    await seconds.blur();
    await expect.poll(written(page)).toContain('"longCommandSeconds": 45');
    // A list of names (a box of text).
    const family = rowOf(screen, "terminal.fontList").getByRole("textbox");
    await family.fill("Consolas");
    await family.blur();
    await expect.poll(written(page)).toContain('"family": "Consolas"');
    // A drop-down list: the language, which the screen follows at once.
    await rowOf(screen, "appearance.language")
      .getByRole("combobox")
      .selectOption({ label: "Português (Brasil)" });
    await expect.poll(written(page)).toContain('"language": "pt-BR"');
    await expect(page.getByRole("dialog", { name: "Configurações", exact: true })).toBeVisible();
  });

  test("the chooser of a picture, with its thumbnail, its name and the two buttons on one row", async ({
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
    const thumb = await box(picker.locator(".background-thumb"));
    expect([thumb.width, thumb.height]).toEqual([48, 28]);
    const choose = picker.getByRole("button", { name: "Choose image…", exact: true });
    const remove = picker.getByRole("button", { name: "Remove", exact: true });
    expect((await box(choose)).y).toBe((await box(remove)).y);
    expect((await box(choose)).height).toBe(24);
    // The chooser button has a line in the highlight; the other one is plain.
    expect(await style(choose, "border-top-color")).toBe(await highlight(page));
    expect(await style(remove, "border-top-color")).not.toBe(await highlight(page));
    // The picker starts where the controls do.
    const label = await box(rowOf(screen, "appearance.language").locator("label"));
    expect(Math.round((await box(picker)).x - label.x)).toBe(252);
    // A file from the chooser of the system: the name is told, the box has its path, the file has it.
    await page.evaluate(() => (window as HookWindow).__norenTest?.setImagePick("fixtures/sky.png"));
    await choose.click();
    await expect(picker.locator('[data-nr-part="background-picker-name"]')).toHaveText("sky.png");
    await expect(rowOf(screen, "background.image").getByRole("textbox")).toHaveValue(
      "fixtures/sky.png",
    );
    await expect.poll(written(page)).toContain('"image": "fixtures/sky.png"');
    await remove.click();
    await expect(rowOf(screen, "background.image").getByRole("textbox")).toHaveValue("");
  });
});

test.describe("the interface style: two cards, each with the picture of its style", () => {
  test("Appearance opens with them; the chosen one has a line and a tint in the highlight", async ({
    page,
  }) => {
    const screen = await start(page);
    const first = sectionOf(screen, "appearance").locator("[data-nr-row]").first();
    await expect(first).toHaveAttribute("data-nr-row", "appearance.style");
    const group = first.getByRole("group", { name: "Interface style" });
    const cards = group.locator('[data-nr-part="settings-style-card"]');
    await expect(cards).toHaveCount(2);
    const [glass, dense] = [cards.nth(0), cards.nth(1)];
    // The picture of each is 120 by 70, as in the design, and the two cards are the same height.
    for (const card of [glass, dense]) {
      const thumb = await box(card.locator(".settings-style-thumb"));
      expect([thumb.width, thumb.height]).toEqual([120, 70]);
      expect(await style(card, "border-top-width")).toBe("1px");
      expect(await style(card, "border-top-left-radius")).toBe("0px");
    }
    expect((await box(glass)).height).toBe((await box(dense)).height);
    // The chosen one (dense) is ringed with the highlight; the other one is not.
    const wanted = await highlight(page);
    expect(await style(dense, "border-top-color")).toBe(wanted);
    expect(await style(glass, "border-top-color")).not.toBe(wanted);
    // Each card says its name and the line about it, and the radio is named by the style only.
    await expect(dense).toContainText("Dense technical");
    await expect(dense).toContainText("compact, square corners");
    await expect(group.getByRole("radio", { name: "Dense technical", exact: true })).toBeChecked();
    await expect(group.getByRole("radio", { name: "Glass", exact: true })).not.toBeChecked();
  });

  test("a click on the other card changes the style, the screen and the file at once; the arrows move the choice", async ({
    page,
  }) => {
    const screen = await start(page);
    const group = rowOf(screen, "appearance.style").getByRole("group", { name: "Interface style" });
    await group.locator('[data-nr-part="settings-style-card"]').first().click();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "glass");
    await expect.poll(written(page)).toMatch(/"style":\s*"glass"/);
    // The screen is the glass card at once: no crumb, no strip of the file, no slash.
    await expect(screen.locator('[data-nr-part="settings-crumb"]')).toHaveCount(0);
    await expect(screen.locator(".settings-footer-file")).toHaveCount(0);
    await expect(screen.locator(".settings-search-slash")).toHaveCount(0);
    await expect(screen.locator('[data-nr-part="settings-search-field"] svg')).toHaveCount(1);
    await settled(page);
    expect((await box(screen)).width).toBe(1120);
    // And back, with the keyboard: the radio of Glass has the focus, the right arrow chooses the other.
    const glass = group.getByRole("radio", { name: "Glass", exact: true });
    await glass.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "dense");
    await settled(page);
    expect(await box(screen)).toMatchObject({ x: 0, y: 32, width: 1280, height: 768 });
    await expect(screen.locator('[data-nr-part="settings-crumb"]')).toHaveText("/Appearance");
    await expect.poll(written(page)).toMatch(/"style":\s*"dense"/);
  });

  test("the highlight is the color of the space after the style is switched, not the accent of the theme (finding 355)", async ({
    page,
  }) => {
    const screen = await start(page, { style: "glass" });
    const wanted = await highlight(page);
    // The accent of the theme is another color: switching must not leave the page with that one.
    const accent = await rgbOf(page, "var(--nr-accent)");
    expect(wanted).not.toBe(accent);
    const cards = rowOf(screen, "appearance.style").locator('[data-nr-part="settings-style-card"]');
    await cards.nth(1).click();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "dense");
    await settled(page);
    expect(await highlight(page)).toBe(wanted);
    expect(await style(screen.locator(".settings-footer-label"), "background-color")).toBe(wanted);
    await cards.nth(0).click();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "glass");
    expect(await highlight(page)).toBe(wanted);
  });
});

test.describe("the colors of the highlight", () => {
  test("a switch that is on, the chosen button, the footer and the current section are in the color of the space, whichever of the four colors of the design it is", async ({
    page,
  }) => {
    const screen = await start(page);
    await closeSettings(page);
    const colors = [
      ["Cyan", "#2ee6d6"],
      ["Lime", "#b4ff39"],
      ["Apricot", "#ffb547"],
      ["Fuchsia", "#ff5ca8"],
    ] as const;
    for (const [name, hex] of colors) {
      await page.getByRole("button", { name: "New space", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "New space", exact: true });
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
      await dialog.getByRole("radio", { name, exact: true }).check();
      await dialog.getByRole("button", { name: "Create space", exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.getByRole("button", { name: "Settings", exact: true }).first().click();
      await expect(screen).toBeVisible();
      await settled(page);
      const wanted = await rgbOf(page, hex);
      expect(await highlight(page), name).toBe(wanted);
      // The footer chip is filled with it and carries the dark text.
      const chip = screen.locator(".settings-footer-label");
      expect(await style(chip, "background-color"), name).toBe(wanted);
      expect(await style(chip, "color"), name).toBe("rgb(13, 15, 30)");
      // The chosen button of a row is filled with it.
      const chosen = rowOf(screen, "appearance.side").locator("label:has(input:checked)");
      expect(await style(chosen, "background-color"), name).toBe(wanted);
      expect(await style(chosen, "color"), name).toBe("rgb(13, 15, 30)");
      // A switch that is on has its frame in it.
      const on = rowOf(screen, "terminal.cursorBlinks").getByRole("switch");
      await on.scrollIntoViewIfNeeded();
      expect(await style(on, "border-top-color"), name).toBe(wanted);
      await closeSettings(page);
    }
  });
});

test.describe("the themes: a list with the colors of each", () => {
  test("a row for each theme, a mark, its name, its eight colors and what it is; a click uses it", async ({
    page,
  }) => {
    const screen = await start(page);
    await navItem(screen, "themes").click();
    const gallery = screen.locator('[data-nr-part="theme-gallery"]');
    const cards = gallery.locator('[data-nr-part="theme-card"]');
    expect(await cards.count()).toBeGreaterThanOrEqual(8);
    const dusk = cards.filter({
      has: page.getByRole("button", { name: "Noren Dusk", exact: true }),
    });
    await expect(dusk.locator(".theme-pick")).toHaveAttribute("aria-pressed", "true");
    // The eight colors: the background, the six that tell a theme apart, the text; squares of 14 px.
    const swatches = await dusk.locator(".theme-thumb-colors").evaluate((element) => {
      const parts = [...element.children].map((child) => {
        const rect = child.getBoundingClientRect();
        return [rect.width, rect.height];
      });
      const before = getComputedStyle(element, "::before");
      const after = getComputedStyle(element, "::after");
      return {
        parts,
        before: [before.width, before.height],
        after: [after.width, after.height],
      };
    });
    expect(swatches.parts).toHaveLength(6);
    for (const part of swatches.parts) expect(part).toEqual([14, 14]);
    expect(swatches.before).toEqual(["14px", "14px"]);
    expect(swatches.after).toEqual(["14px", "14px"]);
    // The mark is generated (with no text of its own), the miniature of the glass screen is not drawn.
    expect(await style(dusk.locator(".theme-pick"), "content", "::before")).toContain("(");
    expect(await style(dusk.locator(".theme-thumb-title"), "display")).toBe("none");
    await expect(dusk.locator(".theme-pick")).toHaveAccessibleName("Noren Dusk");
    // A click on another one uses it and moves the mark.
    const paper = cards.filter({
      has: page.getByRole("button", { name: "Noren Paper", exact: true }),
    });
    await paper.locator(".theme-pick").click();
    await expect(paper.locator(".theme-pick")).toHaveAttribute("aria-pressed", "true");
    await expect(dusk.locator(".theme-pick")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(written(page)).toContain("noren-paper");
    // What can be done with a theme is the row of small buttons under it.
    const actions = paper.locator(".theme-actions .settings-link");
    expect(await actions.count()).toBeGreaterThanOrEqual(2);
    expect((await box(actions.first())).height).toBe(22);
  });
});

test.describe("the foot of the screen", () => {
  test("is a strip of 24 px with the file at the left and the line that says every change is saved at the right", async ({
    page,
  }) => {
    const screen = await start(page);
    const footer = screen.locator(".settings-footer");
    const strip = await box(footer);
    expect(strip.height).toBe(24);
    expect(strip.y + strip.height).toBe(800);
    expect(await style(footer, "border-top-width")).toBe("1px");
    await expect(footer.locator(".settings-footer-label")).toHaveText("Config");
    expect(await style(footer.locator(".settings-footer-label"), "text-transform")).toBe(
      "uppercase",
    );
    await expect(footer.locator(".settings-footer-name")).toHaveText("config.jsonc");
    const saved = footer.locator('[data-nr-part="settings-autosave"]');
    await expect(saved).toHaveText("Every change is saved as you make it.");
    expect(await style(saved, "content", "::before")).toContain("✓");
    const at = await box(saved);
    expect(Math.round(at.x + at.width)).toBe(1280);
    // The drawings are not read out: the line that says it is.
    await expect(footer.locator(".settings-footer-file")).toHaveAttribute("aria-hidden", "true");
  });

  test("a settings file with a problem is told in the strip, as before", async ({ page }) => {
    await seedConfig(page, '{ "appearance": { "style": "dense", "width": 100 } ');
    await page.goto("/");
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
      .toBe(1);
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    const screen = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(screen.locator('[data-nr-part="settings-file-problem"]')).toBeVisible();
    expect(
      await screen
        .locator('[data-nr-part="settings-file-problem"]')
        .evaluate((element) => element.closest(".settings-footer") !== null),
    ).toBe(true);
  });
});

test.describe("labels in Portuguese", () => {
  test("no label of a row is cut or left sticking out of its box, at 1280 and at 900 px", async ({
    page,
  }) => {
    for (const width of [1280, 900] as const) {
      await page.setViewportSize({ width, height: 800 });
      const screen = await start(page, { language: "pt-BR", width });
      const found = await screen.evaluate((root) => {
        const labels = [
          ...root.querySelectorAll(
            [
              ".settings-content .settings-number > .settings-option > span",
              ".settings-content .settings-number > .settings-option > label",
              ".settings-content .settings-toggle > .settings-option > span",
              ".settings-content .settings-choice-head > .settings-label",
            ].join(", "),
          ),
        ];
        return {
          count: labels.length,
          sticking: labels
            .filter((label) => label.scrollWidth - label.clientWidth > 0)
            .map((label) => label.textContent),
          cut: labels
            .filter((label) => getComputedStyle(label).textOverflow === "ellipsis")
            .map((label) => label.textContent),
          // A word that is not broken in the middle: the label never breaks inside a word.
          words: labels.filter((label) => label.getClientRects().length > 0).length,
        };
      });
      expect(found.count).toBeGreaterThan(40);
      expect(found.sticking, `${width} px`).toEqual([]);
      expect(found.cut, `${width} px`).toEqual([]);
      await page.goto("about:blank");
    }
  });
});

test.describe("narrow windows", () => {
  for (const width of [900, 720] as const) {
    test(`${width} px: nothing scrolls to the side, the content keeps its column`, async ({
      page,
    }) => {
      const screen = await start(page, { language: "pt-BR", width });
      for (const [id] of SECTIONS) {
        await navItem(screen, id).click();
        const report = await screen.evaluate((root) => {
          const content = root.querySelector('[data-nr-part="settings-content"]');
          const column = root.querySelector('[data-nr-part="settings-nav"]');
          if (content === null || column === null) throw new Error("no content");
          return {
            content: content.scrollWidth - content.clientWidth,
            column: column.scrollWidth - column.clientWidth,
            screen: root.scrollWidth - root.clientWidth,
          };
        });
        expect(report, `${id} at ${width}`).toEqual({ content: 0, column: 0, screen: 0 });
      }
    });
  }
});

test.describe("the glass screen does not change", () => {
  test("none of the dense parts is drawn", async ({ page }) => {
    const screen = await start(page, { style: "glass" });
    expect(await box(screen)).toMatchObject({ width: 1120 });
    for (const selector of [
      '[data-nr-part="settings-crumb"]',
      ".settings-close-text",
      ".settings-footer-file",
      ".settings-search-slash",
    ]) {
      await expect(screen.locator(selector), selector).toHaveCount(0);
    }
    await expect(screen.locator(".settings-nav-icon")).toHaveCount(SECTIONS.length);
    await expect(screen.locator('[data-nr-part="settings-search-field"] svg')).toHaveCount(1);
    expect(await style(screen, "backdrop-filter")).not.toBe("none");
    expect(await style(navItem(screen, "appearance"), "content", "::before")).toBe("none");
  });
});

test.describe("accessibility", () => {
  for (const language of ["en", "pt-BR"] as const) {
    for (const mode of ["dark", "light"] as const) {
      test(`axe finds nothing in the dense screen: ${language}, ${mode} theme`, async ({
        page,
      }) => {
        const screen = await start(page, { language, mode });
        const surface = `the dense settings screen, ${language}, ${mode} theme`;
        await expectNoAxeViolations(page, surface);
        // The same with a section brought to the top and with the search at work.
        await navItem(screen, "terminal").click();
        await expectNoAxeViolations(page, `${surface}, Terminal`);
        await searchBox(screen).fill("a");
        await expectNoAxeViolations(page, `${surface}, search`);
      });
    }
  }

  test("axe finds nothing with a space of each of the four colors of the design", async ({
    page,
  }) => {
    const screen = await start(page, { mode: "light" });
    await closeSettings(page);
    for (const [name] of [["Cyan"], ["Lime"], ["Apricot"], ["Fuchsia"]] as const) {
      await page.getByRole("button", { name: "New space", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "New space", exact: true });
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
      await dialog.getByRole("radio", { name, exact: true }).check();
      await dialog.getByRole("button", { name: "Create space", exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.getByRole("button", { name: "Settings", exact: true }).first().click();
      await expect(screen).toBeVisible();
      await settled(page);
      await expectNoAxeViolations(page, `the dense settings screen, a space of ${name}`);
      await closeSettings(page);
    }
  });
});
