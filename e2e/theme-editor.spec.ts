import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { NOREN_DUSK, NOREN_PAPER, THEMES } from "../packages/model/src/builtin-themes";
import { importColorSchemes } from "../packages/model/src/importers";
import { ThemeSchema, parseTheme } from "../packages/model/src/theme";
import type { Theme } from "../packages/model/src/theme";
import { serializeTheme } from "../packages/model/src/user-themes";
import { expectNoAxeViolations } from "./axe-fixture";
import { openSettings, seedConfig } from "./settings-fixture";

// The theme editor (NOR-F20-09b): "Customize" on a theme that ships with the app and "Edit" on one
// of the person's own open a dialog with every group of a theme (the accent, the background and the
// text, the sidebar, the terminal with its sixteen colors, the cursor and the selection, the font,
// the corners, the transparency and the background picture) and a preview drawn from the theme being
// edited. Nothing is written until "Save as my theme" (or "Save changes"); Cancel and Escape throw the
// changes away. The web build keeps the theme files under `noren.web.themes` and the pictures a path
// can name under `noren.web.images`; the file chooser of the picture is the fake one of
// `FakeBackend`, which a test answers (`__norenTest.setImagePick`).

interface Hook {
  paneIds(): string[];
  setImagePick(path: string | null): void;
  setThemeExportPick(path: string | null): void;
  exportedThemes(): Record<string, string>;
  themeFiles(): Record<string, string>;
  failThemeSave(message?: string): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_THEMES_KEY = "noren.web.themes";
const WEB_IMAGES_KEY = "noren.web.images";
const FIXTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));
const PICTURE = "fixtures/background.png";

/** One of the person's own themes with a value of its own in every group. */
const MINE: Theme = {
  ...NOREN_DUSK,
  id: "mine",
  name: "Mine",
  ui: { ...NOREN_DUSK.ui, bg: "#102a43", surface: "#16384f", accent: "#10b981", radius: 4 },
  terminal: { ...NOREN_DUSK.terminal, background: "#0d2236", cursor: "#10b981" },
  font: { family: "Fira Code", size: 15, lineHeight: 1.3, ligatures: false },
  background: { image: PICTURE, opacity: 0.4, blur: 5 },
};

/** The settings that put the dark theme in force, so a test does not depend on the color scheme of the browser. */
const DUSK = '{ "appearance": { "theme": "noren-dusk" } }';

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const themeFiles = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.themeFiles() ?? {});

async function start(
  page: Page,
  options: { themes?: readonly Theme[]; config?: string } = {},
): Promise<void> {
  const files = Object.fromEntries((options.themes ?? []).map((t) => [t.id, serializeTheme(t)]));
  for (const [key, value] of [
    [WEB_THEMES_KEY, JSON.stringify(files)],
    [WEB_IMAGES_KEY, JSON.stringify({ [PICTURE]: FIXTURE.toString("base64") })],
  ] as const) {
    await page.addInitScript(
      ({ k, v }) => {
        if (window.localStorage.getItem(k) === null) window.localStorage.setItem(k, v);
      },
      { k: key, v: value },
    );
  }
  if (options.config !== undefined) await seedConfig(page, options.config);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
}

const editor = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Theme editor", exact: true });
const preview = (page: Page): Locator => editor(page).locator('[data-nr-part="theme-preview"]');
const card = (screen: Locator, id: string): Locator =>
  screen.locator(`[data-nr-part="theme-card"][data-nr-theme="${id}"]`);
const status = (screen: Locator): Locator => screen.locator('[data-nr-part="themes-status"]');
const box = (page: Page, name: string): Locator =>
  editor(page).getByRole("textbox", { name, exact: true });
const group = (page: Page, id: string): Locator => editor(page).locator(`[data-nr-group="${id}"]`);

/** Opens the settings and the editor of the card of `id` (the button says Customize or Edit). */
async function openEditor(page: Page, id: string): Promise<Locator> {
  const screen = await openSettings(page);
  await card(screen, id).scrollIntoViewIfNeeded();
  await card(screen, id).locator('[data-nr-action="edit"]').click();
  await expect(editor(page)).toBeVisible();
  return screen;
}

/** The value of a custom property of the preview. */
const previewVar = (page: Page, name: string): Promise<string> =>
  preview(page).evaluate((element, n) => element.style.getPropertyValue(n).trim(), name);
/** A computed style of an element of the preview. */
const previewStyle = (page: Page, selector: string, property: string): Promise<string> =>
  preview(page)
    .locator(selector)
    .first()
    .evaluate((element, p) => getComputedStyle(element).getPropertyValue(p), property);

const ANSI = [
  "Black",
  "Red",
  "Green",
  "Yellow",
  "Blue",
  "Magenta",
  "Cyan",
  "White",
  "Bright black",
  "Bright red",
  "Bright green",
  "Bright yellow",
  "Bright blue",
  "Bright magenta",
  "Bright cyan",
  "Bright white",
] as const;

test.describe("opening the editor", () => {
  test("a theme that ships with the app says Customize, one of the person's own says Edit", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const screen = await openSettings(page);
    for (const theme of THEMES) {
      await expect(card(screen, theme.id).locator('[data-nr-action="edit"]')).toHaveText(
        "Customize",
      );
      await expect(
        screen.getByRole("button", { name: `Customize ${theme.name}`, exact: true }),
      ).toBeVisible();
    }
    await expect(card(screen, "mine").locator('[data-nr-action="edit"]')).toHaveText("Edit");
    await expect(screen.getByRole("button", { name: "Edit Mine", exact: true })).toBeVisible();
  });

  test("opens with the name selected and every box holding the value of the theme", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    await openEditor(page, "noren-dusk");
    await expect(box(page, "Name")).toBeFocused();
    await expect(box(page, "Name")).toHaveValue("Noren Dusk copy");
    expect(
      await box(page, "Name").evaluate((el: HTMLInputElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([0, "Noren Dusk copy".length]);
    const ui = NOREN_DUSK.ui;
    await expect(box(page, "Accent")).toHaveValue(ui.accent);
    await expect(box(page, "Background")).toHaveValue(ui.bg);
    await expect(box(page, "Text")).toHaveValue(ui.text);
    await expect(box(page, "Muted text")).toHaveValue(ui.muted);
    await expect(box(page, "Border")).toHaveValue(ui.border);
    await expect(box(page, "Sidebar and panel color")).toHaveValue(ui.surface);
    const term = NOREN_DUSK.terminal;
    await expect(box(page, "Terminal background")).toHaveValue(term.background);
    await expect(box(page, "Terminal text")).toHaveValue(term.foreground);
    await expect(box(page, "Cursor")).toHaveValue(term.cursor);
    await expect(box(page, "Selection")).toHaveValue(term.selection);
    for (const [index, name] of ANSI.entries()) {
      await expect(box(page, name)).toHaveValue(term.ansi[index] as string);
    }
    await expect(box(page, "Font names")).toHaveValue(NOREN_DUSK.font.family);
    await expect(box(page, "Size (px)")).toHaveValue(String(NOREN_DUSK.font.size));
    await expect(box(page, "Line height")).toHaveValue(String(NOREN_DUSK.font.lineHeight));
    await expect(
      editor(page).getByRole("checkbox", { name: "Ligatures", exact: true }),
    ).toBeChecked();
    await expect(box(page, "Corner radius (px)")).toHaveValue(String(ui.radius));
    await expect(box(page, "Panel opacity")).toHaveValue(String(ui.opacity));
    await expect(box(page, "Panel blur (px)")).toHaveValue(String(ui.blur));
    await expect(box(page, "Picture path")).toHaveValue("");
    await expect(box(page, "Picture opacity")).toHaveValue("0.6");
    await expect(box(page, "Picture blur (px)")).toHaveValue("");
    await expect(editor(page).getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  });

  test("opens a theme of the person under its own name, with its own picture", async ({ page }) => {
    await start(page, { themes: [MINE] });
    await openEditor(page, "mine");
    await expect(box(page, "Name")).toHaveValue("Mine");
    await expect(box(page, "Picture path")).toHaveValue(PICTURE);
    await expect(box(page, "Picture opacity")).toHaveValue("0.4");
    await expect(box(page, "Picture blur (px)")).toHaveValue("5");
    await expect(box(page, "Font names")).toHaveValue("Fira Code");
    await expect(preview(page)).toHaveAttribute("data-nr-picture", "shown");
    // "Edit" saves over the theme, "Customize" saves a new one.
    await expect(
      editor(page).getByRole("button", { name: "Save changes", exact: true }),
    ).toBeVisible();
    await expect(
      editor(page).getByRole("button", { name: "Save as a new theme", exact: true }),
    ).toBeVisible();
  });

  test("a theme that ships with the app can only be saved as a new one of the person's own", async ({
    page,
  }) => {
    await start(page);
    await openEditor(page, "noren-paper");
    await expect(
      editor(page).getByRole("button", { name: "Save as my theme", exact: true }),
    ).toBeVisible();
    await expect(
      editor(page).getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    await expect(
      editor(page).getByRole("button", { name: "Save as a new theme", exact: true }),
    ).toHaveCount(0);
  });

  test("shows the nine groups of a theme, each with its heading", async ({ page }) => {
    await start(page);
    await openEditor(page, "noren-dusk");
    const legends = await editor(page)
      .locator("fieldset.theme-editor-group > legend")
      .allTextContents();
    expect(legends).toEqual([
      "Name and kind",
      "Accent color",
      "Background and text",
      "Sidebar and panels",
      "Terminal",
      "Font",
      "Corners",
      "Transparency",
      "Background picture",
    ]);
    await expect(preview(page)).toBeVisible();
  });

  test("Escape and Cancel close only the editor, leave the settings open and give the focus back to the card", async ({
    page,
  }) => {
    await start(page);
    const screen = await openEditor(page, "noren-dusk");
    await page.keyboard.press("Escape");
    await expect(editor(page)).toHaveCount(0);
    await expect(screen).toBeVisible();
    await expect(
      screen.getByRole("button", { name: "Customize Noren Dusk", exact: true }),
    ).toBeFocused();
    await screen.getByRole("button", { name: "Customize Noren Paper", exact: true }).click();
    await editor(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(screen).toBeVisible();
    await expect(
      screen.getByRole("button", { name: "Customize Noren Paper", exact: true }),
    ).toBeFocused();
  });
});

test.describe("the preview follows every group at once", () => {
  test.beforeEach(async ({ page }) => {
    await start(page, { config: DUSK });
    await openEditor(page, "noren-dusk");
  });

  test("starts as the theme: its colors, font, corners and sixteen colors", async ({ page }) => {
    expect(await previewVar(page, "--tp-accent")).toBe(NOREN_DUSK.ui.accent);
    expect(await previewVar(page, "--tp-bg")).toBe(NOREN_DUSK.ui.bg);
    expect(await previewVar(page, "--tp-term-fg")).toBe(NOREN_DUSK.terminal.foreground);
    expect(await previewVar(page, "--tp-radius")).toBe(`${NOREN_DUSK.ui.radius}px`);
    expect(await previewVar(page, "--tp-font-size")).toBe(`${NOREN_DUSK.font.size}px`);
    for (const [index, color] of NOREN_DUSK.terminal.ansi.entries()) {
      expect(await previewVar(page, `--tp-ansi-${index}`)).toBe(color);
    }
    await expect(preview(page).locator(".tp-swatch")).toHaveCount(16);
    await expect(preview(page)).toHaveAttribute("data-nr-picture", "none");
  });

  test("accent: the hex box and the swatch both change the accent of the preview", async ({
    page,
  }) => {
    await box(page, "Accent").fill("#ff0000");
    expect(await previewVar(page, "--tp-accent")).toBe("#ff0000");
    expect(await previewStyle(page, ".tp-dot", "background-color")).toBe("rgb(255, 0, 0)");
    await editor(page).getByLabel("Accent, color picker", { exact: true }).fill("#00ff00");
    expect(await previewVar(page, "--tp-accent")).toBe("#00ff00");
    await expect(box(page, "Accent")).toHaveValue("#00ff00");
    expect(await previewStyle(page, ".tp-dot", "background-color")).toBe("rgb(0, 255, 0)");
  });

  test("background and text: background, text, muted text and border", async ({ page }) => {
    await box(page, "Background").fill("#112233");
    await box(page, "Text").fill("#fafafa");
    await box(page, "Muted text").fill("#aabbcc");
    await box(page, "Border").fill("#445566");
    expect(await previewVar(page, "--tp-bg")).toBe("#112233");
    expect(await previewVar(page, "--tp-text")).toBe("#fafafa");
    expect(await previewVar(page, "--tp-muted")).toBe("#aabbcc");
    expect(await previewVar(page, "--tp-border")).toBe("#445566");
    expect(await previewStyle(page, ".tp-title", "color")).toBe("rgb(170, 187, 204)");
    expect(await previewStyle(page, ".tp-tab-on", "color")).toBe("rgb(250, 250, 250)");
    expect(await previewStyle(page, ".tp-window", "border-top-color")).toBe("rgb(68, 85, 102)");
  });

  test("sidebar and panels: the color of the sidebar changes", async ({ page }) => {
    await box(page, "Sidebar and panel color").fill("#334455");
    expect(await previewVar(page, "--tp-surface")).toBe("#334455");
    // The sidebar is the surface at the opacity of the theme.
    expect(await previewStyle(page, ".tp-side", "background-color")).toContain("rgba(51, 68, 85");
  });

  test("terminal: background, text, cursor and selection (which keeps its alpha)", async ({
    page,
  }) => {
    await box(page, "Terminal background").fill("#001122");
    await box(page, "Terminal text").fill("#eeeeee");
    await box(page, "Cursor").fill("#ff00ff");
    await box(page, "Selection").fill("#ffaa0080");
    expect(await previewStyle(page, ".tp-terminal", "background-color")).toBe("rgb(0, 17, 34)");
    expect(await previewStyle(page, ".tp-terminal", "color")).toBe("rgb(238, 238, 238)");
    expect(await previewStyle(page, ".tp-cursor", "background-color")).toBe("rgb(255, 0, 255)");
    expect(await previewStyle(page, ".tp-selection", "background-color")).toBe(
      "rgba(255, 170, 0, 0.5)",
    );
    // The swatch of the selection keeps the alpha when it changes the color.
    await editor(page).getByLabel("Selection, color picker", { exact: true }).fill("#00ff00");
    await expect(box(page, "Selection")).toHaveValue("#00ff0080");
  });

  test("the sixteen colors: each box changes its own color of the palette and no other", async ({
    page,
  }) => {
    for (const [index, name] of ANSI.entries()) {
      const color = `#${(0x101010 + index * 0x0f0f0f).toString(16).padStart(6, "0")}`;
      await box(page, name).fill(color);
      expect(await previewVar(page, `--tp-ansi-${index}`), name).toBe(color);
      await expect(preview(page).locator(".tp-swatch").nth(index)).toHaveCSS(
        "background-color",
        `rgb(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5, 7), 16)})`,
      );
    }
    // The sample lines use them too: red is the color of "modified:".
    expect(await previewStyle(page, ".tp-line:nth-child(3) span", "color")).toBe(
      `rgb(${0x10 + 0x0f}, ${0x10 + 0x0f}, ${0x10 + 0x0f})`,
    );
  });

  test("font: names, size, line height and ligatures", async ({ page }) => {
    await box(page, "Font names").fill("Fira Code, Consolas, monospace");
    await box(page, "Size (px)").fill("20");
    await box(page, "Line height").fill("1.5");
    await editor(page).getByRole("checkbox", { name: "Ligatures", exact: true }).uncheck();
    expect(await previewStyle(page, ".tp-terminal", "font-family")).toContain("Fira Code");
    expect(await previewStyle(page, ".tp-terminal", "font-size")).toBe("20px");
    expect(await previewStyle(page, ".tp-terminal", "line-height")).toBe("30px");
    expect(await previewStyle(page, ".tp-terminal", "font-variant-ligatures")).toBe("none");
    await editor(page).getByRole("checkbox", { name: "Ligatures", exact: true }).check();
    expect(await previewStyle(page, ".tp-terminal", "font-variant-ligatures")).toBe("normal");
    // The slider of the size moves the same number.
    await editor(page).getByRole("slider", { name: "Size (px), slider", exact: true }).fill("30");
    await expect(box(page, "Size (px)")).toHaveValue("30");
    expect(await previewStyle(page, ".tp-terminal", "font-size")).toBe("30px");
    await expect(group(page, "font")).toContainText(
      "the terminal takes its font from the Terminal section",
    );
  });

  test("corners: the radius of the window of the preview", async ({ page }) => {
    await box(page, "Corner radius (px)").fill("0");
    expect(await previewStyle(page, ".tp-window", "border-top-left-radius")).toBe("0px");
    await editor(page)
      .getByRole("slider", { name: "Corner radius (px), slider", exact: true })
      .fill("24");
    await expect(box(page, "Corner radius (px)")).toHaveValue("24");
    expect(await previewStyle(page, ".tp-window", "border-top-left-radius")).toBe("24px");
  });

  test("transparency: the opacity and the blur of the panels", async ({ page }) => {
    await box(page, "Panel opacity").fill("0.5");
    expect(await previewStyle(page, ".tp-window", "background-color")).toBe(
      "rgba(20, 22, 27, 0.5)",
    );
    await box(page, "Panel blur (px)").fill("30");
    expect(await previewStyle(page, ".tp-side", "backdrop-filter")).toBe("blur(30px)");
    await editor(page)
      .getByRole("slider", { name: "Panel opacity, slider", exact: true })
      .fill("1");
    expect(await previewStyle(page, ".tp-window", "background-color")).toBe("rgb(20, 22, 27)");
  });

  test("kind: dark or light", async ({ page }) => {
    await editor(page).getByRole("radio", { name: "Light", exact: true }).check();
    await expect(editor(page).getByRole("radio", { name: "Light", exact: true })).toBeChecked();
    await expect(editor(page).getByRole("radio", { name: "Dark", exact: true })).not.toBeChecked();
  });

  test("background picture: chosen with the file chooser, with its opacity and blur, and removed", async ({
    page,
  }) => {
    await page.evaluate((p) => (window as HookWindow).__norenTest?.setImagePick(p), PICTURE);
    await editor(page).getByRole("button", { name: "Choose image…", exact: true }).click();
    await expect(box(page, "Picture path")).toHaveValue(PICTURE);
    await expect(preview(page)).toHaveAttribute("data-nr-picture", "shown");
    await expect(preview(page).locator(".tp-picture")).toHaveCount(1);
    await expect(preview(page).locator(".tp-veil")).toHaveCount(1);
    expect(await previewStyle(page, ".tp-picture", "background-image")).toContain("blob:");
    expect(await previewStyle(page, ".tp-picture", "opacity")).toBe("0.6");
    // With a picture the panels let it through the way the window does (55%), whatever ui.opacity says.
    expect(await previewStyle(page, ".tp-side", "background-color")).toContain("0.55");
    await box(page, "Picture opacity").fill("0.2");
    await box(page, "Picture blur (px)").fill("8");
    expect(await previewStyle(page, ".tp-picture", "opacity")).toBe("0.2");
    expect(await previewStyle(page, ".tp-picture", "filter")).toBe("blur(8px)");
    await editor(page)
      .getByRole("slider", { name: "Picture blur (px), slider", exact: true })
      .fill("20");
    await expect(box(page, "Picture blur (px)")).toHaveValue("20");
    await editor(page).getByRole("button", { name: "Remove", exact: true }).click();
    await expect(box(page, "Picture path")).toHaveValue("");
    await expect(preview(page)).toHaveAttribute("data-nr-picture", "none");
    await expect(preview(page).locator(".tp-picture")).toHaveCount(0);
  });

  test("a picture typed by hand shows too, and one that is not there says why", async ({
    page,
  }) => {
    await box(page, "Picture path").fill(PICTURE);
    await expect(preview(page)).toHaveAttribute("data-nr-picture", "shown");
    await box(page, "Picture path").fill("backgrounds/missing.png");
    await expect(
      editor(page).locator('[data-nr-part="background-thumbnail-failure"]'),
    ).toBeVisible();
    await expect(preview(page)).toHaveAttribute("data-nr-picture", "none");
  });

  test("the window behind keeps the colors of the theme in force, whatever is edited", async ({
    page,
  }) => {
    const before = await rootVar(page, "--nr-accent");
    await box(page, "Accent").fill("#ff0000");
    await box(page, "Background").fill("#ff0000");
    await box(page, "Text").fill("#ff0000");
    expect(await rootVar(page, "--nr-accent")).toBe(before);
    expect(await rootVar(page, "--nr-bg")).toBe(NOREN_DUSK.ui.bg);
    // The editor itself stays readable: its text is not the color just typed.
    await expect(editor(page)).toHaveCSS("color", "rgb(230, 230, 230)");
  });
});

test.describe("what is typed that is not valid", () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
    await openEditor(page, "noren-dusk");
  });

  test("a color that is not one says so, keeps the preview as it was and holds Save back", async ({
    page,
  }) => {
    const save = editor(page).getByRole("button", { name: "Save as my theme", exact: true });
    await expect(save).toBeEnabled();
    await box(page, "Accent").fill("#e07a5");
    await expect(
      editor(page).getByText("Use a color like #1a2b3c.", { exact: true }),
    ).toBeVisible();
    await expect(box(page, "Accent")).toHaveAttribute("aria-invalid", "true");
    expect(await previewVar(page, "--tp-accent")).toBe(NOREN_DUSK.ui.accent);
    await expect(save).toBeDisabled();
    await expect(editor(page).locator('[data-nr-part="theme-editor-fix"]')).toHaveText(
      "Fix the boxes that say what is wrong before saving.",
    );
    // Typed to the end, it is a color again: the preview takes it, the box is clean and Save is back.
    await box(page, "Accent").fill("#e07a5f");
    await expect(box(page, "Accent")).not.toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeEnabled();
    await expect(editor(page).locator('[data-nr-part="theme-editor-fix"]')).toHaveCount(0);
    // #rgb is a color; the box shows #rrggbb once it is left.
    await box(page, "Accent").fill("#f80");
    expect(await previewVar(page, "--tp-accent")).toBe("#ff8800");
    await box(page, "Accent").blur();
    await expect(box(page, "Accent")).toHaveValue("#ff8800");
  });

  test("an alpha is for the selection alone", async ({ page }) => {
    await box(page, "Cursor").fill("#ff000080");
    await expect(
      editor(page).getByText("Use a color like #1a2b3c.", { exact: true }),
    ).toBeVisible();
    await box(page, "Selection").fill("#zzz");
    await expect(
      editor(page).getByText("Use a color like #1a2b3c, or #1a2b3c80 with its opacity.", {
        exact: true,
      }),
    ).toBeVisible();
  });

  test("a number outside its range or that is not a number says which range", async ({ page }) => {
    await box(page, "Corner radius (px)").fill("99");
    await expect(
      editor(page).getByText("Enter a number from 0 to 32.", { exact: true }),
    ).toBeVisible();
    expect(await previewVar(page, "--tp-radius")).toBe("10px");
    await box(page, "Corner radius (px)").fill("abc");
    await expect(editor(page).getByText("Enter a number.", { exact: true })).toBeVisible();
    await box(page, "Line height").fill("5");
    await expect(
      editor(page).getByText("Enter a number from 0.8 to 3.", { exact: true }),
    ).toBeVisible();
    await box(page, "Panel opacity").fill("1.5");
    await expect(
      editor(page).getByText("Enter a number from 0 to 1.", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      editor(page).getByRole("button", { name: "Save as my theme", exact: true }),
    ).toBeDisabled();
    await box(page, "Corner radius (px)").fill("8");
    await box(page, "Line height").fill("1,4");
    await box(page, "Panel opacity").fill("0.8");
    await expect(
      editor(page).getByRole("button", { name: "Save as my theme", exact: true }),
    ).toBeEnabled();
    expect(await previewVar(page, "--tp-line-height")).toBe("1.4");
  });

  test("a font list cannot be empty, and a picture path must be one the app can show", async ({
    page,
  }) => {
    await box(page, "Font names").fill("  ");
    await expect(
      editor(page).getByText("Enter at least one font name.", { exact: true }),
    ).toBeVisible();
    await box(page, "Font names").fill("Consolas");
    await box(page, "Picture path").fill("https://example.com/a.png");
    await expect(editor(page).locator('[role="alert"]').first()).toBeVisible();
    await expect(box(page, "Picture path")).toHaveAttribute("aria-invalid", "true");
    await expect(
      editor(page).getByRole("button", { name: "Save as my theme", exact: true }),
    ).toBeDisabled();
    await box(page, "Picture path").fill("");
    await expect(
      editor(page).getByRole("button", { name: "Save as my theme", exact: true }),
    ).toBeEnabled();
  });

  test("a name that is empty or too long is refused before anything is saved", async ({ page }) => {
    const save = editor(page).getByRole("button", { name: "Save as my theme", exact: true });
    await box(page, "Name").fill("   ");
    await expect(editor(page).getByText("A theme needs a name.", { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    await box(page, "Name").fill("x".repeat(61));
    await expect(
      editor(page).getByText("A name has at most 60 characters.", { exact: true }),
    ).toBeVisible();
    await expect(save).toBeDisabled();
    await box(page, "Name").fill("x".repeat(60));
    await expect(save).toBeEnabled();
  });

  test("warns, without blocking, about colors that are hard to read", async ({ page }) => {
    const notes = editor(page).locator('[data-nr-part="theme-editor-notes"]');
    await expect(notes.locator("p")).toHaveCount(0);
    await box(page, "Text").fill(NOREN_DUSK.ui.bg);
    await expect(notes.locator('[data-nr-note="text"]')).toHaveText(
      "The text on the background reads at 1:1; 4.5:1 or more is easier to read.",
    );
    await expect(notes.locator('[data-nr-note="sidebar"]')).toBeVisible();
    await box(page, "Terminal text").fill(NOREN_DUSK.terminal.background);
    await expect(notes.locator('[data-nr-note="terminal"]')).toBeVisible();
    await box(page, "Muted text").fill(NOREN_DUSK.ui.bg);
    await expect(notes.locator('[data-nr-note="muted"]')).toBeVisible();
    await box(page, "Accent").fill(NOREN_DUSK.ui.bg);
    await expect(notes.locator('[data-nr-note="accent"]')).toBeVisible();
    await expect(
      editor(page).getByRole("button", { name: "Save as my theme", exact: true }),
    ).toBeEnabled();
    await box(page, "Text").fill(NOREN_DUSK.ui.text);
    await box(page, "Terminal text").fill(NOREN_DUSK.terminal.foreground);
    await box(page, "Muted text").fill(NOREN_DUSK.ui.muted);
    await box(page, "Accent").fill(NOREN_DUSK.ui.accent);
    await expect(notes.locator("p")).toHaveCount(0);
  });
});

test.describe("nothing is written until Save, and Cancel throws the changes away", () => {
  test("editing every group writes no file, changes no card and leaves the window as it was", async ({
    page,
  }) => {
    await start(page, { themes: [MINE], config: '{ "appearance": { "theme": "mine" } }' });
    const filesBefore = await themeFiles(page);
    const accentBefore = await rootVar(page, "--nr-accent");
    const screen = await openEditor(page, "mine");
    await box(page, "Name").fill("Renamed in the editor");
    await box(page, "Accent").fill("#ff0000");
    await box(page, "Background").fill("#000000");
    await box(page, "Terminal background").fill("#111111");
    await box(page, "Red").fill("#ff1111");
    await box(page, "Font names").fill("Consolas");
    await box(page, "Size (px)").fill("22");
    await box(page, "Corner radius (px)").fill("0");
    await box(page, "Panel opacity").fill("0.4");
    await box(page, "Picture path").fill("");
    expect(await previewVar(page, "--tp-accent")).toBe("#ff0000");
    expect(await themeFiles(page)).toEqual(filesBefore);
    expect(await rootVar(page, "--nr-accent")).toBe(accentBefore);
    await editor(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(await themeFiles(page)).toEqual(filesBefore);
    expect(await rootVar(page, "--nr-accent")).toBe(accentBefore);
    await expect(screen.locator('[data-nr-part="theme-card"] .theme-name')).toHaveText([
      ...THEMES.map((theme) => theme.name),
      "Mine",
    ]);
    // Opened again, the editor starts from the theme as it is saved, not from what was thrown away.
    await card(screen, "mine").locator('[data-nr-action="edit"]').click();
    await expect(box(page, "Name")).toHaveValue("Mine");
    await expect(box(page, "Accent")).toHaveValue(MINE.ui.accent);
    await expect(box(page, "Font names")).toHaveValue("Fira Code");
    await expect(box(page, "Picture path")).toHaveValue(PICTURE);
    expect(await themeFiles(page)).toEqual(filesBefore);
  });

  test("closing the settings screen with Cancel or Escape after the editor was dismissed changes nothing either", async ({
    page,
  }) => {
    await start(page);
    const filesBefore = await themeFiles(page);
    await openEditor(page, "noren-paper");
    await box(page, "Accent").fill("#00ff00");
    await page.keyboard.press("Escape");
    await expect(editor(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toHaveCount(0);
    expect(await themeFiles(page)).toEqual(filesBefore);
  });
});

test.describe("saving", () => {
  test("a theme that ships with the app is saved as a new one of the person's own, named and numbered like a copy", async ({
    page,
  }) => {
    await start(page);
    const screen = await openEditor(page, "noren-dusk");
    await box(page, "Name").fill("My Dusk");
    await box(page, "Accent").fill("#00aaff");
    await box(page, "Corner radius (px)").fill("2");
    await editor(page).getByRole("button", { name: "Save as my theme", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(status(screen)).toHaveText("Saved “My Dusk” as one of your themes.");
    const files = await themeFiles(page);
    expect(Object.keys(files)).toEqual(["my-dusk"]);
    const saved = parseTheme(JSON.parse(files["my-dusk"] as string));
    if (!saved.ok) throw new Error(saved.errors.join("; "));
    // Everything but the edits and the identity is the theme it came from.
    expect(saved.theme).toEqual({
      ...NOREN_DUSK,
      id: "my-dusk",
      name: "My Dusk",
      ui: { ...NOREN_DUSK.ui, accent: "#00aaff", radius: 2 },
    });
    await expect(card(screen, "my-dusk")).toHaveAttribute("data-nr-origin", "user");
    await expect(card(screen, "my-dusk")).toContainText("Dark · Yours");
    await expect(screen.getByRole("button", { name: "My Dusk", exact: true })).toBeFocused();
    // It is a theme like any other: it can be used for the whole app at once.
    await screen.getByRole("button", { name: "My Dusk", exact: true }).click();
    await expect.poll(() => rootVar(page, "--nr-accent")).toBe("#00aaff");
    // A second theme saved under the same name does not replace it.
    await card(screen, "noren-dusk").locator('[data-nr-action="edit"]').click();
    await box(page, "Name").fill("My Dusk");
    await editor(page).getByRole("button", { name: "Save as my theme", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(Object.keys(await themeFiles(page)).sort()).toEqual(["my-dusk", "my-dusk-2"]);
    await expect(status(screen)).toHaveText("Saved “My Dusk (2)” as one of your themes.");
    expect(JSON.parse((await themeFiles(page))["my-dusk"] as string).ui.accent).toBe("#00aaff");
  });

  test("a new theme from the default name is called the copy of its source", async ({ page }) => {
    await start(page);
    const screen = await openEditor(page, "noren-paper");
    await editor(page).getByRole("button", { name: "Save as my theme", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(Object.keys(await themeFiles(page))).toEqual(["noren-paper-copy"]);
    await expect(card(screen, "noren-paper-copy")).toContainText("Light · Yours");
  });

  test("every group lands in the file, and the file is a theme the schema accepts", async ({
    page,
  }) => {
    await start(page);
    await openEditor(page, "noren-paper");
    await box(page, "Name").fill("Everything");
    await editor(page).getByRole("radio", { name: "Dark", exact: true }).check();
    await box(page, "Accent").fill("#ff8800");
    await box(page, "Background").fill("#101820");
    await box(page, "Text").fill("#f0f0f0");
    await box(page, "Muted text").fill("#a0a8b0");
    await box(page, "Border").fill("#2a3440");
    await box(page, "Sidebar and panel color").fill("#18222c");
    await box(page, "Terminal background").fill("#0b1218");
    await box(page, "Terminal text").fill("#e8e8e8");
    await box(page, "Cursor").fill("#ffcc00");
    await box(page, "Selection").fill("#ffcc0066");
    for (const [index, name] of ANSI.entries()) {
      await box(page, name).fill(`#${(0x202020 + index * 0x0a0a0a).toString(16).padStart(6, "0")}`);
    }
    await box(page, "Font names").fill("Fira Code, Consolas, monospace");
    await box(page, "Size (px)").fill("17");
    await box(page, "Line height").fill("1.35");
    await editor(page).getByRole("checkbox", { name: "Ligatures", exact: true }).uncheck();
    await box(page, "Corner radius (px)").fill("0");
    await box(page, "Panel opacity").fill("0.5");
    await box(page, "Panel blur (px)").fill("40");
    await page.evaluate((p) => (window as HookWindow).__norenTest?.setImagePick(p), PICTURE);
    await editor(page).getByRole("button", { name: "Choose image…", exact: true }).click();
    await box(page, "Picture opacity").fill("0.25");
    await box(page, "Picture blur (px)").fill("12");
    await editor(page).getByRole("button", { name: "Save as my theme", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    const text = (await themeFiles(page))["everything"] as string;
    const parsed = parseTheme(JSON.parse(text));
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const theme = parsed.theme;
    expect(ThemeSchema.safeParse(theme).success).toBe(true);
    expect(theme.id).toBe("everything");
    expect(theme.kind).toBe("dark");
    expect(theme.ui).toEqual({
      bg: "#101820",
      surface: "#18222c",
      text: "#f0f0f0",
      muted: "#a0a8b0",
      accent: "#ff8800",
      border: "#2a3440",
      radius: 0,
      blur: 40,
      opacity: 0.5,
    });
    expect(theme.terminal.background).toBe("#0b1218");
    expect(theme.terminal.foreground).toBe("#e8e8e8");
    expect(theme.terminal.cursor).toBe("#ffcc00");
    expect(theme.terminal.selection).toBe("#ffcc0066");
    expect(theme.terminal.ansi).toHaveLength(16);
    expect(theme.terminal.ansi[0]).toBe("#202020");
    expect(theme.terminal.ansi[15]).toBe(
      `#${(0x202020 + 15 * 0x0a0a0a).toString(16).padStart(6, "0")}`,
    );
    expect(theme.font).toEqual({
      family: "Fira Code, Consolas, monospace",
      size: 17,
      lineHeight: 1.35,
      ligatures: false,
    });
    expect(theme.background).toEqual({ image: PICTURE, opacity: 0.25, blur: 12 });
    // Written the way every theme file is written, so the loader of the folder reads the same text.
    expect(text).toBe(serializeTheme(theme));
  });

  test("a theme saved in the editor survives a reload, and the importer reads back what Export writes", async ({
    page,
  }) => {
    await start(page);
    await openEditor(page, "noren-dusk");
    await box(page, "Name").fill("Round trip");
    await box(page, "Accent").fill("#12ab34");
    await box(page, "Size (px)").fill("19");
    await editor(page).getByRole("button", { name: "Save as my theme", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    const saved = (await themeFiles(page))["round-trip"] as string;
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
      .toBe(1);
    const again = await openSettings(page);
    await expect(card(again, "round-trip")).toHaveAttribute("data-nr-origin", "user");
    expect((await themeFiles(page))["round-trip"]).toBe(saved);
    // Export it, then import the exported file: it comes back whole under a new id.
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setThemeExportPick("C:\\out\\round-trip.json"),
    );
    await card(again, "round-trip").locator('[data-nr-action="export"]').click();
    await expect(status(again)).toContainText("Exported");
    const exportedText = (
      await page.evaluate(() => (window as HookWindow).__norenTest?.exportedThemes() ?? {})
    )["C:\\out\\round-trip.json"] as string;
    expect(exportedText).toBe(saved);
    const read = importColorSchemes(exportedText);
    expect(read.ok && read.themes[0]).toEqual(JSON.parse(saved));
    await again.locator('input[type="file"][data-nr-part="themes-file"]').setInputFiles({
      name: "round-trip.json",
      mimeType: "application/json",
      buffer: Buffer.from(exportedText),
    });
    await expect(card(again, "round-trip-2")).toHaveCount(1);
    const second = parseTheme(JSON.parse((await themeFiles(page))["round-trip-2"] as string));
    if (!second.ok) throw new Error(second.errors.join("; "));
    expect({ ...second.theme, id: "round-trip", name: "Round trip" }).toEqual(JSON.parse(saved));
  });

  test("Save changes keeps the id and the file of a theme of the person, and the window shows the new look at once", async ({
    page,
  }) => {
    await start(page, { themes: [MINE], config: '{ "appearance": { "theme": "mine" } }' });
    expect(await rootVar(page, "--nr-radius")).toBe("4px");
    const screen = await openEditor(page, "mine");
    await box(page, "Corner radius (px)").fill("16");
    await box(page, "Accent").fill("#abcdef");
    await box(page, "Font names").fill("Consolas, monospace");
    await editor(page).getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(status(screen)).toHaveText("Saved the changes to “Mine”.");
    const files = await themeFiles(page);
    expect(Object.keys(files)).toEqual(["mine"]);
    expect(JSON.parse(files["mine"] as string)).toEqual({
      ...MINE,
      ui: { ...MINE.ui, radius: 16, accent: "#abcdef" },
      font: { ...MINE.font, family: "Consolas, monospace" },
    });
    // The theme in force is the one that was edited: the window follows.
    await expect.poll(() => rootVar(page, "--nr-radius")).toBe("16px");
    await expect.poll(() => rootVar(page, "--nr-accent")).toBe("#abcdef");
    await expect(screen.getByRole("button", { name: "Edit Mine", exact: true })).toBeFocused();
    // Still one card for it, and still the one in use.
    await expect(screen.locator('[data-nr-part="theme-card"][data-nr-theme="mine"]')).toHaveCount(
      1,
    );
    await expect(card(screen, "mine")).toContainText("In use: whole app");
  });

  test("Save changes also renames the theme, and the id stays", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const screen = await openEditor(page, "mine");
    await box(page, "Name").fill("Mine, better");
    await editor(page).getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(JSON.parse((await themeFiles(page))["mine"] as string).name).toBe("Mine, better");
    await expect(card(screen, "mine").locator(".theme-name")).toHaveText("Mine, better");
  });

  test("Save as a new theme leaves the one of the person as it is", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const screen = await openEditor(page, "mine");
    await box(page, "Accent").fill("#abcdef");
    await box(page, "Name").fill("Mine variant");
    await editor(page).getByRole("button", { name: "Save as a new theme", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    const files = await themeFiles(page);
    expect(Object.keys(files).sort()).toEqual(["mine", "mine-variant"]);
    expect(JSON.parse(files["mine"] as string)).toEqual(MINE);
    expect(JSON.parse(files["mine-variant"] as string).ui.accent).toBe("#abcdef");
    await expect(status(screen)).toHaveText("Saved “Mine variant” as one of your themes.");
    await expect(card(screen, "mine-variant")).toHaveCount(1);
  });

  test("a disk that refuses the file keeps the editor open with the reason, and the next try works", async ({
    page,
  }) => {
    await start(page);
    const screen = await openEditor(page, "noren-dusk");
    await box(page, "Name").fill("Refused");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.failThemeSave("the disk is full"),
    );
    await editor(page).getByRole("button", { name: "Save as my theme", exact: true }).click();
    await expect(editor(page).locator('[data-nr-part="theme-editor-failure"]')).toHaveText(
      "Could not save “Refused”: the disk is full",
    );
    await expect(editor(page)).toBeVisible();
    expect(await themeFiles(page)).toEqual({});
    await expect(card(screen, "refused")).toHaveCount(0);
    // The failure is for one try: the same editor saves once the disk does.
    await page.evaluate(() => (window as HookWindow).__norenTest?.failThemeSave());
    await editor(page).getByRole("button", { name: "Save as my theme", exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    expect(Object.keys(await themeFiles(page))).toEqual(["refused"]);
  });

  test("a theme of the editor can be used for one space only, like any other", async ({ page }) => {
    await start(page);
    const screen = await openEditor(page, "noren-paper");
    await box(page, "Name").fill("Space paper");
    await box(page, "Accent").fill("#0000ff");
    await editor(page).getByRole("button", { name: "Save as my theme", exact: true }).click();
    await screen.getByRole("radio", { name: "Only the space “Main”", exact: true }).check();
    await screen.getByRole("button", { name: "Space paper", exact: true }).click();
    await expect(status(screen)).toContainText("Using “Space paper” only in the space “Main”.");
    await expect.poll(() => rootVar(page, "--nr-accent")).toBe("#0000ff");
  });
});

test.describe("in Portuguese", () => {
  const pt = '{ "language": "pt-BR", "appearance": { "theme": "noren-dusk" } }';

  test("the editor, its groups, its problems and what saving says are in Portuguese", async ({
    page,
  }) => {
    await start(page, { config: pt });
    const screen = await page
      .getByRole("button", { name: "Configurações", exact: true })
      .click()
      .then(() => page.getByRole("dialog", { name: "Configurações", exact: true }));
    await card(screen, "noren-dusk").scrollIntoViewIfNeeded();
    await screen.getByRole("button", { name: "Personalizar Noren Dusk", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Editor de tema", exact: true });
    await expect(dialog).toBeVisible();
    const legends = await dialog.locator("fieldset.theme-editor-group > legend").allTextContents();
    expect(legends).toEqual([
      "Nome e tipo",
      "Cor de destaque",
      "Fundo e texto",
      "Lateral e painéis",
      "Terminal",
      "Fonte",
      "Cantos",
      "Transparência",
      "Imagem de fundo",
    ]);
    await expect(dialog.getByRole("textbox", { name: "Nome", exact: true })).toHaveValue(
      "Noren Dusk (cópia)",
    );
    await expect(
      dialog.getByRole("textbox", { name: "Vermelho brilhante", exact: true }),
    ).toBeVisible();
    await dialog.getByRole("textbox", { name: "Destaque", exact: true }).fill("#12");
    await expect(dialog.getByText("Use uma cor como #1a2b3c.", { exact: true })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Raio dos cantos (px)", exact: true }).fill("99");
    await expect(dialog.getByText("Digite um número de 0 a 32.", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("Corrija as caixas que dizem o que está errado antes de salvar."),
    ).toBeVisible();
    await dialog.getByRole("textbox", { name: "Destaque", exact: true }).fill("#12ab34");
    await dialog.getByRole("textbox", { name: "Raio dos cantos (px)", exact: true }).fill("6");
    await dialog.getByRole("textbox", { name: "Texto", exact: true }).fill(NOREN_DUSK.ui.bg);
    await expect(dialog.locator('[data-nr-note="text"]')).toHaveText(
      "O texto sobre o fundo fica em 1:1; 4.5:1 ou mais é mais fácil de ler.",
    );
    await dialog.getByRole("textbox", { name: "Texto", exact: true }).fill(NOREN_DUSK.ui.text);
    await dialog.getByRole("button", { name: "Salvar como meu tema", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(status(screen)).toHaveText("Salvo “Noren Dusk (cópia)” como um dos seus temas.");
    await expect(
      screen.getByRole("button", { name: "Editar Noren Dusk (cópia)", exact: true }),
    ).toBeVisible();
  });
});

test.describe("layout", () => {
  for (const [label, width, height] of [
    ["a 1280 by 720 window", 1280, 720],
    ["a small window", 820, 560],
  ] as const) {
    test(`in ${label} the editor fits, the buttons are in sight and nothing sticks out`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await start(page, { themes: [MINE] });
      await openEditor(page, "mine");
      const dialog = editor(page);
      const rect = await dialog.boundingBox();
      expect(rect).not.toBeNull();
      if (rect === null) return;
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(height);
      // The buttons never scroll out of sight.
      for (const name of ["Cancel", "Save changes", "Save as a new theme"]) {
        const button = dialog.getByRole("button", { name, exact: true });
        await expect(button).toBeInViewport({ ratio: 1 });
      }
      // The preview is in sight at the top, and no box makes the controls scroll sideways.
      await expect(preview(page)).toBeVisible();
      const overflow = await dialog.locator(".theme-editor-controls").evaluate((element) => ({
        wide: element.scrollWidth - element.clientWidth,
      }));
      expect(overflow.wide).toBeLessThanOrEqual(1);
      // The groups come one under the other and none overlaps the next.
      const tops = await dialog
        .locator(".theme-editor-controls > fieldset")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return [box.top, box.bottom];
          }),
        );
      for (let at = 1; at < tops.length; at++) {
        expect((tops[at] as number[])[0]).toBeGreaterThanOrEqual(
          (tops[at - 1] as number[])[1] as number,
        );
      }
    });
  }

  test("the palette is a grid of eight rows, the normal color and the bright one side by side", async ({
    page,
  }) => {
    await start(page);
    await openEditor(page, "noren-dusk");
    const rows = await editor(page)
      .locator(".theme-palette-row")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const cells = [...element.querySelectorAll<HTMLElement>(".theme-color")];
          return cells.map((cell) => Math.round(cell.getBoundingClientRect().top));
        }),
      );
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row).toHaveLength(2);
      expect(Math.abs((row[0] as number) - (row[1] as number))).toBeLessThanOrEqual(2);
    }
  });
});

test.describe("keyboard", () => {
  test("the whole editor can be reached and used with the keyboard", async ({ page }) => {
    await start(page);
    await openEditor(page, "noren-dusk");
    await expect(box(page, "Name")).toBeFocused();
    await page.keyboard.type("Typed");
    await expect(box(page, "Name")).toHaveValue("Typed");
    await box(page, "Accent").focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("#112233");
    expect(await previewVar(page, "--tp-accent")).toBe("#112233");
    // Tab goes on to the next box (the one of the color of the background, past its swatch).
    await page.keyboard.press("Tab");
    await expect(
      editor(page).getByLabel("Background, color picker", { exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(box(page, "Background")).toBeFocused();
    await editor(page).getByRole("button", { name: "Save as my theme", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(editor(page)).toHaveCount(0);
    expect(Object.keys(await themeFiles(page))).toEqual(["typed"]);
  });
});

test.describe("accessibility", () => {
  for (const [label, theme] of [
    ["dark", "noren-dusk"],
    ["light", "noren-paper"],
  ] as const) {
    test(`axe: the editor of a theme that ships with the app, in the ${label} theme, has no violation`, async ({
      page,
    }) => {
      await start(page, { config: `{ "appearance": { "theme": "${theme}" } }` });
      await openEditor(page, theme);
      await expectNoAxeViolations(page, `theme editor (${label})`);
    });

    test(`axe: the editor of a theme of the person with a picture, in the ${label} theme`, async ({
      page,
    }) => {
      await start(page, { themes: [MINE], config: `{ "appearance": { "theme": "${theme}" } }` });
      await openEditor(page, "mine");
      await expect(preview(page)).toHaveAttribute("data-nr-picture", "shown");
      await expectNoAxeViolations(page, `theme editor with a picture (${label})`);
    });

    test(`axe: the editor with problems and with notes about contrast, in the ${label} theme`, async ({
      page,
    }) => {
      await start(page, { config: `{ "appearance": { "theme": "${theme}" } }` });
      await openEditor(page, theme);
      await box(page, "Accent").fill("#12");
      await box(page, "Corner radius (px)").fill("99");
      await box(page, "Text").fill(theme === "noren-dusk" ? NOREN_DUSK.ui.bg : NOREN_PAPER.ui.bg);
      await box(page, "Name").fill("");
      await expect(editor(page).locator('[data-nr-note="text"]')).toBeVisible();
      await expectNoAxeViolations(page, `theme editor with problems (${label})`);
    });
  }

  test("axe: the editor in Portuguese", async ({ page }) => {
    await start(page, {
      config: '{ "language": "pt-BR", "appearance": { "theme": "noren-paper" } }',
    });
    await page.getByRole("button", { name: "Configurações", exact: true }).click();
    const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
    await card(screen, "noren-paper").scrollIntoViewIfNeeded();
    await screen.getByRole("button", { name: "Personalizar Noren Paper", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Editor de tema", exact: true })).toBeVisible();
    await expectNoAxeViolations(page, "theme editor (pt-BR)");
  });

  test("the editor is a modal dialog named for what it is, and the preview is left out of what a screen reader reads", async ({
    page,
  }) => {
    await start(page);
    await openEditor(page, "noren-dusk");
    await expect(editor(page)).toHaveAttribute("aria-modal", "true");
    await expect(preview(page)).toHaveAttribute("aria-hidden", "true");
    // The heading above it names it for whoever sees it.
    await expect(editor(page).getByRole("heading", { name: "Preview", exact: true })).toBeVisible();
  });
});
