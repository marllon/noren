import { readFileSync } from "node:fs";
import { expect, newServedContext, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { NOREN_DUSK, NOREN_PAPER } from "../packages/model/src/builtin-themes";
import { contrastRatio } from "../packages/model/src/theme";
import type { Theme } from "../packages/model/src/theme";
import { serializeTheme } from "../packages/model/src/user-themes";
import { expectNoAxeViolations } from "./axe-fixture";
import { readPixels } from "./png-pixels";
import { seedConfig } from "./settings-fixture";

// The theme editor of the dense style (NOR-F20-21c), as in the approved design
// (`denso-editor-de-tema`): a page of the window under its title bar with a header of 32 px (the title,
// the name of the theme as a crumb with a mark while something is unsaved, and the buttons, the one that
// saves filled with the highlight), the preview on the left with the readings of the contrast and the
// sixteen colors under it as a table, a column of 320 px on the right with a heading of 28 px over rows of
// a label in a column of 130 px and a control (a color is a swatch of 16 px and a box of 22 px, a number
// with a range is a slider and its number, the kind is two buttons in one frame, the ligatures a switch
// of 36 by 18), and a strip of 24 px at the foot with how many changes are unsaved. What the editor edits,
// what the preview draws and what Save writes are what they were (e2e/theme-editor.spec.ts runs under
// the glass style; here one flow is run under both and the files compared). The glass editor does not
// change, and a test says so. Everything runs on the `FakeBackend` of web mode.

interface Hook {
  paneIds(): string[];
  setImagePick(path: string | null): void;
  themeFiles(): Record<string, string>;
  failThemeSave(message?: string): void;
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

type Mode = "dark" | "light";
type Language = "en" | "pt-BR";

const THEME: Record<Mode, string> = { dark: "noren-dusk", light: "noren-paper" };
const WEB_THEMES_KEY = "noren.web.themes";
const WEB_IMAGES_KEY = "noren.web.images";
const FIXTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));
const PICTURE = "fixtures/background.png";

/** One of the person's own themes, with a picture and a value of its own in the groups the tests look at. */
const MINE: Theme = {
  ...NOREN_DUSK,
  id: "mine",
  name: "Mine",
  ui: { ...NOREN_DUSK.ui, bg: "#102a43", surface: "#16384f", accent: "#10b981", radius: 4 },
  terminal: { ...NOREN_DUSK.terminal, background: "#0d2236", cursor: "#10b981" },
  font: { family: "Fira Code", size: 15, lineHeight: 1.3, ligatures: false },
  background: { image: PICTURE, opacity: 0.4, blur: 5 },
};

/** What the editor says in each language, for the names the tests look for. */
const WORDS = {
  en: {
    settings: "Settings",
    title: "Theme editor",
    name: "Name",
    cancel: "Cancel",
    save: "Save as my theme",
    saveChanges: "Save changes",
    saveCopy: "Save as a new theme",
    accent: "Accent",
    text: "Text",
    background: "Background",
    radius: "Corner radius (px)",
    ligatures: "Ligatures",
    dark: "Dark",
    light: "Light",
    preview: "Preview",
    contrast: (ratio: string) => `Text contrast ${ratio} : 1`,
    muted: (ratio: string) => `Muted text contrast ${ratio} : 1`,
    footer: "Theme",
    none: "No changes",
    one: "1 unsaved change",
    many: (count: number) => `${count} unsaved changes`,
    unsaved: "unsaved",
    palette: "The 16 colors",
  },
  "pt-BR": {
    settings: "Configurações",
    title: "Editor de tema",
    name: "Nome",
    cancel: "Cancelar",
    save: "Salvar como meu tema",
    saveChanges: "Salvar mudanças",
    saveCopy: "Salvar como um tema novo",
    accent: "Destaque",
    text: "Texto",
    background: "Fundo",
    radius: "Raio dos cantos (px)",
    ligatures: "Ligaduras",
    dark: "Escuro",
    light: "Claro",
    preview: "Prévia",
    contrast: (ratio: string) => `Contraste do texto ${ratio} : 1`,
    muted: (ratio: string) => `Contraste do texto discreto ${ratio} : 1`,
    footer: "Tema",
    none: "Sem mudanças",
    one: "1 mudança não salva",
    many: (count: number) => `${count} mudanças não salvas`,
    unsaved: "não salvo",
    palette: "As 16 cores",
  },
} as const;

interface StartOptions {
  language?: Language;
  mode?: Mode;
  style?: "glass" | "dense";
  themes?: readonly Theme[];
  width?: number;
  height?: number;
}

/** Opens the page with a settings file and the themes of the person, and waits for the first pane. */
async function start(page: Page, options: StartOptions = {}): Promise<void> {
  const language = options.language ?? "en";
  const mode = options.mode ?? "dark";
  await page.setViewportSize({ width: options.width ?? 1280, height: options.height ?? 800 });
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
  const lang = language === "pt-BR" ? '"language": "pt-BR", ' : "";
  await seedConfig(
    page,
    `{ ${lang}"appearance": { "theme": "${THEME[mode]}", "style": "${options.style ?? "dense"}" } }\n`,
  );
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  // The terminal takes the focus once its shell is up; the keyboard waits for that.
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeFocused();
}

/** Waits for the animations that end, so what is measured next is where it stays. */
const settled = (page: Page): Promise<unknown> =>
  page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));

const editorOf = (page: Page, language: Language = "en"): Locator =>
  page.getByRole("dialog", { name: WORDS[language].title, exact: true });

/** Opens the settings and the editor of the card of `id` (the button says Customize or Edit). */
async function openEditor(page: Page, id: string, language: Language = "en"): Promise<Locator> {
  const screen = page.getByRole("dialog", { name: WORDS[language].settings, exact: true });
  // The settings screen may still be open from the last editor.
  if (!(await screen.isVisible())) {
    await page.getByRole("button", { name: WORDS[language].settings, exact: true }).first().click();
  }
  await expect(screen).toBeVisible();
  const card = screen.locator(`[data-nr-part="theme-card"][data-nr-theme="${id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-nr-action="edit"]').click();
  const editor = editorOf(page, language);
  await expect(editor).toBeVisible();
  await settled(page);
  return editor;
}

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

const themeFiles = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.themeFiles() ?? {});

const group = (editor: Locator, id: string): Locator => editor.locator(`[data-nr-group="${id}"]`);
const field = (editor: Locator, name: string): Locator =>
  editor.locator(`[data-nr-field="${name}"]`);
const textbox = (editor: Locator, name: string): Locator =>
  editor.getByRole("textbox", { name, exact: true });
const preview = (editor: Locator): Locator => editor.locator('[data-nr-part="theme-preview"]');
const previewVar = (editor: Locator, name: string): Promise<string> =>
  preview(editor).evaluate((element, n) => element.style.getPropertyValue(n).trim(), name);
const crumb = (editor: Locator): Locator => editor.locator('[data-nr-part="theme-editor-crumb"]');
const changes = (editor: Locator): Locator => editor.locator(".theme-editor-footer-changes");

/** The color of the pixel at the fraction `at` of the width and the middle of the height of an element, as the browser paints it. */
async function pixelAt(locator: Locator, at: number): Promise<string> {
  const pixels = readPixels(await locator.screenshot());
  const [r, g, b] = pixels.at(Math.round((pixels.width - 1) * at), Math.floor(pixels.height / 2));
  return `rgb(${r}, ${g}, ${b})`;
}

/** How much of a box sticks out of its own box to the side (`scrollWidth - clientWidth`). */
const sideways = (locator: Locator): Promise<number> =>
  locator.evaluate((element) => element.scrollWidth - element.clientWidth);

/** axe over the page, with the editor open. */
const axeOf = (page: Page, label: string): Promise<void> => expectNoAxeViolations(page, label);

const COMBOS: readonly (readonly [Language, Mode])[] = [
  ["en", "dark"],
  ["en", "light"],
  ["pt-BR", "dark"],
  ["pt-BR", "light"],
];

test.describe("the page", () => {
  test("fills the window under its title bar, which stays in reach with the buttons of the window", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    expect(await box(editor)).toMatchObject({ x: 0, y: 32, width: 1280, height: 768 });
    // Square, no glass, no shadow, solid: the page of the window, and the type of the style.
    expect(await style(editor, "border-top-left-radius")).toBe("0px");
    expect(await style(editor, "border-top-width")).toBe("0px");
    expect(await style(editor, "backdrop-filter")).toBe("none");
    expect(await style(editor, "box-shadow")).toBe("none");
    expect(await style(editor, "background-color")).toMatch(/^rgb\(/);
    expect(await style(editor, "font-family")).toMatch(/^"JetBrains Mono"/);
    // The settings screen under it is not seen through it, and the title bar above is not under it.
    const hits = await page.evaluate(() => [
      (document.elementFromPoint(1240, 16)?.closest(".titlebar") ?? null) !== null,
      (document.elementFromPoint(640, 400)?.closest(".theme-editor") ?? null) !== null,
    ]);
    expect(hits).toEqual([true, true]);
  });

  test("a grid of a header of 32 px, the body and a foot of 24 px, with the preview at the left and a column of 320 px at the right", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const header = await box(editor.getByRole("heading", { name: "Theme editor", level: 2 }));
    const actions = await box(editor.locator(".dialog-actions"));
    const body = await box(editor.locator(".theme-editor-body"));
    const foot = await box(editor.locator(".theme-editor-footer"));
    expect([header.y, header.height, actions.y, actions.height]).toEqual([32, 32, 32, 32]);
    expect([body.y, body.height]).toEqual([64, 712]);
    expect([foot.y, foot.height]).toEqual([776, 24]);
    const controls = await box(editor.locator(".theme-editor-controls"));
    const side = await box(editor.locator(".theme-editor-side"));
    expect([controls.x, controls.width]).toEqual([960, 320]);
    expect([side.x, side.width]).toEqual([0, 960]);
    // The title is the one of the style: small, muted, in lowercase.
    const title = editor.getByRole("heading", { name: "Theme editor", level: 2 });
    expect(await style(title, "font-size")).toBe("12px");
    expect(await style(title, "text-transform")).toBe("lowercase");
    // The column of boxes has the fill of the bars and a line at its left, the preview the page.
    expect(await style(editor.locator(".theme-editor-controls"), "border-left-width")).toBe("1px");
    expect(await style(editor.locator(".theme-editor-controls"), "background-color")).not.toBe(
      await style(editor.locator(".theme-editor-side"), "background-color"),
    );
  });

  test("the crumb says where you are and is a drawing: the name of the dialog is the title only", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    await expect(editor).toHaveAccessibleName("Theme editor");
    await expect(crumb(editor)).toHaveAttribute("aria-hidden", "true");
    await expect(crumb(editor)).toHaveText("/Noren Dusk copy");
    await expect(crumb(editor).locator(".theme-editor-crumb-unsaved")).toHaveCount(0);
    // It follows the name as it is typed.
    await textbox(editor, "Name").fill("Grafite neon");
    await expect(crumb(editor).locator(".theme-editor-crumb-name")).toHaveText("Grafite neon");
    // The name of a theme is the person's: the title is lowercased, the name is not.
    expect(await style(crumb(editor).locator(".theme-editor-crumb-name"), "text-transform")).toBe(
      "none",
    );
    // Typed over, an empty name is a mark, not a gap.
    await textbox(editor, "Name").fill("");
    await expect(crumb(editor).locator(".theme-editor-crumb-name")).toHaveText("…");
  });

  test("the buttons are in the header, 22 px, square; the one that saves is filled with the highlight and carries the dark text", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const cancel = editor.getByRole("button", { name: "Cancel", exact: true });
    const save = editor.getByRole("button", { name: "Save as my theme", exact: true });
    for (const button of [cancel, save]) {
      const at = await box(button);
      expect(at.height).toBe(22);
      expect(at.y).toBeGreaterThanOrEqual(32);
      expect(at.y + at.height).toBeLessThanOrEqual(64);
      expect(await style(button, "border-top-left-radius")).toBe("0px");
      expect(await style(button, "border-top-width")).toBe("1px");
    }
    expect(await style(save, "background-color")).toBe(await highlight(page));
    expect(await style(save, "color")).toBe("rgb(13, 15, 30)");
    expect(await style(cancel, "background-color")).toBe("rgba(0, 0, 0, 0)");
    // The title, then the buttons, in the header; the buttons come after the boxes in the page.
    const title = await box(editor.getByRole("heading", { name: "Theme editor", level: 2 }));
    expect(title.x).toBeLessThan((await box(cancel)).x);
    expect((await box(cancel)).x).toBeLessThan((await box(save)).x);
    // A theme of the person can be saved over or saved as a new one.
    await page.keyboard.press("Escape");
  });

  test("a theme of the person has three buttons: Cancel, Save as a new theme and Save changes", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const editor = await openEditor(page, "mine");
    const names = await editor.locator(".dialog-actions button").allTextContents();
    expect(names).toEqual(["Cancel", "Save as a new theme", "Save changes"]);
    const filled = editor.getByRole("button", { name: "Save changes", exact: true });
    expect(await style(filled, "background-color")).toBe(await highlight(page));
    await expect(crumb(editor)).toHaveText("/Mine");
  });
});

test.describe("the preview and what it reads", () => {
  test("the head says Preview, what it does and the two readings of the contrast, in green while they hold", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const head = editor.locator(".theme-editor-side-head");
    await expect(head.getByRole("heading", { name: "Preview", level: 3 })).toBeVisible();
    expect(await style(head.locator("h3"), "text-transform")).toBe("uppercase");
    expect(await style(head.locator("h3"), "font-size")).toBe("11px");
    await expect(head.locator(".theme-editor-hint")).toContainText(
      "The preview shows every change",
    );
    const text = head.locator('[data-nr-part="theme-editor-contrast"]');
    const muted = head.locator('[data-nr-part="theme-editor-contrast-muted"]');
    await expect(text).toHaveText(
      WORDS.en.contrast(contrastRatio(NOREN_DUSK.ui.text, NOREN_DUSK.ui.bg).toFixed(1)),
    );
    await expect(muted).toHaveText(
      WORDS.en.muted(contrastRatio(NOREN_DUSK.ui.muted, NOREN_DUSK.ui.bg).toFixed(1)),
    );
    for (const reading of [text, muted]) {
      await expect(reading).toHaveAttribute("data-nr-state", "ok");
      await expect(reading.locator("svg")).toHaveCount(1);
    }
    // Both are read in the color of a running state, which is not the highlight.
    expect(await style(text, "color")).toBe(await style(muted, "color"));
    expect(await style(text, "color")).not.toBe(await highlight(page));
  });

  test("a text or a gray that does not hold turns its reading amber, with the sentence under the preview, and back", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const text = editor.locator('[data-nr-part="theme-editor-contrast"]');
    const muted = editor.locator('[data-nr-part="theme-editor-contrast-muted"]');
    const green = await style(text, "color");
    await textbox(editor, "Text").fill("#15161a");
    await expect(text).toHaveAttribute("data-nr-state", "low");
    await expect(muted).toHaveAttribute("data-nr-state", "ok");
    expect(await style(text, "color")).not.toBe(green);
    await expect(editor.locator('[data-nr-note="text"]')).toBeVisible();
    await textbox(editor, "Muted text").fill("#15161a");
    await expect(muted).toHaveAttribute("data-nr-state", "low");
    await expect(editor.locator('[data-nr-note="muted"]')).toBeVisible();
    await textbox(editor, "Text").fill("#e6e6e6");
    await textbox(editor, "Muted text").fill("#9aa0aa");
    await expect(text).toHaveAttribute("data-nr-state", "ok");
    await expect(muted).toHaveAttribute("data-nr-state", "ok");
    expect(await style(text, "color")).toBe(green);
    await expect(editor.locator('[data-nr-note="text"]')).toHaveCount(0);
  });

  test("the preview draws what it drew: the same parts, the theme being edited and not the one in force, in a frame with a line", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const frame = preview(editor);
    await expect(frame.locator(".tp-window .tp-title")).toHaveCount(1);
    await expect(frame.locator(".tp-side .tp-tab")).toHaveCount(3);
    await expect(frame.locator(".tp-swatch")).toHaveCount(16);
    // It takes the room the head and the table leave, and its frame is a square one with a line of 1 px.
    const at = await box(frame);
    expect(at.x).toBe(12);
    expect(at.height).toBeGreaterThanOrEqual(340);
    expect(await style(frame, "border-top-width")).toBe("1px");
    expect(await style(frame, "border-top-left-radius")).toBe("0px");
    // What is typed is drawn at once, and nowhere else: the page still has the theme in force.
    const pageAccent = await rgbOf(page, "var(--nr-accent)");
    await textbox(editor, "Accent").fill("#112233");
    expect(await previewVar(editor, "--tp-accent")).toBe("#112233");
    expect(await rgbOf(page, "var(--nr-accent)")).toBe(pageAccent);
    await textbox(editor, "Background").fill("#223344");
    expect(await previewVar(editor, "--tp-bg")).toBe("#223344");
    expect(await style(editor, "background-color")).not.toBe("rgb(34, 51, 68)");
  });

  test("a picture on the theme shows behind the window of the preview", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const editor = await openEditor(page, "mine");
    await expect(preview(editor)).toHaveAttribute("data-nr-picture", "shown");
    await group(editor, "picture").scrollIntoViewIfNeeded();
    await editor.locator('[data-nr-part="background-remove"]').click();
    await expect(preview(editor)).toHaveAttribute("data-nr-picture", "none");
  });
});

test.describe("the boxes", () => {
  test("nine groups under headings of 28 px in capitals, with a line under each", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const groups = editor.locator(".theme-editor-controls > fieldset");
    await expect(groups).toHaveCount(9);
    const ids = await groups.evaluateAll((all) => all.map((e) => e.getAttribute("data-nr-group")));
    expect(ids).toEqual([
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
    for (const id of ids as string[]) {
      const legend = group(editor, id).locator("> legend");
      await legend.scrollIntoViewIfNeeded();
      expect((await box(legend)).height, id).toBe(28);
      expect(await style(legend, "text-transform"), id).toBe("uppercase");
      expect(await style(legend, "font-size"), id).toBe("11px");
      expect(await style(legend, "letter-spacing"), id).toBe("1.5px");
      expect(await style(group(editor, id), "border-bottom-width"), id).toBe("1px");
    }
    await expect(group(editor, "general").locator("> legend")).toHaveText("Name and kind");
  });

  test("a color is a name in a column of 130 px, a swatch of 16 px and a box of 22 px, and the two are one value", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const row = field(editor, "ui.accent");
    const label = row.locator(".theme-color-label");
    const swatch = row.locator("input.theme-swatch");
    const hex = row.locator("input.theme-hex");
    const at = await box(row);
    expect(at.height).toBe(30);
    expect((await box(label)).x - at.x).toBe(0);
    expect((await box(swatch)).x - at.x).toBe(130);
    expect(await box(swatch)).toMatchObject({ width: 16, height: 16 });
    expect((await box(hex)).height).toBe(22);
    expect((await box(hex)).x - (await box(swatch)).x).toBe(22);
    expect(await style(hex, "border-top-width")).toBe("1px");
    expect(await style(hex, "border-top-left-radius")).toBe("0px");
    expect(await style(hex, "font-family")).toMatch(/^"JetBrains Mono"/);
    // The swatch shows the value of the box, and the box the value of the swatch.
    await expect(swatch).toHaveValue("#e07a5f");
    await hex.fill("#10b981");
    await expect(swatch).toHaveValue("#10b981");
    await swatch.evaluate((element: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(element, "#336699");
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(hex).toHaveValue("#336699");
    expect(await previewVar(editor, "--tp-accent")).toBe("#336699");
  });

  test("the name is the first box of the first group, selected when the editor opens, and the kind is two buttons in one frame", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const name = textbox(editor, "Name");
    await expect(name).toBeFocused();
    expect(
      await name.evaluate((e: HTMLInputElement) => [e.selectionStart, e.selectionEnd]),
    ).toEqual([0, "Noren Dusk copy".length]);
    const row = field(editor, "name");
    expect((await box(name)).x - (await box(row)).x).toBe(130);
    expect((await box(name)).height).toBe(22);
    // The kind: a name in the column and two options in one frame, 22 px, the chosen one filled.
    const frame = editor.locator(".theme-editor-kinds");
    const dark = editor.getByRole("radio", { name: "Dark", exact: true });
    const light = editor.getByRole("radio", { name: "Light", exact: true });
    await expect(dark).toBeChecked();
    expect((await box(frame)).height).toBe(24);
    expect((await box(frame)).x - (await box(editor.locator(".theme-editor-kind"))).x).toBe(130);
    const chosen = dark.locator("xpath=..");
    const other = light.locator("xpath=..");
    expect((await box(chosen)).height).toBe(22);
    expect(await style(chosen, "background-color")).toBe(await highlight(page));
    expect(await style(chosen, "color")).toBe("rgb(13, 15, 30)");
    expect(await style(other, "background-color")).toBe("rgba(0, 0, 0, 0)");
    expect(await style(dark, "opacity")).toBe("0");
    // The arrows move the choice and the fill follows.
    await dark.focus();
    await page.keyboard.press("ArrowRight");
    await expect(light).toBeChecked();
    expect(await style(other, "background-color")).toBe(await highlight(page));
    expect(await style(chosen, "background-color")).toBe("rgba(0, 0, 0, 0)");
  });

  test("a number with a range is its label, a slider filled up to its handle and its number at the end of the row; the number is still a box", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const row = field(editor, "ui.radius").locator(".settings-number");
    await row.scrollIntoViewIfNeeded();
    const slider = row.getByRole("slider", { name: "Corner radius (px), slider", exact: true });
    const number = textbox(editor, "Corner radius (px)");
    const at = await box(row);
    expect((await box(slider)).x - at.x).toBe(138);
    expect((await box(number)).width).toBe(54);
    expect(Math.abs((await box(number)).x + 54 - (at.x + at.width - 10))).toBeLessThanOrEqual(1);
    expect(await style(number, "text-align")).toBe("right");
    expect(await style(number, "border-top-color")).toBe("rgba(0, 0, 0, 0)");
    // The track is the highlight up to the handle (a tenth of the way in is on the filled part, nine tenths in is not), and the number is the slider's.
    const wanted = await highlight(page);
    expect(await pixelAt(slider, 0.08)).toBe(wanted);
    expect(await pixelAt(slider, 0.92)).not.toBe(wanted);
    expect(await slider.evaluate((e) => e.style.getPropertyValue("--nr-slider-fill"))).toBe(
      String(10 / 32),
    );
    await number.fill("32");
    await expect(slider).toHaveValue("32");
    expect(await slider.evaluate((e) => e.style.getPropertyValue("--nr-slider-fill"))).toBe("1");
    expect(await pixelAt(slider, 0.92)).toBe(wanted);
    expect(await previewVar(editor, "--tp-radius")).toBe("32px");
    // The slider writes the number, and the keyboard moves it.
    await slider.focus();
    await page.keyboard.press("Home");
    await expect(number).toHaveValue("0");
    await expect(slider).toHaveValue("0");
    // The number draws a box when the pointer or the keyboard is on it.
    await number.focus();
    expect(await style(number, "border-top-color")).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("the ligatures are a switch of 36 by 18 with a knob of 12, at the end of the row, and the preview follows", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const editor = await openEditor(page, "mine");
    const ligatures = editor.getByRole("switch", { name: "Ligatures", exact: true });
    await ligatures.scrollIntoViewIfNeeded();
    const at = await box(ligatures);
    expect([at.width, at.height]).toEqual([36, 18]);
    expect(await style(ligatures, "border-top-width")).toBe("1px");
    expect(await style(ligatures, "border-top-left-radius")).toBe("0px");
    expect(await style(ligatures, "width", "::after")).toBe("12px");
    expect(await style(ligatures, "height", "::after")).toBe("12px");
    expect(await style(ligatures, "border-top-left-radius", "::after")).toBe("0px");
    // The label is at the left of the row and the switch at its right end.
    const controls = await box(editor.locator(".theme-editor-controls"));
    expect(Math.abs(controls.x + controls.width - 10 - (at.x + at.width))).toBeLessThanOrEqual(1);
    const label = await box(editor.locator(".settings-toggle > .settings-option > span"));
    expect(label.x + label.width).toBeLessThan(at.x);
    // Off: the frame is a line and the knob is gray at the start; on: both are the highlight, the knob 18 px on.
    await expect(ligatures).not.toBeChecked();
    expect(await style(ligatures, "border-top-color")).not.toBe(await highlight(page));
    await ligatures.click();
    await expect(ligatures).toBeChecked();
    await expect
      .poll(() => style(ligatures, "transform", "::after"))
      .toBe("matrix(1, 0, 0, 1, 18, 0)");
    expect(await style(ligatures, "border-top-color")).toBe(await highlight(page));
    expect(await style(ligatures, "background-color", "::after")).toBe(await highlight(page));
    expect(await style(editor.locator(".tp-terminal"), "font-variant-ligatures")).toBe("normal");
    // The keyboard turns it as well.
    await ligatures.focus();
    await page.keyboard.press("Space");
    await expect(ligatures).not.toBeChecked();
    expect(await style(editor.locator(".tp-terminal"), "font-variant-ligatures")).toBe("none");
  });

  test("the font names and the path of the picture are boxes of 22 px beside their names; the picture is a row of its miniature, its name and its buttons", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const editor = await openEditor(page, "mine");
    for (const name of ["Font names", "Picture path"]) {
      const box22 = textbox(editor, name);
      await box22.scrollIntoViewIfNeeded();
      expect((await box(box22)).height, name).toBe(22);
      const row = editor.locator(".settings-wide", {
        has: page.getByRole("textbox", { name, exact: true }),
      });
      expect((await box(box22)).x - (await box(row)).x, name).toBe(130);
    }
    const picker = editor.locator('[data-nr-part="background-picker"]');
    await picker.scrollIntoViewIfNeeded();
    expect(await box(picker.locator(".background-thumb"))).toMatchObject({ width: 48, height: 28 });
    expect(await style(picker.locator(".background-thumb"), "border-top-left-radius")).toBe("0px");
    await expect(picker.locator('[data-nr-part="background-picker-name"]')).toHaveText(
      "background.png",
    );
    for (const part of ["background-choose", "background-remove"]) {
      const button = picker.locator(`[data-nr-part="${part}"]`);
      expect((await box(button)).height, part).toBe(24);
      expect(await style(button, "border-top-left-radius"), part).toBe("0px");
    }
    expect(
      await style(picker.locator('[data-nr-part="background-choose"]'), "border-top-color"),
    ).toBe(await highlight(page));
    // A name far too long is cut inside its own box and nothing scrolls sideways.
    const long = `fixtures/${"a-picture-with-a-very-long-name-".repeat(6)}.png`;
    await textbox(editor, "Picture path").fill(long);
    const info = picker.locator('[data-nr-part="background-picker-name"]');
    expect(await style(info, "text-overflow")).toBe("ellipsis");
    expect(await info.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    expect(await sideways(editor.locator(".theme-editor-controls"))).toBeLessThanOrEqual(0);
    // The chooser of the system (the fake one) hands a file over and the row says its name.
    await page.evaluate((path) => (window as HookWindow).__norenTest?.setImagePick(path), PICTURE);
    await picker.locator('[data-nr-part="background-choose"]').click();
    await expect(info).toHaveText("background.png");
  });

  test("a box that is not valid says why under its row, keeps the line of the highlight, and holds Save back", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const save = editor.getByRole("button", { name: "Save as my theme", exact: true });
    await textbox(editor, "Accent").fill("zzz");
    const row = field(editor, "ui.accent");
    await expect(row.getByRole("alert")).toHaveText("Use a color like #1a2b3c.");
    await expect(save).toBeDisabled();
    expect(await style(textbox(editor, "Accent"), "border-top-color")).toBe(await highlight(page));
    // The preview kept the last valid value, and the strip under the body says what to do.
    expect(await previewVar(editor, "--tp-accent")).toBe("#e07a5f");
    const fix = editor.locator('[data-nr-part="theme-editor-fix"]');
    await expect(fix).toHaveText("Fix the boxes that say what is wrong before saving.");
    const body = await box(editor.locator(".theme-editor-body"));
    const strip = await box(fix);
    const foot = await box(editor.locator(".theme-editor-footer"));
    expect(strip.y).toBeGreaterThanOrEqual(body.y + body.height - 1);
    expect(strip.y + strip.height).toBeLessThanOrEqual(foot.y + 1);
    expect(await sideways(editor)).toBeLessThanOrEqual(0);
    await textbox(editor, "Accent").fill("#123456");
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expect(fix).toHaveCount(0);
    await expect(save).toBeEnabled();
  });

  test("a name that is refused says why under the name and holds Save back", async ({ page }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const save = editor.getByRole("button", { name: "Save as my theme", exact: true });
    await textbox(editor, "Name").fill("");
    await expect(field(editor, "name").getByRole("alert")).toBeVisible();
    await expect(save).toBeDisabled();
    expect(await style(textbox(editor, "Name"), "border-top-color")).toBe(await highlight(page));
    await textbox(editor, "Name").fill("Fine");
    await expect(field(editor, "name").getByRole("alert")).toHaveCount(0);
    await expect(save).toBeEnabled();
  });
});

test.describe("the sixteen colors", () => {
  test("are a table under the preview: the names across the top, the normal colors in a row and the bright ones under them", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const table = editor.locator('[data-nr-part="theme-palette"]');
    // Not in the group of the terminal any more, but after the preview in the column at the left.
    await expect(group(editor, "terminal").locator('[data-nr-part="theme-palette"]')).toHaveCount(
      0,
    );
    await expect(editor.locator(".theme-editor-side [data-nr-part='theme-palette']")).toHaveCount(
      1,
    );
    const preview0 = await box(preview(editor));
    const at = await box(table);
    expect(at.y).toBeGreaterThanOrEqual(preview0.y + preview0.height);
    await expect(table.locator(".theme-palette-title")).toHaveText("The 16 colors");
    const names = table.locator(".theme-palette-name");
    await expect(names).toHaveCount(8);
    expect(await names.allTextContents()).toEqual([
      "Black",
      "Red",
      "Green",
      "Yellow",
      "Blue",
      "Magenta",
      "Cyan",
      "White",
    ]);
    const nameBoxes = await Promise.all((await names.all()).map(box));
    const cells = (row: number) =>
      table.locator(`.theme-palette-row .theme-color:nth-of-type(${row})`);
    const normal = await Promise.all((await cells(1).all()).map(box));
    const bright = await Promise.all((await cells(2).all()).map(box));
    expect(normal).toHaveLength(8);
    expect(bright).toHaveLength(8);
    for (let at2 = 0; at2 < 8; at2 += 1) {
      const name = nameBoxes[at2];
      const top = normal[at2];
      const under = bright[at2];
      if (name === undefined || top === undefined || under === undefined) throw new Error("cell");
      // One column for a name: its color above and its bright color below.
      expect(Math.abs(top.x - name.x), `column ${at2}`).toBeLessThanOrEqual(1);
      expect(Math.abs(top.width - name.width), `column ${at2}`).toBeLessThanOrEqual(1);
      expect(Math.abs(under.x - name.x), `column ${at2}`).toBeLessThanOrEqual(1);
      expect(name.y + name.height, `column ${at2}`).toBeLessThanOrEqual(top.y + 1);
      expect(top.y + top.height, `column ${at2}`).toBeLessThanOrEqual(under.y + 1);
      expect(Math.abs(top.y - (normal[0]?.y ?? 0)), `row`).toBeLessThanOrEqual(1);
      expect(Math.abs(under.y - (bright[0]?.y ?? 0)), `row`).toBeLessThanOrEqual(1);
    }
    // The names of the rows are the two words at the left.
    const heads = table.locator(".theme-palette-head");
    expect(await heads.allTextContents()).toEqual(["Normal", "Bright"]);
    expect((await box(heads.nth(0))).x).toBeLessThan((normal[0]?.x ?? 0) + 1);
    expect((await box(heads.nth(1))).y).toBeGreaterThanOrEqual((normal[0]?.y ?? 0) + 20);
  });

  test("in a column too narrow for eight of them (under 720 px of content) the table is a list: a row for each name with the normal color and the bright one beside it", async ({
    page,
  }) => {
    await start(page, { width: 900 });
    const editor = await openEditor(page, "noren-dusk");
    const table = editor.locator('[data-nr-part="theme-palette"]');
    const names = await Promise.all((await table.locator(".theme-palette-name").all()).map(box));
    const normal = await Promise.all(
      (await table.locator(".theme-palette-row .theme-color:nth-of-type(1)").all()).map(box),
    );
    const bright = await Promise.all(
      (await table.locator(".theme-palette-row .theme-color:nth-of-type(2)").all()).map(box),
    );
    expect(names).toHaveLength(8);
    const first = names[0];
    const second = names[1];
    const firstCell = normal[0];
    const firstBright = bright[0];
    if (!first || !second || !firstCell || !firstBright) throw new Error("rows");
    const step = second.y - first.y;
    for (let at = 0; at < 8; at += 1) {
      const [name, top, under] = [names[at], normal[at], bright[at]];
      if (name === undefined || top === undefined || under === undefined) throw new Error("row");
      // One row: the name, then the normal color, then the bright one, every row a step under the last.
      expect(Math.abs(name.y - first.y - at * step)).toBeLessThanOrEqual(1);
      expect(step).toBeGreaterThan(20);
      expect(Math.abs(top.y + top.height / 2 - (name.y + name.height / 2))).toBeLessThanOrEqual(6);
      expect(top.x).toBeGreaterThanOrEqual(name.x + name.width - 1);
      expect(under.x).toBeGreaterThanOrEqual(top.x + top.width - 1);
      expect(Math.abs(under.y - top.y)).toBeLessThanOrEqual(1);
      expect(under.x + under.width).toBeLessThanOrEqual(900 - 320);
    }
    // The two words that name the columns are over them.
    const heads = table.locator(".theme-palette-head");
    expect(await heads.allTextContents()).toEqual(["Normal", "Bright"]);
    expect((await box(heads.nth(0))).y).toBeLessThan(firstCell.y);
    expect(Math.abs((await box(heads.nth(0))).x - firstCell.x)).toBeLessThanOrEqual(1);
    expect(Math.abs((await box(heads.nth(1))).x - firstBright.x)).toBeLessThanOrEqual(1);
  });

  test("each cell is a swatch of 12 px and the hex value in a box of 26 px, and changes its own color of the palette and no other", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const cell = field(editor, "terminal.ansi.1");
    const frame = cell.locator(".theme-color-boxes");
    expect((await box(frame)).height).toBe(26);
    expect(await style(frame, "border-top-width")).toBe("1px");
    expect(await style(frame, "border-top-left-radius")).toBe("0px");
    expect(await box(cell.locator("input.theme-swatch"))).toMatchObject({ width: 12, height: 12 });
    const before = await Promise.all(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((i) =>
        previewVar(editor, `--tp-ansi-${i}`),
      ),
    );
    await textbox(editor, "Red").fill("#ff0000");
    expect(await previewVar(editor, "--tp-ansi-1")).toBe("#ff0000");
    for (let i = 0; i < 16; i += 1) {
      if (i === 1) continue;
      expect(await previewVar(editor, `--tp-ansi-${i}`), `color ${i}`).toBe(before[i]);
    }
    await textbox(editor, "Bright white").fill("#fafafa");
    expect(await previewVar(editor, "--tp-ansi-15")).toBe("#fafafa");
    // A box that is not valid says why, under its cell, and keeps the line of the highlight.
    await textbox(editor, "Green").fill("nope");
    await expect(field(editor, "terminal.ansi.2").getByRole("alert")).toBeVisible();
    await expect(field(editor, "terminal.ansi.2").locator(".theme-color-boxes")).toHaveCSS(
      "border-top-color",
      await highlight(page),
    );
    await expect(
      editor.getByRole("button", { name: "Save as my theme", exact: true }),
    ).toBeDisabled();
  });
});

test.describe("what is unsaved", () => {
  test("the crumb and the foot say it, and count it, and clear when the values are back as they were", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const foot = editor.locator(".theme-editor-footer");
    await expect(foot).toHaveAttribute("aria-hidden", "true");
    await expect(foot.locator(".theme-editor-footer-label")).toHaveText("Theme");
    await expect(foot.locator(".theme-editor-footer-name")).toHaveText("Noren Dusk copy");
    await expect(changes(editor)).toHaveText("No changes");
    await expect(changes(editor)).toHaveAttribute("data-nr-state", "none");
    const muted = await style(changes(editor), "color");
    // One box.
    await textbox(editor, "Accent").fill("#112233");
    await expect(changes(editor)).toHaveText("1 unsaved change");
    await expect(changes(editor)).toHaveAttribute("data-nr-state", "unsaved");
    expect(await style(changes(editor), "color")).not.toBe(muted);
    await expect(crumb(editor).locator(".theme-editor-crumb-unsaved")).toHaveText("unsaved");
    expect(await style(crumb(editor).locator(".theme-editor-crumb-unsaved"), "color")).toBe(
      await style(changes(editor), "color"),
    );
    // The kind, the ligatures, a number, the name and a palette color each count one.
    await editor.getByRole("radio", { name: "Light", exact: true }).check();
    await expect(changes(editor)).toHaveText("2 unsaved changes");
    await editor.getByRole("switch", { name: "Ligatures", exact: true }).click();
    await textbox(editor, "Corner radius (px)").fill("3");
    await textbox(editor, "Black").fill("#000000");
    await textbox(editor, "Name").fill("Counted");
    await expect(changes(editor)).toHaveText("6 unsaved changes");
    await expect(foot.locator(".theme-editor-footer-name")).toHaveText("Counted");
    // Back to the values the editor opened with: nothing is unsaved, and the mark goes.
    await textbox(editor, "Accent").fill("#e07a5f");
    await editor.getByRole("radio", { name: "Dark", exact: true }).check();
    await editor.getByRole("switch", { name: "Ligatures", exact: true }).click();
    await textbox(editor, "Corner radius (px)").fill("10");
    await textbox(editor, "Black").fill("#1b1e25");
    await textbox(editor, "Name").fill("Noren Dusk copy");
    await expect(changes(editor)).toHaveText("No changes");
    await expect(crumb(editor).locator(".theme-editor-crumb-unsaved")).toHaveCount(0);
  });

  test("a theme of the person counts its changes against its own name", async ({ page }) => {
    await start(page, { themes: [MINE] });
    const editor = await openEditor(page, "mine");
    await expect(changes(editor)).toHaveText("No changes");
    await textbox(editor, "Name").fill("Mine, renamed");
    await expect(changes(editor)).toHaveText("1 unsaved change");
    await textbox(editor, "Name").fill("Mine");
    await expect(changes(editor)).toHaveText("No changes");
  });

  test("the foot is a strip of 24 px with the word in the highlight and dark text, the name cut inside its box, and the count at the right end", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const foot = editor.locator(".theme-editor-footer");
    const label = foot.locator(".theme-editor-footer-label");
    expect(await style(label, "background-color")).toBe(await highlight(page));
    expect(await style(label, "color")).toBe("rgb(13, 15, 30)");
    expect(await style(label, "text-transform")).toBe("uppercase");
    const long = "A name that is far too long for a strip of a window ".repeat(8).trim();
    await textbox(editor, "Name").fill(long);
    const name = foot.locator(".theme-editor-footer-name");
    expect(await style(name, "text-overflow")).toBe("ellipsis");
    expect(await name.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    const at = await box(foot);
    const count = await box(changes(editor));
    expect(Math.abs(count.x + count.width - (at.x + at.width))).toBeLessThanOrEqual(1);
    expect(await sideways(foot)).toBeLessThanOrEqual(0);
    // The crumb is cut too, and the buttons keep their place at the right end of the header.
    const crumbName = crumb(editor).locator(".theme-editor-crumb-name");
    expect(await crumbName.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    const save = await box(editor.getByRole("button", { name: "Save as my theme", exact: true }));
    expect(save.x + save.width).toBeLessThanOrEqual(1280);
    expect(save.y).toBeGreaterThanOrEqual(36);
    expect(save.y).toBeLessThanOrEqual(38);
  });
});

test.describe("what the editor does is what it did", () => {
  /** The same edits, then Save, under one style: the file the editor wrote. */
  async function flow(page: Page, style2: "glass" | "dense"): Promise<Record<string, string>> {
    await start(page, { style: style2 });
    const editor = await openEditor(page, "noren-dusk");
    await textbox(editor, "Name").fill("Flow");
    await textbox(editor, "Accent").fill("#112233");
    await textbox(editor, "Selection").fill("#44556677");
    await textbox(editor, "Cyan").fill("#00ffff");
    await textbox(editor, "Corner radius (px)").fill("20");
    await textbox(editor, "Size (px)").fill("17");
    await textbox(editor, "Panel opacity").fill("0.5");
    await editor.getByRole("radio", { name: "Light", exact: true }).check();
    await editor.getByRole("switch", { name: "Ligatures", exact: true }).click();
    await editor.getByRole("button", { name: "Save as my theme", exact: true }).click();
    await expect(editor).toHaveCount(0);
    return themeFiles(page);
  }

  test("the same edits write the same file under the dense style and under the glass one", async ({
    page,
    browser,
    baseURL,
  }) => {
    const dense = await flow(page, "dense");
    const context = await newServedContext(browser, baseURL, {
      viewport: { width: 1280, height: 800 },
    });
    try {
      const glass = await flow(await context.newPage(), "glass");
      expect(Object.keys(dense)).toEqual(["flow"]);
      expect(dense).toEqual(glass);
      const written = JSON.parse(dense["flow"] ?? "{}") as Theme;
      expect(written.name).toBe("Flow");
      expect(written.kind).toBe("light");
      expect(written.ui.accent).toBe("#112233");
      expect(written.ui.radius).toBe(20);
      expect(written.terminal.selection).toBe("#44556677");
      expect(written.font.ligatures).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("Save changes on a theme of the person writes over it; Save as a new theme writes another", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const screen = page.getByRole("dialog", { name: "Settings", exact: true });
    let editor = await openEditor(page, "mine");
    await textbox(editor, "Accent").fill("#abcdef");
    await editor.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(Object.keys(await themeFiles(page))).toEqual(["mine"]);
    expect((JSON.parse((await themeFiles(page))["mine"] ?? "{}") as Theme).ui.accent).toBe(
      "#abcdef",
    );
    await expect(screen).toBeVisible();
    editor = await openEditor(page, "mine");
    await textbox(editor, "Name").fill("Mine two");
    await editor.getByRole("button", { name: "Save as a new theme", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(Object.keys(await themeFiles(page)).sort()).toEqual(["mine", "mine-two"]);
  });

  test("Cancel and Escape throw the changes away; Escape closes the editor only, and the focus goes back to its button", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const screen = page.getByRole("dialog", { name: "Settings", exact: true });
    await textbox(editor, "Accent").fill("#112233");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(screen).toBeVisible();
    expect(await themeFiles(page)).toEqual({});
    await expect(
      screen.locator(
        '[data-nr-part="theme-card"][data-nr-theme="noren-dusk"] [data-nr-action="edit"]',
      ),
    ).toBeFocused();
    const again = await openEditor(page, "noren-dusk");
    await expect(textbox(again, "Accent")).toHaveValue("#e07a5f");
    await textbox(again, "Name").fill("Dropped");
    await again.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(again).toHaveCount(0);
    expect(await themeFiles(page)).toEqual({});
  });

  test("a save that fails says why in a strip under the body, and the same editor saves once the disk does", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    await textbox(editor, "Name").fill("Refused");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.failThemeSave("the disk is full"),
    );
    await editor.getByRole("button", { name: "Save as my theme", exact: true }).click();
    const failure = editor.locator('[data-nr-part="theme-editor-failure"]');
    await expect(failure).toHaveText("Could not save “Refused”: the disk is full");
    const body = await box(editor.locator(".theme-editor-body"));
    const strip = await box(failure);
    const foot = await box(editor.locator(".theme-editor-footer"));
    expect(strip.y).toBeGreaterThanOrEqual(body.y + body.height - 1);
    expect(strip.y + strip.height).toBeLessThanOrEqual(foot.y + 1);
    expect(strip.x).toBe(0);
    expect(strip.width).toBe(1280);
    expect(await themeFiles(page)).toEqual({});
    await page.evaluate(() => (window as HookWindow).__norenTest?.failThemeSave());
    await editor.getByRole("button", { name: "Save as my theme", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(Object.keys(await themeFiles(page))).toEqual(["refused"]);
  });
});

test.describe("the keyboard", () => {
  test("Tab goes through the boxes in the order of the groups, then the colors under the preview, then the buttons", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    await expect(textbox(editor, "Name")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(editor.getByRole("radio", { name: "Dark", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(editor.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(editor.getByLabel("Accent, color picker", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(textbox(editor, "Accent")).toBeFocused();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("#112233");
    expect(await previewVar(editor, "--tp-accent")).toBe("#112233");
    await page.keyboard.press("Tab");
    await expect(editor.getByLabel("Background, color picker", { exact: true })).toBeFocused();
    // The last box of the table is followed by the buttons, which come after every box in the page.
    await textbox(editor, "Bright white").focus();
    await page.keyboard.press("Tab");
    await expect(editor.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      editor.getByRole("button", { name: "Save as my theme", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editor).toHaveCount(0);
    expect(Object.keys(await themeFiles(page))).toHaveLength(1);
  });

  test("the focus of a box, a button, a switch and a slider is a ring of the highlight", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const wanted = await highlight(page);
    const targets = [
      textbox(editor, "Accent"),
      editor.getByRole("slider", { name: "Corner radius (px), slider", exact: true }),
      editor.getByRole("switch", { name: "Ligatures", exact: true }),
      editor.getByRole("button", { name: "Save as my theme", exact: true }),
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ];
    for (const target of targets) {
      await target.scrollIntoViewIfNeeded();
      await target.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(target).toBeFocused();
      expect(await style(target, "outline-color")).toBe(wanted);
      expect(await style(target, "outline-style")).toBe("solid");
    }
  });
});

test.describe("the style", () => {
  test("switching the style with the editor open changes it at once, and keeps what was typed", async ({
    page,
  }) => {
    await start(page, { style: "glass" });
    const editor = await openEditor(page, "noren-dusk");
    await textbox(editor, "Accent").fill("#112233");
    await textbox(editor, "Name").fill("Live");
    // Glass: a card of 1120 by 784 with the name in its header, and none of what is dense.
    expect((await box(editor)).width).toBe(1120);
    await expect(editor.locator(".theme-editor-name")).toHaveCount(1);
    await expect(crumb(editor)).toHaveCount(0);
    await expect(editor.locator(".theme-editor-footer")).toHaveCount(0);
    await expect(editor.locator('[data-nr-part="theme-editor-contrast-muted"]')).toHaveCount(0);
    await expect(group(editor, "terminal").locator('[data-nr-part="theme-palette"]')).toHaveCount(
      1,
    );
    const toDense = '{ "appearance": { "theme": "noren-dusk", "style": "dense" } }\n';
    await page.evaluate((text) => (window as HookWindow).__norenTest?.setConfig(text), toDense);
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "dense");
    await settled(page);
    expect(await box(editor)).toMatchObject({ x: 0, y: 32, width: 1280, height: 768 });
    await expect(crumb(editor)).toHaveText("/Liveunsaved");
    await expect(editor.locator(".theme-editor-name")).toHaveCount(0);
    await expect(editor.locator(".theme-editor-footer")).toHaveCount(1);
    await expect(group(editor, "terminal").locator('[data-nr-part="theme-palette"]')).toHaveCount(
      0,
    );
    await expect(textbox(editor, "Accent")).toHaveValue("#112233");
    await expect(textbox(editor, "Name")).toHaveValue("Live");
    expect(await previewVar(editor, "--tp-accent")).toBe("#112233");
    await expect(changes(editor)).toHaveText("2 unsaved changes");
    // And back: the card again, with what was typed still in it.
    const toGlass = '{ "appearance": { "theme": "noren-dusk", "style": "glass" } }\n';
    await page.evaluate((text) => (window as HookWindow).__norenTest?.setConfig(text), toGlass);
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "glass");
    await settled(page);
    expect((await box(editor)).width).toBe(1120);
    await expect(crumb(editor)).toHaveCount(0);
    await expect(textbox(editor, "Name")).toHaveValue("Live");
    await expect(textbox(editor, "Accent")).toHaveValue("#112233");
  });

  test("choosing the style in Appearance first gives the dense editor the next time it opens", async ({
    page,
  }) => {
    await start(page, { style: "glass" });
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    const screen = page.getByRole("dialog", { name: "Settings", exact: true });
    await screen
      .locator('[data-nr-part="settings-style-card"]')
      .filter({ hasText: "Dense technical" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "dense");
    await settled(page);
    await screen.locator('[data-nr-part="settings-nav-themes"]').click();
    const card = screen.locator('[data-nr-part="theme-card"][data-nr-theme="noren-dusk"]');
    await card.scrollIntoViewIfNeeded();
    await card.locator('[data-nr-action="edit"]').click();
    const editor = editorOf(page);
    await expect(editor).toBeVisible();
    await settled(page);
    expect(await box(editor)).toMatchObject({ x: 0, y: 32, width: 1280, height: 768 });
    await expect(crumb(editor)).toHaveCount(1);
  });

  test("the glass editor is the card it was: no crumb, no foot, no table, a card of glass", async ({
    page,
  }) => {
    await start(page, { style: "glass" });
    const editor = await openEditor(page, "noren-dusk");
    expect(await box(editor)).toMatchObject({ width: 1120, height: 784 });
    expect(await style(editor, "border-top-left-radius")).toBe("14px");
    expect(await style(editor, "backdrop-filter")).toContain("blur(28px)");
    await expect(editor.locator(".theme-editor-footer")).toHaveCount(0);
    await expect(editor.getByRole("heading", { name: "Theme editor", level: 2 })).toHaveCSS(
      "font-size",
      "18px",
    );
    expect(await style(editor.locator(".theme-editor-controls"), "border-left-width")).toBe("1px");
    expect((await box(editor.locator(".theme-editor-controls"))).width).toBe(360);
  });
});

test.describe("the highlight", () => {
  test("is the color of the space, whichever of the four colors of the design it is: the button that saves, the chosen kind and the word at the foot", async ({
    page,
  }) => {
    await start(page);
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
      const editor = await openEditor(page, "noren-dusk");
      const wanted = await rgbOf(page, hex);
      expect(await highlight(page), name).toBe(wanted);
      const save = editor.getByRole("button", { name: "Save as my theme", exact: true });
      expect(await style(save, "background-color"), name).toBe(wanted);
      expect(await style(save, "color"), name).toBe("rgb(13, 15, 30)");
      const chip = editor.locator(".theme-editor-footer-label");
      expect(await style(chip, "background-color"), name).toBe(wanted);
      expect(await style(chip, "color"), name).toBe("rgb(13, 15, 30)");
      const chosen = editor.getByRole("radio", { name: "Dark", exact: true }).locator("xpath=..");
      expect(await style(chosen, "background-color"), name).toBe(wanted);
      expect(await style(chosen, "color"), name).toBe("rgb(13, 15, 30)");
      // The track of a slider is filled with it up to the handle.
      const slider = editor.getByRole("slider", {
        name: "Corner radius (px), slider",
        exact: true,
      });
      await slider.scrollIntoViewIfNeeded();
      expect(await pixelAt(slider, 0.08), name).toBe(wanted);
      await axeOf(page, `the dense editor, a space of ${name}`);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(editor).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toHaveCount(0);
    }
  });
});

test.describe("nothing scrolls sideways", () => {
  const WIDTHS = [1280, 900, 860, 720] as const;
  for (const width of WIDTHS) {
    for (const language of ["en", "pt-BR"] as const) {
      test(`at ${width} px, ${language}: no group, no strip, no cell and no row leaves the page or the column it is in`, async ({
        page,
      }) => {
        await start(page, { language, themes: [MINE], width });
        const editor = await openEditor(page, "mine", language);
        const frame = await box(editor);
        expect(frame.width).toBe(width);
        const ids = [
          "general",
          "accent",
          "colors",
          "sidebar",
          "terminal",
          "font",
          "corners",
          "transparency",
          "picture",
        ];
        for (const id of ids) {
          await group(editor, id).scrollIntoViewIfNeeded();
          // The page, the dialog and the columns do not scroll to the side.
          const roots = await page.evaluate(() => [
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ]);
          expect(roots[0], `${id}: the page`).toBeLessThanOrEqual(0);
          expect(await sideways(editor), `${id}: the dialog`).toBeLessThanOrEqual(0);
          for (const part of [
            ".theme-editor-body",
            ".theme-editor-controls",
            ".theme-editor-side",
          ]) {
            expect(
              await sideways(editor.locator(part).first()),
              `${id}: ${part}`,
            ).toBeLessThanOrEqual(0);
          }
        }
        // Nothing inside is wider than the page, and nothing is left of it: every box of the editor is in the window.
        const out = await editor.evaluate((root, w) => {
          const bad: string[] = [];
          for (const element of root.querySelectorAll<HTMLElement>("*")) {
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (
              element.closest('[aria-hidden="true"]') !== null &&
              element.closest(".theme-preview") !== null
            )
              continue;
            if (rect.left < -0.5 || rect.right > w + 0.5) {
              bad.push(
                `${element.tagName.toLowerCase()}.${element.className} ${Math.round(rect.left)}..${Math.round(rect.right)}`,
              );
            }
          }
          return bad.slice(0, 5);
        }, width);
        expect(out).toEqual([]);
        // The palette keeps its eight columns inside the column it is in.
        const table = await box(editor.locator('[data-nr-part="theme-palette"]'));
        expect(table.x + table.width).toBeLessThanOrEqual(width + 0.5);
        for (const hex of await editor.locator(".theme-palette input.theme-hex").all()) {
          const cell = await hex.evaluate((element) => {
            const frame2 = element.closest(".theme-color-boxes") as HTMLElement;
            return (
              element.scrollWidth - element.clientWidth + (frame2.scrollWidth - frame2.clientWidth)
            );
          });
          expect(cell).toBeLessThanOrEqual(0);
        }
      });
    }
  }

  test("below 860 px the preview goes above the boxes and the body scrolls as one; below 760 the buttons have a row of their own", async ({
    page,
  }) => {
    await start(page, { width: 720 });
    const editor = await openEditor(page, "noren-dusk");
    const side = await box(editor.locator(".theme-editor-side"));
    const controls = await box(editor.locator(".theme-editor-controls"));
    expect(controls.y).toBeGreaterThan(side.y + side.height - 1);
    expect(controls.width).toBe(720);
    const body = editor.locator(".theme-editor-body");
    expect(await body.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    expect(await style(body, "overflow-y")).toBe("auto");
    const header = await box(editor.getByRole("heading", { name: "Theme editor", level: 2 }));
    const actions = await box(editor.locator(".dialog-actions"));
    expect(actions.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    expect(actions.x + actions.width).toBeLessThanOrEqual(720);
    const save = await box(editor.getByRole("button", { name: "Save as my theme", exact: true }));
    expect(save.x + save.width).toBeLessThanOrEqual(720);
    // The foot is where it was: the last 24 px.
    expect((await box(editor.locator(".theme-editor-footer"))).y).toBe(776);
  });
});

test.describe("accessibility", () => {
  for (const [language, mode] of COMBOS) {
    test(`axe: the dense editor, ${language}, ${mode} theme, has no violation`, async ({
      page,
    }) => {
      await start(page, { language, mode });
      await openEditor(page, THEME[mode], language);
      await axeOf(page, `dense theme editor (${language}, ${mode})`);
    });

    test(`axe: the dense editor of a theme of the person, with a picture, with changes unsaved, ${language}, ${mode} theme`, async ({
      page,
    }) => {
      await start(page, { language, mode, themes: [MINE] });
      const editor = await openEditor(page, "mine", language);
      await expect(preview(editor)).toHaveAttribute("data-nr-picture", "shown");
      await textbox(editor, WORDS[language].accent).fill("#335577");
      await expect(changes(editor)).not.toHaveText(WORDS[language].none);
      await axeOf(page, `dense theme editor with a picture and changes (${language}, ${mode})`);
    });

    test(`axe: the dense editor with a box that is wrong and notes about contrast, ${language}, ${mode} theme`, async ({
      page,
    }) => {
      await start(page, { language, mode });
      const editor = await openEditor(page, THEME[mode], language);
      await textbox(editor, WORDS[language].accent).fill("zzz");
      await textbox(editor, WORDS[language].text).fill(mode === "dark" ? "#15161a" : "#f6f3ec");
      await expect(editor.locator('[data-nr-state="low"]').first()).toBeVisible();
      await axeOf(page, `dense theme editor with problems (${language}, ${mode})`);
    });
  }

  test("the words of the editor are read in both languages: the head, the readings, the foot", async ({
    page,
  }) => {
    await start(page, { language: "pt-BR", mode: "light" });
    const editor = await openEditor(page, "noren-paper", "pt-BR");
    const words = WORDS["pt-BR"];
    await expect(editor.locator(".theme-editor-side-head h3")).toHaveText(words.preview);
    await expect(editor.locator('[data-nr-part="theme-editor-contrast"]')).toHaveText(
      words.contrast(contrastRatio(NOREN_PAPER.ui.text, NOREN_PAPER.ui.bg).toFixed(1)),
    );
    await expect(editor.locator('[data-nr-part="theme-editor-contrast-muted"]')).toHaveText(
      words.muted(contrastRatio(NOREN_PAPER.ui.muted, NOREN_PAPER.ui.bg).toFixed(1)),
    );
    await expect(editor.locator(".theme-editor-footer-label")).toHaveText(words.footer);
    await expect(changes(editor)).toHaveText(words.none);
    await textbox(editor, words.accent).fill("#336699");
    await expect(changes(editor)).toHaveText(words.one);
    await expect(crumb(editor).locator(".theme-editor-crumb-unsaved")).toHaveText(words.unsaved);
    await textbox(editor, words.text).fill("#111111");
    await expect(changes(editor)).toHaveText(words.many(2));
    await expect(editor.locator(".theme-palette-title")).toHaveText(words.palette);
  });
});
