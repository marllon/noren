import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { NOREN_DUSK, NOREN_PAPER, THEMES } from "../packages/model/src/builtin-themes";
import type { Theme } from "../packages/model/src/theme";
import { serializeTheme } from "../packages/model/src/user-themes";
import { expectNoAxeViolations } from "./axe-fixture";
import { configText, openSettings, seedConfig, settingsScreen } from "./settings-fixture";

// The themes section of the settings screen (NOR-F20-09a): a gallery of miniatures (the themes that
// ship with the app, then the person's own), a click on one uses it for the whole app or only for
// the active space, a theme can be duplicated, and one of the person's own can be renamed, exported,
// deleted and imported again. The web build keeps the theme files under `noren.web.themes`; the
// save chooser of an export is the fake one of `FakeBackend`, which a test answers
// (`__norenTest.setThemeExportPick`); the system chooser is never opened.

interface Hook {
  paneIds(): string[];
  setThemeExportPick(path: string | null): void;
  failThemeExport(message: string): void;
  themeExportCalls(): { fileName: string; title: string; filter: string; text: string }[];
  exportedThemes(): Record<string, string>;
  themeFiles(): Record<string, string>;
  failThemeDelete(message?: string): void;
  failThemeSave(message?: string): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_THEMES_KEY = "noren.web.themes";

/** The colors the themes used below put on the page (packages/model/src/builtin-themes.ts). */
const BG = { dusk: "#14161b", paper: "#f6f3ec", mine: "#102a43", zebra: "#2a1a3a" } as const;

/** Two themes of the person: "Mine" (dark blue, a font and a picture of its own) and "Zebra". */
const MINE: Theme = {
  ...NOREN_DUSK,
  id: "mine",
  name: "Mine",
  ui: { ...NOREN_DUSK.ui, bg: BG.mine, accent: "#10b981" },
  font: { family: "Fira Code", size: 15, lineHeight: 1.3, ligatures: false },
  background: { image: "backgrounds/sky.png", opacity: 0.4, blur: 5 },
};
const ZEBRA: Theme = {
  ...NOREN_PAPER,
  id: "zebra",
  name: "Zebra",
  ui: { ...NOREN_PAPER.ui, bg: BG.zebra, surface: "#341f48" },
};

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const themeFiles = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.themeFiles() ?? {});
const exported = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.exportedThemes() ?? {});
const exportCalls = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.themeExportCalls() ?? []);

async function seedThemes(page: Page, themes: readonly Theme[]): Promise<void> {
  const files = Object.fromEntries(themes.map((theme) => [theme.id, serializeTheme(theme)]));
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_THEMES_KEY, value: JSON.stringify(files) },
  );
}

/** The app with the themes of the person seeded and the file of the settings given. */
async function start(
  page: Page,
  options: { themes?: readonly Theme[]; config?: string } = {},
): Promise<void> {
  if (options.themes !== undefined) await seedThemes(page, options.themes);
  if (options.config !== undefined) await seedConfig(page, options.config);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
}

const section = (screen: Locator, name = "Themes"): Locator =>
  screen.getByRole("region", { name, exact: true });
const gallery = (screen: Locator, name = "Theme gallery", region = "Themes"): Locator =>
  section(screen, region).getByRole("list", { name, exact: true });
const card = (screen: Locator, id: string): Locator =>
  screen.locator(`[data-nr-part="theme-card"][data-nr-theme="${id}"]`);
const pick = (screen: Locator, name: string): Locator =>
  screen.getByRole("button", { name, exact: true });
const status = (screen: Locator): Locator => screen.locator('[data-nr-part="themes-status"]');
const fileInput = (page: Page): Locator =>
  page.locator('input[type="file"][data-nr-part="themes-file"]');
const renameDialog = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Rename theme", exact: true });
const deleteDialog = (page: Page): Locator =>
  page.getByRole("alertdialog", { name: "Delete theme", exact: true });

/** Opens the settings and brings the themes section into view; returns the screen. */
async function openThemes(page: Page): Promise<Locator> {
  const screen = await openSettings(page);
  await section(screen).scrollIntoViewIfNeeded();
  await expect(gallery(screen)).toBeVisible();
  return screen;
}

/** The names of the cards in the gallery, in order. */
const cardNames = (screen: Locator): Promise<string[]> =>
  screen.locator('[data-nr-part="theme-card"] .theme-name').allTextContents();

/** Makes a second space "Work" and leaves it as the active one. */
async function addSpace(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe("the gallery", () => {
  test("shows the eight themes that ship with the app, then the ones of the person, each with a miniature", async ({
    page,
  }) => {
    await start(page, { themes: [MINE, ZEBRA] });
    const screen = await openThemes(page);
    const names = await cardNames(screen);
    expect(names).toEqual([...THEMES.map((theme) => theme.name), "Mine", "Zebra"]);
    expect(THEMES).toHaveLength(8);
    for (const theme of THEMES) {
      await expect(card(screen, theme.id)).toHaveAttribute("data-nr-origin", "built-in");
    }
    await expect(card(screen, "mine")).toHaveAttribute("data-nr-origin", "user");
    await expect(card(screen, "zebra")).toHaveAttribute("data-nr-origin", "user");
    await expect(card(screen, "mine")).toContainText("Dark · Yours");
    await expect(card(screen, "noren-paper")).toContainText("Light · Built in");
    // Every card draws its miniature from the colors of its own theme.
    for (const theme of [...THEMES, MINE, ZEBRA]) {
      const thumb = card(screen, theme.id).locator('[data-nr-part="theme-thumbnail"]');
      await expect(thumb).toHaveCount(1);
      const colors = await thumb.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          bg: style.getPropertyValue("--thumb-bg").trim(),
          accent: style.getPropertyValue("--thumb-accent").trim(),
          terminal: style.getPropertyValue("--thumb-term-bg").trim(),
          cursor: style.getPropertyValue("--thumb-cursor").trim(),
        };
      });
      expect(colors, theme.id).toEqual({
        bg: theme.ui.bg,
        accent: theme.ui.accent,
        terminal: theme.terminal.background,
        cursor: theme.terminal.cursor,
      });
    }
  });

  test("the miniatures are aligned in a grid, none cut off or on top of another", async ({
    page,
  }) => {
    await start(page, { themes: [MINE, ZEBRA] });
    const screen = await openThemes(page);
    const boxes = await screen
      .locator('[data-nr-part="theme-card"]')
      .evaluateAll((cards) => cards.map((c) => c.getBoundingClientRect().toJSON()));
    const list = await gallery(screen).evaluate((element) =>
      element.getBoundingClientRect().toJSON(),
    );
    expect(boxes).toHaveLength(10);
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(list.left - 0.5);
      expect(box.right).toBeLessThanOrEqual(list.right + 0.5);
    }
    // Cards of a row share a top edge and a width; no two overlap.
    const rows = new Map<number, number[]>();
    for (const box of boxes)
      rows.set(Math.round(box.top), [...(rows.get(Math.round(box.top)) ?? []), box.width]);
    expect(rows.size).toBeGreaterThanOrEqual(2);
    for (const widths of rows.values()) {
      for (const width of widths) expect(Math.abs(width - (widths[0] ?? 0))).toBeLessThan(1);
    }
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const apart =
          a.right <= b.left + 0.5 ||
          b.right <= a.left + 0.5 ||
          a.bottom <= b.top + 0.5 ||
          b.bottom <= a.top + 0.5;
        expect(apart, "two cards overlap").toBe(true);
      }
    }
  });

  test("nothing is pressed while the app follows the system, and 'Follow the system' is off", async ({
    page,
  }) => {
    await start(page);
    const screen = await openThemes(page);
    await expect(gallery(screen).getByRole("button", { pressed: true })).toHaveCount(0);
    await expect(
      screen.getByRole("button", { name: "Follow the system", exact: true }),
    ).toBeDisabled();
    // Only "Customize" (the editor, NOR-F20-09b) and "Duplicate" for a theme that ships with the app.
    await expect(card(screen, "noren-dusk").getByRole("button")).toHaveCount(3);
    await expect(
      card(screen, "noren-dusk").getByRole("button", { name: "Customize Noren Dusk", exact: true }),
    ).toBeVisible();
    await expect(
      card(screen, "noren-dusk").getByRole("button", { name: "Duplicate Noren Dusk", exact: true }),
    ).toBeVisible();
  });

  test("a theme of the person has Edit, Duplicate, Rename, Export and Delete", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    const buttons = card(screen, "mine").getByRole("button");
    await expect(buttons).toHaveCount(6);
    for (const name of [
      "Edit Mine",
      "Duplicate Mine",
      "Rename Mine",
      "Export Mine",
      "Delete Mine",
    ]) {
      await expect(card(screen, "mine").getByRole("button", { name, exact: true })).toBeVisible();
    }
  });

  test("the section is second in the column of sections and as wide as the content", async ({
    page,
  }) => {
    await start(page);
    const screen = await openSettings(page);
    const regions = await screen
      .locator("section.settings-section")
      .evaluateAll((all) => all.map((s) => s.getAttribute("aria-label")));
    const at = regions.indexOf("Themes");
    // The screen of NOR-F20-10a lists the sections as the column does: Appearance, Themes, Window...
    expect(regions.slice(at - 1, at + 2)).toEqual(["Appearance", "Themes", "Window"]);
    const widths = await screen
      .locator("section.settings-section")
      .evaluateAll((all) => all.map((s) => Math.round(s.getBoundingClientRect().width)));
    const form = await screen
      .locator(".settings-sections")
      .evaluate((element) => Math.round(element.getBoundingClientRect().width));
    expect(widths[at]).toBe(form);
  });
});

test.describe("using a theme", () => {
  test("for the whole app: it shows at once, is written to the settings file and the card says so", async ({
    page,
  }) => {
    await start(page, { config: '{ "appearance": { "theme": "noren-dusk" } }' });
    const screen = await openThemes(page);
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.dusk);
    await expect(pick(screen, "Noren Dusk")).toHaveAttribute("aria-pressed", "true");
    await pick(screen, "Noren Paper").click();
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.paper);
    await expect(pick(screen, "Noren Paper")).toHaveAttribute("aria-pressed", "true");
    await expect(pick(screen, "Noren Dusk")).toHaveAttribute("aria-pressed", "false");
    await expect(card(screen, "noren-paper").locator('[data-nr-part="theme-tag-app"]')).toHaveText(
      "In use: whole app",
    );
    await expect(card(screen, "noren-dusk").locator('[data-nr-part="theme-tag-app"]')).toHaveCount(
      0,
    );
    await expect(status(screen)).toHaveText("Using “Noren Paper” for the whole app.");
    await expect.poll(() => configText(page)).toContain('"theme": "noren-paper"');
    // It is not part of Save: the screen can be cancelled and the theme stays.
    await screen.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(settingsScreen(page)).toHaveCount(0);
    expect(await rootVar(page, "--nr-bg")).toBe(BG.paper);
    expect(await configText(page)).toContain('"theme": "noren-paper"');
  });

  test("a theme of the person can be used for the whole app too, and survives a reload", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await pick(screen, "Mine").click();
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.mine);
    await expect.poll(() => configText(page)).toContain('"theme": "mine"');
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
      .toBeGreaterThan(0);
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.mine);
  });

  test("'Follow the system' puts the app back on the theme of the system", async ({ page }) => {
    await start(page, { config: '{ "appearance": { "theme": "noren-dusk" } }' });
    const screen = await openThemes(page);
    const follow = screen.getByRole("button", { name: "Follow the system", exact: true });
    await expect(follow).toBeEnabled();
    await follow.click();
    await expect(status(screen)).toHaveText(
      "The app follows the light or dark theme of the system.",
    );
    await expect.poll(() => configText(page)).toContain('"theme": "system"');
    await expect(follow).toBeDisabled();
    await expect(gallery(screen).getByRole("button", { pressed: true })).toHaveCount(0);
  });

  test("only for the space: the window shows it, the settings file does not change, the other spaces keep the app's theme", async ({
    page,
  }) => {
    await start(page, { config: '{ "appearance": { "theme": "noren-dusk" } }' });
    await addSpace(page, "Work");
    const screen = await openThemes(page);
    const before = await configText(page);
    await screen.getByRole("radio", { name: "Only the space “Work”", exact: true }).check();
    await pick(screen, "Noren Paper").click();
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.paper);
    await expect(status(screen)).toHaveText("Using “Noren Paper” only in the space “Work”.");
    await expect(
      card(screen, "noren-paper").locator('[data-nr-part="theme-tag-space"]'),
    ).toHaveText("In use: this space");
    await expect(card(screen, "noren-dusk").locator('[data-nr-part="theme-tag-app"]')).toHaveText(
      "In use: whole app",
    );
    await expect(pick(screen, "Noren Paper")).toHaveAttribute("aria-pressed", "true");
    expect(await configText(page)).toBe(before);
    // Back in the first space the theme of the app shows.
    await screen.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Spaces", exact: true })
      .getByRole("button", { name: "Main", exact: true })
      .click();
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.dusk);
    await page
      .getByRole("navigation", { name: "Spaces", exact: true })
      .getByRole("button", { name: "Work", exact: true })
      .click();
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.paper);
  });

  test("'Use the theme of the app' takes the theme of the space away", async ({ page }) => {
    await start(page, { config: '{ "appearance": { "theme": "noren-dusk" } }' });
    const screen = await openThemes(page);
    const scope = screen.getByRole("radio", { name: "Only the space “Main”", exact: true });
    await scope.check();
    const useGlobal = screen.getByRole("button", { name: "Use the theme of the app", exact: true });
    await expect(useGlobal).toBeDisabled();
    await pick(screen, "Noren Paper").click();
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.paper);
    await expect(useGlobal).toBeEnabled();
    await useGlobal.click();
    await expect(status(screen)).toHaveText("The space “Main” uses the theme of the app again.");
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.dusk);
    await expect(useGlobal).toBeDisabled();
    await expect(
      card(screen, "noren-paper").locator('[data-nr-part="theme-tag-space"]'),
    ).toHaveCount(0);
  });

  test("with a theme of its own the active space says why a theme for the app does not show in it", async ({
    page,
  }) => {
    await start(page, { config: '{ "appearance": { "theme": "noren-dusk" } }' });
    const screen = await openThemes(page);
    await expect(screen.locator('[data-nr-part="themes-space-override"]')).toHaveCount(0);
    await screen.getByRole("radio", { name: "Only the space “Main”", exact: true }).check();
    await pick(screen, "Noren Paper").click();
    await screen.getByRole("radio", { name: "The whole app", exact: true }).check();
    await expect(screen.locator('[data-nr-part="themes-space-override"]')).toHaveText(
      "The space “Main” has a theme of its own, so the theme of the app shows in the other spaces.",
    );
    // Using a theme for the whole app now changes the file but not the window, which the space holds.
    await pick(screen, "Noren Dusk").click();
    await expect.poll(() => configText(page)).toContain('"theme": "noren-dusk"');
    expect(await rootVar(page, "--nr-bg")).toBe(BG.paper);
  });

  test("a refused write of the settings is said under the gallery", async ({ page }) => {
    await start(page, { config: '{ "appearance": { "theme": "noren-dusk", } ' });
    const screen = await openThemes(page);
    await pick(screen, "Noren Paper").click();
    await expect(status(screen)).toContainText("Could not use the theme:");
    await expect(status(screen)).toHaveAttribute("role", "alert");
  });
});

test.describe("duplicating", () => {
  test("a theme that ships with the app becomes a theme of the person's, written to the themes folder", async ({
    page,
  }) => {
    await start(page);
    const screen = await openThemes(page);
    await card(screen, "noren-dusk")
      .getByRole("button", { name: "Duplicate Noren Dusk", exact: true })
      .click();
    await expect(card(screen, "noren-dusk-copy")).toHaveAttribute("data-nr-origin", "user");
    await expect(card(screen, "noren-dusk-copy").locator(".theme-name")).toHaveText(
      "Noren Dusk copy",
    );
    await expect(status(screen)).toContainText("“Noren Dusk copy”");
    const files = await themeFiles(page);
    expect(Object.keys(files)).toEqual(["noren-dusk-copy"]);
    expect(JSON.parse(files["noren-dusk-copy"] ?? "{}")).toEqual({
      ...NOREN_DUSK,
      id: "noren-dusk-copy",
      name: "Noren Dusk copy",
    });
    // The keyboard is on the new card, and the copy has the actions of a theme of the person.
    await expect(pick(screen, "Noren Dusk copy")).toBeFocused();
    await expect(
      card(screen, "noren-dusk-copy").getByRole("button", {
        name: "Delete Noren Dusk copy",
        exact: true,
      }),
    ).toBeVisible();
    // The original did not change.
    await expect(card(screen, "noren-dusk")).toHaveAttribute("data-nr-origin", "built-in");
    expect(await cardNames(screen)).toEqual([
      ...THEMES.map((theme) => theme.name),
      "Noren Dusk copy",
    ]);
  });

  test("a second copy of the same theme gets its own name and id, and the copy of a copy too", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    const duplicate = (name: string) =>
      screen.getByRole("button", { name: `Duplicate ${name}`, exact: true }).click();
    await duplicate("Mine");
    await duplicate("Mine");
    await duplicate("Mine copy");
    expect(Object.keys(await themeFiles(page)).sort()).toEqual([
      "mine",
      "mine-copy",
      "mine-copy-2",
      "mine-copy-copy",
    ]);
    const files = await themeFiles(page);
    expect(JSON.parse(files["mine-copy-2"] ?? "{}").name).toBe("Mine copy (2)");
    // A copy keeps the font and the picture of a theme of the person, not only its colors.
    expect(JSON.parse(files["mine-copy"] ?? "{}")).toEqual({
      ...MINE,
      id: "mine-copy",
      name: "Mine copy",
    });
  });

  test("the copy is a theme the window can use, and is still there after a reload", async ({
    page,
  }) => {
    await start(page);
    const screen = await openThemes(page);
    await screen.getByRole("button", { name: "Duplicate Noren Paper", exact: true }).click();
    await pick(screen, "Noren Paper copy").click();
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.paper);
    await expect.poll(() => configText(page)).toContain('"theme": "noren-paper-copy"');
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
      .toBeGreaterThan(0);
    const again = await openThemes(page);
    await expect(pick(again, "Noren Paper copy")).toHaveAttribute("aria-pressed", "true");
  });

  test("a disk that refuses says so and adds no card", async ({ page }) => {
    await start(page);
    const screen = await openThemes(page);
    await page.evaluate(() => (window as HookWindow).__norenTest?.failThemeSave("disk full"));
    await screen.getByRole("button", { name: "Duplicate Noren Dusk", exact: true }).click();
    await expect(status(screen)).toHaveText("Could not duplicate “Noren Dusk”: disk full");
    await expect(status(screen)).toHaveAttribute("role", "alert");
    expect(await cardNames(screen)).toHaveLength(8);
    expect(await themeFiles(page)).toEqual({});
    // Once the disk takes it again the same click works.
    await page.evaluate(() => (window as HookWindow).__norenTest?.failThemeSave());
    await screen.getByRole("button", { name: "Duplicate Noren Dusk", exact: true }).click();
    await expect(card(screen, "noren-dusk-copy")).toHaveCount(1);
  });
});

test.describe("renaming", () => {
  test("a theme of the person gets a new name, in the same file, and the gallery keeps its order", async ({
    page,
  }) => {
    await start(page, { themes: [MINE, ZEBRA] });
    const screen = await openThemes(page);
    await card(screen, "mine").getByRole("button", { name: "Rename Mine", exact: true }).click();
    const dialog = renameDialog(page);
    await expect(dialog).toBeVisible();
    const box = dialog.getByRole("textbox", { name: "Name", exact: true });
    await expect(box).toBeFocused();
    await expect(box).toHaveValue("Mine");
    await box.fill("  Yacht   club ");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await cardNames(screen)).toEqual([
      ...THEMES.map((theme) => theme.name),
      "Yacht club",
      "Zebra",
    ]);
    await expect(status(screen)).toHaveText("Renamed to “Yacht club”.");
    const files = await themeFiles(page);
    expect(Object.keys(files).sort()).toEqual(["mine", "zebra"]);
    expect(JSON.parse(files["mine"] ?? "{}")).toEqual({ ...MINE, name: "Yacht club" });
    // The keyboard is back on the Rename button of the card, whose label has the new name.
    await expect(
      card(screen, "mine").getByRole("button", { name: "Rename Yacht club", exact: true }),
    ).toBeFocused();
  });

  test("Enter in the box renames, and does not save or close the settings", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await screen.getByRole("button", { name: "Rename Mine", exact: true }).click();
    await page.keyboard.type("Quick");
    await page.keyboard.press("Enter");
    await expect(renameDialog(page)).toHaveCount(0);
    await expect(settingsScreen(page)).toBeVisible();
    await expect(card(screen, "mine").locator(".theme-name")).toHaveText("Quick");
  });

  test("Escape closes the dialog only, not the settings, and the name stays", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await screen.getByRole("button", { name: "Rename Mine", exact: true }).click();
    await page.keyboard.type("Never");
    await page.keyboard.press("Escape");
    await expect(renameDialog(page)).toHaveCount(0);
    await expect(settingsScreen(page)).toBeVisible();
    await expect(card(screen, "mine").locator(".theme-name")).toHaveText("Mine");
    await expect(screen.getByRole("button", { name: "Rename Mine", exact: true })).toBeFocused();
    expect(JSON.parse((await themeFiles(page))["mine"] ?? "{}").name).toBe("Mine");
  });

  test("an empty name or one that is too long is refused under the box and the dialog stays", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await screen.getByRole("button", { name: "Rename Mine", exact: true }).click();
    const dialog = renameDialog(page);
    const box = dialog.getByRole("textbox", { name: "Name", exact: true });
    await box.fill("   ");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText("A theme needs a name.");
    await expect(box).toHaveAttribute("aria-invalid", "true");
    await box.fill("x".repeat(61));
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText("A name has at most 60 characters.");
    await expect(dialog).toBeVisible();
    expect(JSON.parse((await themeFiles(page))["mine"] ?? "{}").name).toBe("Mine");
    await box.fill("x".repeat(60));
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card(screen, "mine").locator(".theme-name")).toHaveText("x".repeat(60));
  });

  test("renaming the theme in use keeps it in use, and the window does not change", async ({
    page,
  }) => {
    await start(page, { themes: [MINE], config: '{ "appearance": { "theme": "mine" } }' });
    const screen = await openThemes(page);
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.mine);
    await screen.getByRole("button", { name: "Rename Mine", exact: true }).click();
    await page.keyboard.type("Renamed");
    await page.keyboard.press("Enter");
    await expect(pick(screen, "Renamed")).toHaveAttribute("aria-pressed", "true");
    expect(await rootVar(page, "--nr-bg")).toBe(BG.mine);
    expect(await configText(page)).toContain('"theme": "mine"');
  });
});

test.describe("deleting", () => {
  test("asks first, and Cancel keeps the theme, its file and the keyboard on its card", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await screen.getByRole("button", { name: "Delete Mine", exact: true }).click();
    const dialog = deleteDialog(page);
    await expect(dialog).toContainText("Delete “Mine”?");
    await expect(dialog).toContainText("it cannot be brought back");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card(screen, "mine")).toHaveCount(1);
    expect(Object.keys(await themeFiles(page))).toEqual(["mine"]);
    await expect(pick(screen, "Mine")).toBeFocused();
  });

  test("Escape in the question closes the question only, not the settings", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await screen.getByRole("button", { name: "Delete Mine", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(deleteDialog(page)).toHaveCount(0);
    await expect(settingsScreen(page)).toBeVisible();
    expect(Object.keys(await themeFiles(page))).toEqual(["mine"]);
  });

  test("Delete removes the card and the file, and leaves the other themes alone", async ({
    page,
  }) => {
    await start(page, { themes: [MINE, ZEBRA] });
    const screen = await openThemes(page);
    await screen.getByRole("button", { name: "Delete Mine", exact: true }).click();
    await deleteDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(deleteDialog(page)).toHaveCount(0);
    await expect(card(screen, "mine")).toHaveCount(0);
    await expect(status(screen)).toHaveText("Deleted “Mine”.");
    expect(Object.keys(await themeFiles(page))).toEqual(["zebra"]);
    expect(await cardNames(screen)).toEqual([...THEMES.map((theme) => theme.name), "Zebra"]);
    // The themes that ship with the app have no Delete at all.
    await expect(screen.getByRole("button", { name: /^Delete / })).toHaveCount(1);
    // Gone after a reload, too.
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
      .toBeGreaterThan(0);
    const again = await openThemes(page);
    await expect(card(again, "mine")).toHaveCount(0);
    await expect(card(again, "zebra")).toHaveCount(1);
  });

  test("deleting the theme in use sends the app back to the theme of the system", async ({
    page,
  }) => {
    await start(page, { themes: [MINE], config: '{ "appearance": { "theme": "mine" } }' });
    const screen = await openThemes(page);
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.mine);
    await screen.getByRole("button", { name: "Delete Mine", exact: true }).click();
    await deleteDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(card(screen, "mine")).toHaveCount(0);
    await expect.poll(() => rootVar(page, "--nr-bg")).not.toBe(BG.mine);
    await expect(gallery(screen).getByRole("button", { pressed: true })).toHaveCount(0);
  });

  test("deleting the theme of the active space sends the space back to the theme of the app", async ({
    page,
  }) => {
    await start(page, { themes: [MINE], config: '{ "appearance": { "theme": "noren-dusk" } }' });
    const screen = await openThemes(page);
    await screen.getByRole("radio", { name: "Only the space “Main”", exact: true }).check();
    await pick(screen, "Mine").click();
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.mine);
    await screen.getByRole("button", { name: "Delete Mine", exact: true }).click();
    await deleteDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.dusk);
  });

  test("a disk that refuses says so, and the theme stays", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await page.evaluate(() => (window as HookWindow).__norenTest?.failThemeDelete("access denied"));
    await screen.getByRole("button", { name: "Delete Mine", exact: true }).click();
    await deleteDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(status(screen)).toHaveText("Could not delete “Mine”: access denied");
    await expect(status(screen)).toHaveAttribute("role", "alert");
    await expect(card(screen, "mine")).toHaveCount(1);
    expect(Object.keys(await themeFiles(page))).toEqual(["mine"]);
    // The keyboard stays on the card whose file is still there.
    await expect(pick(screen, "Mine")).toBeFocused();
  });

  test("after a delete the keyboard is on the first card of the gallery", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await screen.getByRole("button", { name: "Delete Mine", exact: true }).click();
    await deleteDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(card(screen, "mine")).toHaveCount(0);
    await expect(pick(screen, "Noren Dusk")).toBeFocused();
  });
});

test.describe("exporting", () => {
  test("hands the theme to the save chooser as the text of its file and says where it went", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setThemeExportPick("C:\\Users\\me\\Downloads\\mine.json"),
    );
    await screen.getByRole("button", { name: "Export Mine", exact: true }).click();
    await expect(status(screen)).toHaveText(
      "Exported “Mine” to C:\\Users\\me\\Downloads\\mine.json.",
    );
    const calls = await exportCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fileName: "mine.json",
      title: "Export theme",
      filter: "Theme files",
    });
    const files = await exported(page);
    expect(Object.keys(files)).toEqual(["C:\\Users\\me\\Downloads\\mine.json"]);
    // What is in the file is the theme, whole.
    expect(JSON.parse(files["C:\\Users\\me\\Downloads\\mine.json"] ?? "{}")).toEqual(MINE);
    expect(Object.keys(await themeFiles(page))).toEqual(["mine"]);
  });

  test("a chooser closed with no choice writes nothing and is not an error", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await screen.getByRole("button", { name: "Export Mine", exact: true }).click();
    await expect(status(screen)).toHaveText("Nothing was exported: no file was chosen.");
    await expect(status(screen)).toHaveAttribute("role", "status");
    expect(await exported(page)).toEqual({});
  });

  test("a chooser that cannot be opened is said, as a problem", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.failThemeExport("the file chooser could not be opened"),
    );
    await screen.getByRole("button", { name: "Export Mine", exact: true }).click();
    await expect(status(screen)).toHaveText(
      "Could not export “Mine”: the file chooser could not be opened",
    );
    await expect(status(screen)).toHaveAttribute("role", "alert");
  });
});

test.describe("importing", () => {
  test("a theme that was exported comes back whole, on a window that has not got it", async ({
    page,
  }) => {
    await start(page);
    const screen = await openThemes(page);
    expect(await cardNames(screen)).toHaveLength(8);
    // The button opens the chooser of the page; the test answers it with the exported file.
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      screen.getByRole("button", { name: "Import theme...", exact: true }).click(),
    ]);
    await chooser.setFiles({
      name: "mine.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeTheme(MINE)),
    });
    await expect(card(screen, "mine")).toHaveAttribute("data-nr-origin", "user");
    await expect(status(screen)).toContainText("Imported color scheme");
    const files = await themeFiles(page);
    expect(JSON.parse(files["mine"] ?? "{}")).toEqual(MINE);
    await expect(
      card(screen, "mine").getByRole("button", { name: "Rename Mine", exact: true }),
    ).toBeVisible();
  });

  test("a theme whose id is taken comes in as a copy, and the theme that was there is not touched", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await fileInput(page).setInputFiles({
      name: "mine.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeTheme({ ...MINE, ui: { ...MINE.ui, accent: "#ff00aa" } })),
    });
    await expect(card(screen, "mine-2")).toHaveCount(1);
    expect(await cardNames(screen)).toEqual([
      ...THEMES.map((theme) => theme.name),
      "Mine",
      "Mine (2)",
    ]);
    const files = await themeFiles(page);
    expect(JSON.parse(files["mine"] ?? "{}")).toEqual(MINE);
    expect(JSON.parse(files["mine-2"] ?? "{}").ui.accent).toBe("#ff00aa");
  });

  test("a theme exported in this window and imported again takes a new id, and the file is the same theme", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const screen = await openThemes(page);
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setThemeExportPick("C:\\out\\mine"),
    );
    await screen.getByRole("button", { name: "Export Mine", exact: true }).click();
    const written = (await exported(page))["C:\\out\\mine.json"];
    expect(written).toBeDefined();
    await fileInput(page).setInputFiles({
      name: "mine.json",
      mimeType: "application/json",
      buffer: Buffer.from(written ?? ""),
    });
    await expect(card(screen, "mine-2")).toHaveCount(1);
    const copy = JSON.parse((await themeFiles(page))["mine-2"] ?? "{}");
    expect(copy).toEqual({ ...MINE, id: "mine-2", name: "Mine (2)" });
  });

  test("a color scheme of another program is still read, and becomes a theme of the person's", async ({
    page,
  }) => {
    await start(page);
    const screen = await openThemes(page);
    const scheme = [
      "background = #101820",
      "foreground = #d6e2ee",
      "cursor-color = #5aa3e8",
      "palette = 0=#101820",
      "palette = 1=#e06c75",
      "palette = 2=#98c379",
      "palette = 3=#e5c07b",
      "palette = 4=#61afef",
      "palette = 5=#c678dd",
      "palette = 6=#56b6c2",
      "palette = 7=#d6e2ee",
      "palette = 8=#5c6370",
      "palette = 9=#e06c75",
      "palette = 10=#98c379",
      "palette = 11=#e5c07b",
      "palette = 12=#61afef",
      "palette = 13=#c678dd",
      "palette = 14=#56b6c2",
      "palette = 15=#ffffff",
    ].join("\n");
    await fileInput(page).setInputFiles({
      name: "Lagoon",
      mimeType: "text/plain",
      buffer: Buffer.from(scheme),
    });
    await expect(card(screen, "lagoon")).toHaveAttribute("data-nr-origin", "user");
    await expect(status(screen)).toContainText('Imported color scheme "Lagoon"');
  });

  test("a file that is not a theme says why, adds no card and writes nothing", async ({ page }) => {
    await start(page);
    const screen = await openThemes(page);
    await fileInput(page).setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("just some words, no colors here"),
    });
    await expect(status(screen)).toContainText('Could not import "notes.txt"');
    expect(await cardNames(screen)).toHaveLength(8);
    expect(await themeFiles(page)).toEqual({});
  });

  test("a theme file with a color that is not one is refused with where it is wrong", async ({
    page,
  }) => {
    await start(page);
    const screen = await openThemes(page);
    await fileInput(page).setInputFiles({
      name: "broken.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ ...MINE, ui: { ...MINE.ui, accent: "teal" } })),
    });
    await expect(status(screen)).toContainText("This theme file is not valid: ui.accent");
    expect(await cardNames(screen)).toHaveLength(8);
    expect(await themeFiles(page)).toEqual({});
  });
});

test.describe("in Portuguese", () => {
  test("the section, the cards and every answer are in Portuguese", async ({ page }) => {
    await start(page, { themes: [MINE], config: '{ "language": "pt-BR" }' });
    await page.getByRole("button", { name: "Configurações", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Configurações", exact: true });
    await expect(dialog).toBeVisible();
    const themes = dialog.getByRole("region", { name: "Temas", exact: true });
    await themes.scrollIntoViewIfNeeded();
    await expect(gallery(dialog, "Galeria de temas", "Temas")).toBeVisible();
    await expect(themes.getByRole("radio", { name: "O app todo", exact: true })).toBeChecked();
    await expect(themes.getByRole("radio", { name: /^Só o espaço “/ })).toBeVisible();
    await expect(card(dialog, "mine")).toContainText("Escuro · Seu");
    await expect(card(dialog, "noren-paper")).toContainText("Claro · De fábrica");
    await expect(
      themes.getByRole("button", { name: "Seguir o sistema", exact: true }),
    ).toBeVisible();
    await expect(
      themes.getByRole("button", { name: "Importar tema...", exact: true }),
    ).toBeVisible();

    await themes.getByRole("button", { name: "Noren Paper", exact: true }).click();
    await expect(status(dialog)).toHaveText("Usando “Noren Paper” no app todo.");
    await expect(card(dialog, "noren-paper")).toContainText("Em uso: app todo");

    await themes.getByRole("button", { name: "Duplicar Noren Paper", exact: true }).click();
    await expect(card(dialog, "noren-paper-copia").locator(".theme-name")).toHaveText(
      "Noren Paper (cópia)",
    );
    await themes.getByRole("button", { name: "Renomear Mine", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Renomear tema", exact: true });
    await expect(rename).toBeVisible();
    await rename.getByRole("textbox", { name: "Nome", exact: true }).fill("");
    await rename.getByRole("button", { name: "Renomear", exact: true }).click();
    await expect(rename.getByRole("alert")).toHaveText("Um tema precisa de um nome.");
    await rename.getByRole("button", { name: "Cancelar", exact: true }).click();
    await themes.getByRole("button", { name: "Apagar Mine", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Apagar tema", exact: true });
    await expect(confirm).toContainText("Apagar “Mine”?");
    await confirm.getByRole("button", { name: "Apagar", exact: true }).click();
    await expect(status(dialog)).toHaveText("O tema “Mine” foi apagado.");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setThemeExportPick("C:\\out\\copia.json"),
    );
    await themes.getByRole("button", { name: "Exportar Noren Paper (cópia)", exact: true }).click();
    await expect(status(dialog)).toHaveText(
      "Exportado “Noren Paper (cópia)” para C:\\out\\copia.json.",
    );
    const calls = await exportCalls(page);
    expect(calls[0]).toMatchObject({ title: "Exportar tema", filter: "Arquivos de tema" });
  });
});

test.describe("accessibility", () => {
  for (const [label, theme] of [
    ["dark", "noren-dusk"],
    ["light", "noren-paper"],
  ] as const) {
    test(`axe: the gallery, with a theme in use, in the ${label} theme, has no violation`, async ({
      page,
    }) => {
      await start(page, {
        themes: [MINE, ZEBRA],
        config: `{ "appearance": { "theme": "${theme}" } }`,
      });
      const screen = await openThemes(page);
      await pick(screen, theme === "noren-dusk" ? "Noren Dusk" : "Noren Paper").click();
      await expect(status(screen)).toContainText("Using");
      await expectNoAxeViolations(page, `themes section (${label})`);
    });

    test(`axe: the gallery for a space, with the line that says what happened, in the ${label} theme`, async ({
      page,
    }) => {
      await start(page, { themes: [MINE], config: `{ "appearance": { "theme": "${theme}" } }` });
      const screen = await openThemes(page);
      await screen.getByRole("radio", { name: "Only the space “Main”", exact: true }).check();
      await pick(screen, "Mine").click();
      await expect(status(screen)).toContainText("Using");
      await expectNoAxeViolations(page, `themes section for a space (${label})`);
    });

    test(`axe: the rename dialog and the delete question, in the ${label} theme, have no violation`, async ({
      page,
    }) => {
      await start(page, { themes: [MINE], config: `{ "appearance": { "theme": "${theme}" } }` });
      const screen = await openThemes(page);
      await screen.getByRole("button", { name: "Rename Mine", exact: true }).click();
      await expect(renameDialog(page)).toBeVisible();
      await expectNoAxeViolations(page, `rename theme dialog (${label})`);
      await page.keyboard.press("Escape");
      await screen.getByRole("button", { name: "Delete Mine", exact: true }).click();
      await expect(deleteDialog(page)).toBeVisible();
      await expectNoAxeViolations(page, `delete theme question (${label})`);
    });
  }

  test("the buttons of a card and the gallery can all be reached and used with the keyboard", async ({
    page,
  }) => {
    await start(page, { themes: [MINE], config: '{ "appearance": { "theme": "noren-dusk" } }' });
    const screen = await openThemes(page);
    await pick(screen, "Noren Paper").focus();
    await expect(pick(screen, "Noren Paper")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(BG.paper);
    await page.keyboard.press("Tab");
    await expect(
      screen.getByRole("button", { name: "Customize Noren Paper", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      screen.getByRole("button", { name: "Duplicate Noren Paper", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Space");
    await expect(card(screen, "noren-paper-copy")).toHaveCount(1);
  });
});
