import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { WEB_CONFIG_KEY, saveSettings, seedConfig } from "./settings-fixture";

// The settings screen of NOR-F20-10a: a column of sections on the left, a search on top that keeps
// the sections and the rows that have its words, and one column of rows (label and explanation on
// the left, control on the right) on a grid of 8 px. The screen is the same form as before, so the
// controls and Save keep working; this file covers what is new: the column, the search, the grid,
// the screen that no longer scrolls sideways (finding 329) and axe on every section.

type HookWindow = Window & { __norenTest?: { paneIds(): string[] } };

/** The sections of the column, in order: the part name, the name in English and in Portuguese. */
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

type Language = "en" | "pt-BR";
type Mode = "dark" | "light";

const THEME: Record<Mode, string> = { dark: "noren-dusk", light: "noren-paper" };
const SETTINGS_NAME: Record<Language, string> = { en: "Settings", "pt-BR": "Configurações" };
const SEARCH_NAME: Record<Language, string> = {
  en: "Search settings",
  "pt-BR": "Buscar nas configurações",
};

function fileFor(language: Language, mode: Mode): string {
  const lang = language === "pt-BR" ? '"language": "pt-BR", ' : "";
  return `{ ${lang}"appearance": { "theme": "${THEME[mode]}" } }\n`;
}

async function start(
  page: Page,
  options: {
    language?: Language;
    mode?: Mode;
    file?: string;
    /** CSS files for the mods folder (the web build keeps them in the browser storage). */
    mods?: Record<string, string>;
  } = {},
): Promise<Locator> {
  const language = options.language ?? "en";
  if (options.mods !== undefined) {
    await page.addInitScript(
      ({ key, value }) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      { key: "noren.web.mods", value: JSON.stringify(options.mods) },
    );
  }
  await seedConfig(page, options.file ?? fileFor(language, options.mode ?? "dark"));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  await page.getByRole("button", { name: SETTINGS_NAME[language], exact: true }).click();
  const screen = page.getByRole("dialog", { name: SETTINGS_NAME[language], exact: true });
  await expect(screen).toBeVisible();
  return screen;
}

const navOf = (screen: Locator): Locator => screen.locator('[data-nr-part="settings-nav"]');
const contentOf = (screen: Locator): Locator => screen.locator('[data-nr-part="settings-content"]');
const navItem = (screen: Locator, name: string): Locator =>
  navOf(screen).getByRole("button", { name, exact: true });
const searchBox = (screen: Locator, language: Language = "en"): Locator =>
  screen.getByRole("searchbox", { name: SEARCH_NAME[language], exact: true });
const sectionOf = (screen: Locator, id: string): Locator =>
  screen.locator(`section[data-nr-part="settings-${id}"]`);
const heading = (screen: Locator, name: string): Locator =>
  screen.getByRole("heading", { name, level: 3, exact: true });

/** How far the top of a section is from the top of the content, less the padding: 0 when scrolled to the top. */
function offsetOf(screen: Locator, id: string): Promise<number> {
  return screen.evaluate((root, part) => {
    const content = root.querySelector('[data-nr-part="settings-content"]');
    const section = root.querySelector(`section[data-nr-part="settings-${part}"]`);
    if (content === null || section === null) return Number.NaN;
    const pad = Number.parseFloat(getComputedStyle(content).paddingTop);
    return Math.round(
      section.getBoundingClientRect().top - content.getBoundingClientRect().top - pad,
    );
  }, id);
}

/** The names of the buttons in the column, in order. */
const columnNames = (screen: Locator): Promise<string[]> =>
  navOf(screen)
    .getByRole("button")
    .evaluateAll((all) => all.map((button) => (button.textContent ?? "").trim()));

/** The sections of the content that show (the others are hidden by a search), by part name. */
const shownSections = (screen: Locator): Promise<string[]> =>
  screen
    .locator("section.settings-section")
    .evaluateAll((all) =>
      all
        .filter((section) => section.getClientRects().length > 0)
        .map((section) => section.getAttribute("data-nr-section") ?? ""),
    );

test.describe("the column of sections", () => {
  test("lists the sections in order, as buttons, with the first one current", async ({ page }) => {
    const screen = await start(page);
    expect(await columnNames(screen)).toEqual(SECTIONS.map(([, en]) => en));
    await expect(navOf(screen)).toHaveAccessibleName("Settings sections");
    await expect(navItem(screen, "Appearance")).toHaveAttribute("aria-current", "true");
    await expect(navOf(screen).locator('[aria-current="true"]')).toHaveCount(1);
    // The content has the same sections in the same order, each one a named region.
    expect(await shownSections(screen)).toEqual(SECTIONS.map(([id]) => id));
    for (const [id, en] of SECTIONS) {
      await expect(sectionOf(screen, id)).toHaveAttribute("data-nr-part", `settings-${id}`);
      await expect(heading(screen, en)).toBeVisible();
    }
  });

  for (const [id, en] of SECTIONS) {
    test(`a click on "${en}" shows the section at the top and marks it current`, async ({
      page,
    }) => {
      const screen = await start(page);
      await navItem(screen, en).click();
      await expect(navItem(screen, en)).toHaveAttribute("aria-current", "true");
      await expect(navOf(screen).locator('[aria-current="true"]')).toHaveCount(1);
      await expect.poll(() => offsetOf(screen, id)).toBeLessThanOrEqual(1);
      expect(await offsetOf(screen, id)).toBeGreaterThanOrEqual(-1);
      await expect(heading(screen, en)).toBeVisible();
      // The keyboard goes with the person: the next Tab is a control of the section.
      await expect(heading(screen, en)).toBeFocused();
    });
  }

  test("follows the scroll: the section at the top of the content is the current one", async ({
    page,
  }) => {
    const screen = await start(page);
    await expect(navItem(screen, "Appearance")).toHaveAttribute("aria-current", "true");
    await contentOf(screen).evaluate((content) => {
      const section = content.querySelector('section[data-nr-part="settings-sync"]');
      if (section === null) throw new Error("no Sync section");
      const pad = Number.parseFloat(getComputedStyle(content).paddingTop);
      content.scrollTop +=
        section.getBoundingClientRect().top - content.getBoundingClientRect().top - pad;
    });
    await expect(navItem(screen, "Sync")).toHaveAttribute("aria-current", "true");
    await expect(navItem(screen, "Appearance")).not.toHaveAttribute("aria-current", "true");
    await contentOf(screen).evaluate((content) => {
      content.scrollTop = 0;
    });
    await expect(navItem(screen, "Appearance")).toHaveAttribute("aria-current", "true");
  });

  test("is one stop for the Tab key: the current section, and the arrows go through it", async ({
    page,
  }) => {
    const screen = await start(page);
    const tabbable = () =>
      navOf(screen)
        .getByRole("button")
        .evaluateAll((all) =>
          all.filter((b) => b.getAttribute("tabindex") === "0").map((b) => b.textContent ?? ""),
        );
    expect(await tabbable()).toEqual(["Appearance"]);
    await navItem(screen, "Terminal").click();
    expect(await tabbable()).toEqual(["Terminal"]);

    await navItem(screen, "Appearance").focus();
    await page.keyboard.press("ArrowDown");
    await expect(navItem(screen, "Themes")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(navItem(screen, "Window")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(navItem(screen, "Themes")).toBeFocused();
    await page.keyboard.press("End");
    await expect(navItem(screen, "Import")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(navItem(screen, "Import")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(navItem(screen, "Appearance")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(navItem(screen, "Appearance")).toBeFocused();
  });

  test("Enter and Space on a section of the column show it", async ({ page }) => {
    const screen = await start(page);
    await navItem(screen, "Appearance").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(navItem(screen, "Background")).toBeFocused();
    // The arrows only move the focus; nothing was scrolled yet.
    await expect(navItem(screen, "Appearance")).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Enter");
    await expect(navItem(screen, "Background")).toHaveAttribute("aria-current", "true");
    await expect.poll(() => offsetOf(screen, "background")).toBeLessThanOrEqual(1);
    await expect(heading(screen, "Background")).toBeFocused();

    await navItem(screen, "Terminal").focus();
    await page.keyboard.press("Space");
    await expect(navItem(screen, "Terminal")).toHaveAttribute("aria-current", "true");
    await expect.poll(() => offsetOf(screen, "terminal")).toBeLessThanOrEqual(1);
    await expect(heading(screen, "Terminal")).toBeFocused();
    // The next Tab is inside the section the person went to: its first control.
    await page.keyboard.press("Tab");
    await expect(screen.getByRole("textbox", { name: "Font list", exact: true })).toBeFocused();
  });

  test("keeps working in Portuguese, with the names of the sections in Portuguese", async ({
    page,
  }) => {
    const screen = await start(page, { language: "pt-BR" });
    await expect(navOf(screen)).toHaveAccessibleName("Seções das configurações");
    expect(await columnNames(screen)).toEqual(SECTIONS.map(([, , pt]) => pt));
    await navItem(screen, "Sincronização").click();
    await expect(navItem(screen, "Sincronização")).toHaveAttribute("aria-current", "true");
    await expect.poll(() => offsetOf(screen, "sync")).toBeLessThanOrEqual(1);
  });
});

test.describe("the search", () => {
  test("has a name and a placeholder, and is the first thing the keyboard is on", async ({
    page,
  }) => {
    const screen = await start(page);
    await expect(searchBox(screen)).toBeVisible();
    await expect(searchBox(screen)).toHaveAttribute("placeholder", "Search settings");
    await expect(searchBox(screen)).toBeFocused();
  });

  test("keeps the section and the row that have the word, and nothing else", async ({ page }) => {
    const screen = await start(page);
    await searchBox(screen).fill("scrollback");
    expect(await columnNames(screen)).toEqual(["Terminal"]);
    expect(await shownSections(screen)).toEqual(["terminal"]);
    await expect(
      screen.getByRole("textbox", { name: "Scrollback (lines)", exact: true }),
    ).toBeVisible();
    await expect(screen.getByRole("textbox", { name: "Font size (px)", exact: true })).toBeHidden();
    await expect(screen.getByRole("group", { name: "Cursor shape", exact: true })).toBeHidden();
    // Rows of other sections are hidden too, and the sections they are in are gone from the column.
    await expect(
      screen.getByRole("textbox", { name: "Sidebar width (px)", exact: true }),
    ).toBeHidden();
    await expect(heading(screen, "Terminal")).toBeVisible();
    await expect(heading(screen, "Appearance")).toBeHidden();
    await expect(screen.locator('[data-nr-part="settings-search-none"]')).toHaveCount(0);
  });

  test("finds a field by a word of its explanation or of one of its choices", async ({ page }) => {
    const screen = await start(page);
    await searchBox(screen).fill("ligatures");
    await expect(
      screen.getByRole("checkbox", { name: "Font ligatures", exact: true }),
    ).toBeVisible();
    await searchBox(screen).fill("underline");
    await expect(screen.getByRole("group", { name: "Cursor shape", exact: true })).toBeVisible();
    await expect(screen.getByRole("radio", { name: "Underline", exact: true })).toBeVisible();
    await expect(screen.getByRole("checkbox", { name: "Cursor blinks", exact: true })).toBeHidden();
    await searchBox(screen).fill("beep");
    await expect(
      screen.getByRole("group", { name: "When a program rings the bell", exact: true }),
    ).toBeVisible();
    expect(await columnNames(screen)).toEqual(["Terminal"]);
  });

  test("a word of a section's title keeps the whole section; more words narrow it", async ({
    page,
  }) => {
    const screen = await start(page);
    await searchBox(screen).fill("terminal");
    expect(await columnNames(screen)).toContain("Terminal");
    await expect(
      screen.getByRole("textbox", { name: "Font size (px)", exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("textbox", { name: "Scrollback (lines)", exact: true }),
    ).toBeVisible();
    await searchBox(screen).fill("terminal cursor");
    await expect(screen.getByRole("group", { name: "Cursor shape", exact: true })).toBeVisible();
    await expect(
      screen.getByRole("checkbox", { name: "Cursor blinks", exact: true }),
    ).toBeVisible();
    await expect(screen.getByRole("textbox", { name: "Font size (px)", exact: true })).toBeHidden();
  });

  test("ignores case and accents, in Portuguese too", async ({ page }) => {
    const screen = await start(page, { language: "pt-BR" });
    await searchBox(screen, "pt-BR").fill("SINCRONIZACAO");
    expect(await columnNames(screen)).toEqual(["Sincronização"]);
    await expect(
      screen.getByRole("combobox", { name: "Sincronizar por", exact: true }),
    ).toBeVisible();
    await searchBox(screen, "pt-BR").fill("notificacoes");
    expect(await columnNames(screen)).toEqual(["Notificações"]);
    await searchBox(screen, "pt-BR").fill("historico");
    await expect(
      screen.getByRole("textbox", { name: "Histórico (linhas)", exact: true }),
    ).toBeVisible();
  });

  test("says that nothing matches, with the words, and the column has no section", async ({
    page,
  }) => {
    const screen = await start(page);
    await searchBox(screen).fill("zzzzqq");
    const none = screen.locator('[data-nr-part="settings-search-none"]');
    await expect(none).toHaveText("No setting matches “zzzzqq”.");
    await expect(none).toHaveAttribute("role", "status");
    expect(await columnNames(screen)).toEqual([]);
    expect(await shownSections(screen)).toEqual([]);
    // Save and Cancel are still there.
    await expect(screen.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(screen.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    // Emptying the box brings everything back.
    await searchBox(screen).fill("");
    await expect(none).toHaveCount(0);
    expect(await columnNames(screen)).toEqual(SECTIONS.map(([, en]) => en));
    expect(await shownSections(screen)).toEqual(SECTIONS.map(([id]) => id));
  });

  test("says it in Portuguese", async ({ page }) => {
    const screen = await start(page, { language: "pt-BR" });
    await searchBox(screen, "pt-BR").fill("zzzzqq");
    await expect(screen.locator('[data-nr-part="settings-search-none"]')).toHaveText(
      "Nenhuma configuração corresponde a “zzzzqq”.",
    );
  });

  test("starts at the top of what it kept, wherever the content was scrolled", async ({ page }) => {
    const screen = await start(page);
    await navItem(screen, "Sync").click();
    await expect.poll(() => offsetOf(screen, "sync")).toBeLessThanOrEqual(1);
    await searchBox(screen).fill("scrollback");
    await expect(heading(screen, "Terminal")).toBeVisible();
    await expect.poll(() => offsetOf(screen, "terminal")).toBe(0);
    expect(await contentOf(screen).evaluate((content) => content.scrollTop)).toBe(0);
    // And emptying the box starts at the top of the whole screen.
    await searchBox(screen).fill("");
    await expect(navItem(screen, "Appearance")).toHaveAttribute("aria-current", "true");
    expect(await contentOf(screen).evaluate((content) => content.scrollTop)).toBe(0);
  });

  test("Escape empties the box first and the next Escape closes the screen", async ({ page }) => {
    const screen = await start(page);
    await searchBox(screen).fill("sync");
    await searchBox(screen).press("Escape");
    await expect(searchBox(screen)).toHaveValue("");
    await expect(screen).toBeVisible();
    expect(await columnNames(screen)).toEqual(SECTIONS.map(([, en]) => en));
    await searchBox(screen).press("Escape");
    await expect(screen).toHaveCount(0);
  });

  test("Enter in the box does not save the screen", async ({ page }) => {
    const screen = await start(page);
    await screen.getByRole("textbox", { name: "Sidebar width (px)", exact: true }).fill("240");
    await searchBox(screen).fill("width");
    await searchBox(screen).press("Enter");
    await expect(screen).toBeVisible();
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), WEB_CONFIG_KEY),
    ).not.toContain("240");
  });

  test("a row hidden by the search keeps what was typed in it, and Save writes it", async ({
    page,
  }) => {
    const screen = await start(page);
    const width = screen.getByRole("textbox", { name: "Sidebar width (px)", exact: true });
    await width.fill("240");
    await searchBox(screen).fill("scrollback");
    await expect(width).toBeHidden();
    await screen.getByRole("textbox", { name: "Scrollback (lines)", exact: true }).fill("5000");
    await searchBox(screen).fill("");
    await expect(width).toHaveValue("240");
    await saveSettings(page);
    const text =
      (await page.evaluate((key) => window.localStorage.getItem(key), WEB_CONFIG_KEY)) ?? "";
    expect(text).toMatch(/"width":\s*240/);
    expect(text).toMatch(/"scrollback":\s*5000/);
  });

  test("a control that a search brought to the top works as it did", async ({ page }) => {
    const screen = await start(page);
    await searchBox(screen).fill("pane headers");
    await screen.getByRole("checkbox", { name: "Pane headers", exact: true }).check();
    await saveSettings(page);
    const text =
      (await page.evaluate((key) => window.localStorage.getItem(key), WEB_CONFIG_KEY)) ?? "";
    expect(text).toMatch(/"paneHeaders":\s*true/);
  });

  test("with a search the column lists only what is left, and a click on it still shows the section", async ({
    page,
  }) => {
    const screen = await start(page);
    await searchBox(screen).fill("sync");
    const names = await columnNames(screen);
    expect(names).toContain("Sync");
    expect(names.length).toBeLessThan(SECTIONS.length);
    await navItem(screen, "Sync").click();
    await expect(navItem(screen, "Sync")).toHaveAttribute("aria-current", "true");
    await expect(heading(screen, "Sync")).toBeVisible();
  });
});

test.describe("the grid", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  /** The left edge of every label and of every control of the rows, relative to the form. */
  async function edges(screen: Locator) {
    return screen.evaluate((root) => {
      const form = root.querySelector(".settings-form");
      if (form === null) throw new Error("no form");
      const origin = form.getBoundingClientRect().left;
      const shown = (element: Element) => element.getClientRects().length > 0;
      const lefts = (selector: string): number[] =>
        [...root.querySelectorAll(`.settings-content ${selector}`)]
          .filter(shown)
          .map((element) => Math.round(element.getBoundingClientRect().left - origin));
      return {
        labels: lefts(
          [
            ".settings-number > .settings-option > :is(span, label)",
            ".settings-toggle > .settings-option > span",
            ".settings-choice-head",
            ".settings-action > .settings-explain-text",
            ".settings-gallery-text",
          ].join(", "),
        ),
        controls: lefts(
          [
            ".settings-number > .settings-option > :is(input, select, textarea)",
            ".settings-number > .settings-slider",
            ".settings-toggle > .settings-option > input",
            ".settings-choices",
            ".settings-action-buttons",
            ".settings-gallery-item > button",
            ".settings-sync-buttons",
            ".background-picker",
          ].join(", "),
        ),
      };
    });
  }

  test("every label starts at one line and every control at another, in every section", async ({
    page,
  }) => {
    // Two mods (one on, with its order buttons) and an SSH profile put the rows of the lists and of the
    // frames that reach into the padding on screen, besides the form of a provider that is always there.
    const screen = await start(page, {
      file: '{ "appearance": { "theme": "noren-dusk" }, "mods": ["quiet.css"] }\n',
      mods: { "quiet.css": "body {}", "loud.css": "body {}" },
    });
    await expect(screen.locator('[data-nr-part="settings-mod"]')).toHaveCount(2);
    await screen.getByRole("button", { name: "Add SSH profile", exact: true }).click();
    const found = await edges(screen);
    expect(found.labels.length).toBeGreaterThan(40);
    expect(found.controls.length).toBeGreaterThan(40);
    expect([...new Set(found.labels)]).toHaveLength(1);
    expect([...new Set(found.controls)]).toHaveLength(1);
    // The labels are on the left of the controls, with room between them.
    expect((found.controls[0] ?? 0) - (found.labels[0] ?? 0)).toBeGreaterThanOrEqual(240);
  });

  test("every size of the layout is a multiple of 8 px", async ({ page }) => {
    const screen = await start(page);
    const sizes = await screen.evaluate((root) => {
      const px = (value: string): number => Number.parseFloat(value);
      const one = (selector: string): Element => {
        const found = root.querySelector(selector);
        if (found === null) throw new Error(`no ${selector}`);
        return found;
      };
      const style = (selector: string) => getComputedStyle(one(selector));
      const box = (selector: string) => one(selector).getBoundingClientRect();
      const form = box(".settings-form");
      const out: Record<string, number> = {
        dialogWidth: root.getBoundingClientRect().width,
        dialogHeight: root.getBoundingClientRect().height,
        headerPaddingTop: px(style(".settings-header").paddingTop),
        headerPaddingLeft: px(style(".settings-header").paddingLeft),
        searchHeight: box(".settings-search").height,
        searchWidth: box(".settings-search").width,
        columnWidth: box(".settings-nav").width,
        columnPadding: px(style(".settings-nav").paddingLeft),
        columnItemHeight: box(".settings-nav-item").height,
        contentPaddingTop: px(style(".settings-content").paddingTop),
        contentPaddingLeft: px(style(".settings-content").paddingLeft),
        contentPaddingRight: px(style(".settings-content").paddingRight),
        sectionGap: px(style(".settings-sections").rowGap),
        rowPaddingTop: px(style(".settings-row").paddingTop),
        rowPaddingBottom: px(style(".settings-row").paddingBottom),
        inputHeight: box(".settings-number > .settings-option > input").height,
        controlWidth: box(".settings-number > .settings-option > input").width,
        labelLeft: box(".settings-number > .settings-option > span").left - form.left,
        controlLeft: box(".settings-number > .settings-option > input").left - form.left,
        footerPaddingTop: px(style(".settings-footer").paddingTop),
        footerPaddingLeft: px(style(".settings-footer").paddingLeft),
      };
      return out;
    });
    const off = Object.entries(sizes).filter(([, value]) => Math.round(value * 100) % 800 !== 0);
    expect(off, JSON.stringify(sizes)).toEqual([]);
    expect(sizes["dialogWidth"]).toBe(960);
    expect(sizes["columnWidth"]).toBe(192);
    expect(sizes["controlWidth"]).toBe(320);
  });

  test("a label and its explanation stay together in the left column, the control in the right", async ({
    page,
  }) => {
    const screen = await start(page);
    const row = screen.locator('[data-nr-row="terminal.ligatures"]');
    await row.scrollIntoViewIfNeeded();
    const label = await row.locator(".settings-option > span").boundingBox();
    const hint = await row.locator(".settings-explain").boundingBox();
    const box = await row.getByRole("checkbox").boundingBox();
    if (label === null || hint === null || box === null)
      throw new Error("a part of the row has no box");
    // The explanation is under the label (same left edge, lower), in gray, and the box is beside the label.
    expect(Math.abs(hint.x - label.x)).toBeLessThanOrEqual(1);
    expect(hint.y).toBeGreaterThan(label.y + label.height - 1);
    expect(box.x).toBeGreaterThan(label.x + 240);
    expect(box.y).toBeLessThan(hint.y);
    await expect(row.locator(".settings-explain")).toHaveCSS("color", /rgb/);
    // And the box is described by the explanation, for a screen reader.
    await expect(row.getByRole("checkbox")).toHaveAccessibleDescription(
      "Ligatures are accepted, but the terminal does not draw them yet.",
    );
  });
});

test.describe("no sideways scroll (finding 329)", () => {
  for (const language of ["en", "pt-BR"] as const) {
    for (const mode of ["dark", "light"] as const) {
      for (const width of [1280, 900] as const) {
        test(`${language}, ${mode} theme, ${width} px wide: the screen and its content do not scroll to the side`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height: 800 });
          const screen = await start(page, { language, mode });
          // Every section, in the order of the column, each brought to the top.
          for (const [id, en, pt] of SECTIONS) {
            await navItem(screen, language === "en" ? en : pt).click();
            await expect.poll(() => offsetOf(screen, id)).toBeLessThanOrEqual(1);
          }
          const report = await screen.evaluate((root) => {
            const content = root.querySelector('[data-nr-part="settings-content"]');
            if (content === null) throw new Error("no content");
            const box = content.getBoundingClientRect();
            const wide: string[] = [];
            for (const element of content.querySelectorAll<HTMLElement>("*")) {
              if (element.getClientRects().length === 0) continue;
              const rect = element.getBoundingClientRect();
              if (rect.width === 0) continue;
              if (rect.right <= box.right + 1 && rect.left >= box.left - 1) continue;
              // Something inside a box that scrolls on its own (the table of the bench) may be wider.
              let inside = false;
              for (
                let up = element.parentElement;
                up !== null && up !== content;
                up = up.parentElement
              ) {
                const overflow = getComputedStyle(up).overflowX;
                if (overflow === "auto" || overflow === "scroll") inside = true;
              }
              if (!inside) {
                wide.push(
                  `${element.tagName}.${element.className} ${Math.round(rect.left - box.left)}..${Math.round(rect.right - box.right)}`,
                );
              }
            }
            return {
              dialog: { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth },
              content: { scrollWidth: content.scrollWidth, clientWidth: content.clientWidth },
              wide: wide.slice(0, 8),
            };
          });
          expect(report.dialog.scrollWidth, "the dialog scrolls to the side").toBeLessThanOrEqual(
            report.dialog.clientWidth,
          );
          expect(report.content.scrollWidth, "the content scrolls to the side").toBeLessThanOrEqual(
            report.content.clientWidth,
          );
          expect(report.wide, "elements wider than the content").toEqual([]);
        });
      }
    }
  }

  test("the selector of the sync method fits its column in Portuguese", async ({ page }) => {
    const screen = await start(page, { language: "pt-BR" });
    await navItem(screen, "Sincronização").click();
    const select = screen.getByRole("combobox", { name: "Sincronizar por", exact: true });
    await expect(select).toBeVisible();
    const fits = await screen.evaluate((root) => {
      const content = root.querySelector('[data-nr-part="settings-content"]');
      const box = root.querySelector('[data-nr-part="settings-sync"] select');
      if (content === null || box === null) throw new Error("no content or no selector");
      const outer = content.getBoundingClientRect();
      const inner = box.getBoundingClientRect();
      return { left: inner.left - outer.left, right: outer.right - inner.right };
    });
    expect(fits.left).toBeGreaterThanOrEqual(0);
    expect(fits.right).toBeGreaterThanOrEqual(0);
  });

  test("Save and Cancel stay in view and nothing covers the search while the file has a problem", async ({
    page,
  }) => {
    const screen = await start(page, {
      file: '{ "appearance": { "sidebar": { "position": "middle" } } }\n',
    });
    await expect(screen.locator('[data-nr-part="settings-file-problem"]')).toContainText("line 1");
    // The notice of the window sits under the screen, so the buttons and the search can be used.
    await searchBox(screen).fill("width");
    await expect(searchBox(screen)).toHaveValue("width");
    await screen.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(screen).toHaveCount(0);
  });
});

test.describe("axe on every section", () => {
  for (const [language, mode] of [
    ["en", "dark"],
    ["en", "light"],
    ["pt-BR", "dark"],
    ["pt-BR", "light"],
  ] as const) {
    for (const [id, en, pt] of SECTIONS) {
      const name = language === "en" ? en : pt;
      test(`${language}, ${mode} theme: the "${name}" section has no axe violation`, async ({
        page,
      }) => {
        const screen = await start(page, { language, mode });
        await navItem(screen, name).click();
        await expect.poll(() => offsetOf(screen, id)).toBeLessThanOrEqual(1);
        await expectNoAxeViolations(page, `settings ${language} ${mode}: ${name}`);
      });
    }
  }

  for (const mode of ["dark", "light"] as const) {
    test(`${mode} theme: a search with rows left, and one with none, have no axe violation`, async ({
      page,
    }) => {
      const screen = await start(page, { mode });
      await searchBox(screen).fill("cursor");
      await expect(screen.getByRole("group", { name: "Cursor shape", exact: true })).toBeVisible();
      await expectNoAxeViolations(page, `settings ${mode}: a search`);
      await searchBox(screen).fill("zzzzqq");
      await expect(screen.locator('[data-nr-part="settings-search-none"]')).toBeVisible();
      await expectNoAxeViolations(page, `settings ${mode}: a search with no result`);
    });

    test(`${mode} theme: the Profiles section with an SSH profile and a row with a problem`, async ({
      page,
    }) => {
      const screen = await start(page, { mode });
      await navItem(screen, "Profiles").click();
      await screen.getByRole("button", { name: "Add SSH profile", exact: true }).click();
      await screen
        .getByRole("textbox", { name: "Port (optional)", exact: true })
        .fill("not a port");
      await expectNoAxeViolations(page, `settings ${mode}: Profiles with a problem`);
    });
  }
});

test("a screen that was opened with its controls working still saves from any section", async ({
  page,
}) => {
  const screen = await start(page);
  await navItem(screen, "Notifications").click();
  await screen.getByRole("checkbox", { name: "System notifications", exact: true }).uncheck();
  await navItem(screen, "Terminal").click();
  await screen.getByRole("radio", { name: "Bar", exact: true }).check();
  await saveSettings(page);
  const text =
    (await page.evaluate((key) => window.localStorage.getItem(key), WEB_CONFIG_KEY)) ?? "";
  expect(text).toMatch(/"enabled":\s*false/);
  expect(text).toMatch(/"style":\s*"bar"/);
});
