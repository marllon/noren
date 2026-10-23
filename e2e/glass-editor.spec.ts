import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { NOREN_DUSK } from "../packages/model/src/builtin-themes";
import type { Theme } from "../packages/model/src/theme";
import { serializeTheme } from "../packages/model/src/user-themes";
import { expectNoAxeViolations } from "./axe-fixture";
import { readPixels } from "./png-pixels";
import { seedConfig } from "./settings-fixture";

// The theme editor of the glass style (NOR-F20-20, D23), as in the approved design
// (`vidro-editor-de-tema`): a card of glass over the settings, a header with the title, the name of
// the theme in its box and the buttons, the preview on the left with the reading of the contrast of
// the text, and a column of boxes on the right (a color is a swatch and its hex value in one box, a
// number with a range is a label, a slider and a number in the mono type, a switch of 40 by 24 and a card for
// the picture). What the editor edits, what the preview draws and what Save writes are what they
// were (e2e/theme-editor.spec.ts, which runs under this style, is the proof); this spec is about how
// it looks and sits. The dense style does not change, and a test says so. Everything runs on the
// `FakeBackend` of web mode.

interface Hook {
  paneIds(): string[];
  setImagePick(path: string | null): void;
  themeFiles(): Record<string, string>;
  setSystemTransparencyReduced(reduced: boolean): void;
}
type HookWindow = Window & { __norenTest?: Hook };

type Mode = "dark" | "light";
type Language = "en" | "pt-BR";

const THEME: Record<Mode, string> = { dark: "noren-dusk", light: "noren-paper" };
const WEB_THEMES_KEY = "noren.web.themes";
const WEB_IMAGES_KEY = "noren.web.images";
const FIXTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));
const PICTURE = "fixtures/background.png";

/** One of the person's own themes, with a picture and a name that is long enough to need room. */
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
    ligatures: "Ligatures",
    accent: "Accent",
    text: "Text",
    background: "Background",
    radius: "Corner radius (px)",
    size: "Size (px)",
    fontNames: "Font names",
    preview: "Preview",
    contrast: (ratio: string) => `Text contrast ${ratio} : 1`,
    choose: "Choose image…",
    remove: "Remove",
    dark: "Dark",
    light: "Light",
  },
  "pt-BR": {
    settings: "Configurações",
    title: "Editor de tema",
    name: "Nome",
    cancel: "Cancelar",
    save: "Salvar como meu tema",
    saveChanges: "Salvar mudanças",
    saveCopy: "Salvar como um tema novo",
    ligatures: "Ligaduras",
    accent: "Destaque",
    text: "Texto",
    background: "Fundo",
    radius: "Raio dos cantos (px)",
    size: "Tamanho (px)",
    fontNames: "Nomes da fonte",
    preview: "Prévia",
    contrast: (ratio: string) => `Contraste do texto ${ratio} : 1`,
    choose: "Escolher imagem…",
    remove: "Remover",
    dark: "Escuro",
    light: "Claro",
  },
} as const;

interface StartOptions {
  language?: Language;
  mode?: Mode;
  style?: "glass" | "dense";
  themes?: readonly Theme[];
  width?: number;
  height?: number;
  /** The rest of `appearance`, as JSON text: `"window": { "opacity": 0.3 }`. */
  appearance?: string;
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
  const more = options.appearance === undefined ? "" : `, ${options.appearance}`;
  await seedConfig(
    page,
    `{ ${lang}"appearance": { "theme": "${THEME[mode]}", "style": "${options.style ?? "glass"}"${more} } }\n`,
  );
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  // The terminal takes the focus once its shell is up; the keyboard waits for that.
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeFocused();
}

const editorOf = (page: Page, language: Language = "en"): Locator =>
  page.getByRole("dialog", { name: WORDS[language].title, exact: true });

/** Opens the settings and the editor of the card of `id` (the button says Customize or Edit). */
async function openEditor(page: Page, id: string, language: Language = "en"): Promise<Locator> {
  await page.getByRole("button", { name: WORDS[language].settings, exact: true }).first().click();
  const screen = page.getByRole("dialog", { name: WORDS[language].settings, exact: true });
  await expect(screen).toBeVisible();
  const card = screen.locator(`[data-nr-part="theme-card"][data-nr-theme="${id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-nr-action="edit"]').click();
  const editor = editorOf(page, language);
  await expect(editor).toBeVisible();
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

const themeFiles = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.themeFiles() ?? {});

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
  // A mix with transparent is written in oklab: the channels are not worked out, the alpha is.
  const lab = /^o?k?lab\([^/]*(?:\/ ([0-9.]+))?\)$/.exec(value);
  if (lab !== null) return { r: NaN, g: NaN, b: NaN, a: lab[1] ? Number(lab[1]) : 1 };
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
const highlight = async (page: Page): Promise<Color> =>
  parseColor(
    await page.evaluate(() => {
      const probe = document.createElement("i");
      probe.style.color = "var(--nr-highlight)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }),
  );

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

const field = (editor: Locator, name: string): Locator =>
  editor.locator(`[data-nr-field="${name}"]`);
const group = (editor: Locator, id: string): Locator => editor.locator(`[data-nr-group="${id}"]`);
const nameBox = (editor: Locator, language: Language = "en"): Locator =>
  editor.getByRole("textbox", { name: WORDS[language].name, exact: true });

test.describe("the card of glass", () => {
  test("the editor is a card of glass: size, corners, line, blur and fill", async ({ page }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    expect(await style(editor, "border-top-left-radius")).toBe("14px");
    expect(await style(editor, "border-top-width")).toBe("1px");
    expect(await style(editor, "backdrop-filter")).toContain("blur(28px)");
    expect(await style(editor, "box-shadow")).not.toBe("none");
    // 0.62 (the glass of the panes) and 0.12 more: it is all text, like the settings screen.
    expect(parseColor(await style(editor, "background-color")).a).toBeCloseTo(0.74, 2);
    // A card with the gap of the window around it, at most 1120 by 860.
    const at = await box(editor);
    expect(at.width).toBe(1120);
    expect(at.height).toBe(784);
    expect(at.x).toBe(80);
    expect(at.y).toBe(8);
  });

  test("a big window does not stretch it past 1120 by 860", async ({ page }) => {
    await start(page, { width: 1600, height: 1000 });
    const at = await box(await openEditor(page, "noren-dusk"));
    expect(at.width).toBe(1120);
    expect(at.height).toBe(860);
  });

  for (const [alpha, opacity] of [
    [0.42, 0.3],
    [1, 0.88],
  ] as const) {
    test(`the fill follows the transparency of the interface: ${opacity} makes ${alpha}`, async ({
      page,
    }) => {
      await start(page, { appearance: `"window": { "opacity": ${opacity} }` });
      const editor = await openEditor(page, "noren-dusk");
      expect(parseColor(await style(editor, "background-color")).a).toBeCloseTo(alpha, 2);
    });
  }

  test("with prefers-reduced-transparency the card is solid and sharp, and keeps its shape", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    await expect.poll(async () => parseColor(await style(editor, "background-color")).a).toBe(1);
    expect(await style(editor, "backdrop-filter")).toBe("none");
    expect(await style(editor, "border-top-left-radius")).toBe("14px");
  });

  test("with the transparency effects of the system off the card is solid, and it comes back when they are on", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setSystemTransparencyReduced(true),
    );
    await expect.poll(async () => parseColor(await style(editor, "background-color")).a).toBe(1);
    expect(await style(editor, "backdrop-filter")).toBe("none");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setSystemTransparencyReduced(false),
    );
    await expect
      .poll(async () => parseColor(await style(editor, "background-color")).a)
      .toBeCloseTo(0.74, 2);
  });

  test("the dense style does not change: the old dialog, the name in its first group, the buttons under the boxes, a preview of 300 px", async ({
    page,
  }) => {
    await start(page, { style: "dense" });
    const editor = await openEditor(page, "noren-dusk");
    const at = await box(editor);
    expect(at.width).toBe(1040);
    expect(await style(editor, "display")).toBe("flex");
    expect(await style(editor, "backdrop-filter")).toBe("none");
    expect(parseFloat(await style(editor, "border-top-left-radius"))).toBeLessThanOrEqual(3);
    // The name is the first box of the first group, and no box of the header exists.
    await expect(group(editor, "general").locator('[data-nr-field="name"]')).toHaveCount(1);
    await expect(editor.locator(".theme-editor-name")).toHaveCount(0);
    await expect(editor.locator('[data-nr-part="theme-editor-contrast"]')).toHaveCount(0);
    // The hint is under the title, the buttons are under the body.
    const title = await box(editor.getByRole("heading", { name: "Theme editor", level: 2 }));
    const hint = await box(editor.locator(".theme-editor-hint"));
    const body = await box(editor.locator(".theme-editor-body"));
    const save = await box(editor.getByRole("button", { name: "Save as my theme", exact: true }));
    expect(hint.y).toBeGreaterThan(title.y);
    expect(hint.y).toBeLessThan(body.y);
    expect(save.y).toBeGreaterThan(body.y + body.height - 1);
    expect((await box(editor.locator(".tp-window"))).height).toBe(300);
    // The first group is the only one with its title read out: all nine are visible.
    await expect(editor.locator("fieldset.theme-editor-group > legend").first()).toBeVisible();
  });
});

test.describe("the header", () => {
  for (const [language, mode] of COMBOS) {
    test(`${language}, ${mode} theme: the title, the name in its box and the buttons share the band at the top`, async ({
      page,
    }) => {
      const words = WORDS[language];
      await start(page, { language, mode });
      const editor = await openEditor(page, THEME[mode], language);
      const card = await box(editor);
      const title = editor.getByRole("heading", { name: words.title, exact: true, level: 2 });
      expect(await style(title, "font-size")).toBe("18px");
      expect(await style(title, "font-weight")).toBe("600");
      // The name: a frame of 34 px and 9 px corners with its label inside and the box that is typed in.
      const frame = editor.locator(".theme-editor-name-box");
      expect(await style(frame, "height")).toBe("34px");
      expect(await style(frame, "border-top-left-radius")).toBe("9px");
      await expect(frame.locator("label")).toHaveText(words.name);
      await expect(frame.getByRole("textbox", { name: words.name, exact: true })).toBeVisible();
      // The title, the frame and every button are in the first 60 px of the card, and in this order.
      const cancel = editor.getByRole("button", { name: words.cancel, exact: true });
      const save = editor.getByRole("button", { name: words.save, exact: true });
      const parts = await Promise.all([box(title), box(frame), box(cancel), box(save)]);
      for (const part of parts) {
        expect(part.y).toBeGreaterThanOrEqual(card.y);
        expect(part.y + part.height).toBeLessThanOrEqual(card.y + 61);
      }
      expect(parts[0].x + parts[0].width).toBeLessThan(parts[1].x);
      expect(parts[1].x + parts[1].width).toBeLessThan(parts[2].x);
      expect(parts[2].x + parts[2].width).toBeLessThan(parts[3].x);
      // The buttons end 12 px from the right edge of the card.
      expect(card.x + card.width - 1 - (parts[3].x + parts[3].width)).toBeCloseTo(12, 0);
      // The header is 60 px and a line under it divides it from the body.
      const body = editor.locator(".theme-editor-body");
      expect((await box(body)).y - card.y).toBeCloseTo(61, 0);
    });
  }

  test("the buttons are 34 px with 9 px corners; the one that saves is filled with the highlight and its text is dark", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const cancel = editor.getByRole("button", { name: "Cancel", exact: true });
    const save = editor.getByRole("button", { name: "Save as my theme", exact: true });
    for (const button of [cancel, save]) {
      expect((await box(button)).height).toBe(34);
      expect(await style(button, "border-top-left-radius")).toBe("9px");
    }
    expect(parseColor(await style(cancel, "background-color")).a).toBe(0);
    expectSameColor(
      parseColor(await style(save, "background-color")),
      await highlight(page),
      "Save",
    );
    expect(await style(save, "color")).toBe("rgb(13, 15, 30)");
    expect(await style(save, "font-weight")).toBe("600");
  });

  test("a theme of the person has the two ways of saving in the header, the copy before the one that overwrites", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const editor = await openEditor(page, "mine");
    const names = ["Cancel", "Save as a new theme", "Save changes"];
    const boxes = await Promise.all(
      names.map((name) => box(editor.getByRole("button", { name, exact: true }))),
    );
    const card = await box(editor);
    for (const at of boxes) expect(at.y + at.height).toBeLessThanOrEqual(card.y + 61);
    expect(boxes[0]?.x).toBeLessThan((boxes[1] as { x: number }).x);
    expect((boxes[1] as { x: number }).x).toBeLessThan((boxes[2] as { x: number }).x);
    // The one that overwrites is the filled one.
    await expect(editor.getByRole("button", { name: "Save changes", exact: true })).toHaveClass(
      /primary/,
    );
  });

  test("the name is selected when the editor opens, and the frame shows where the keyboard is", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const input = nameBox(editor);
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([0, "Noren Dusk copy".length]);
    const frame = editor.locator(".theme-editor-name-box");
    expect(await style(frame, "outline-style")).toBe("solid");
    expect(await style(frame, "outline-width")).toBe("2px");
    expectSameColor(parseColor(await style(frame, "outline-color")), await highlight(page), "ring");
  });

  test("a name that is not valid says why under its frame, the header grows to hold it and Save waits", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const before = await box(editor.locator(".theme-editor-body"));
    await nameBox(editor).fill("");
    const alert = field(editor, "name").locator('[role="alert"]');
    await expect(alert).toBeVisible();
    const frame = await box(editor.locator(".theme-editor-name-box"));
    const line = await box(alert);
    expect(line.y).toBeGreaterThanOrEqual(frame.y + frame.height);
    const after = await box(editor.locator(".theme-editor-body"));
    expect(after.y).toBeGreaterThan(before.y);
    // The message stays inside the card and Save is held back.
    const card = await box(editor);
    expect(line.y + line.height).toBeLessThanOrEqual(card.y + card.height);
    await expect(
      editor.getByRole("button", { name: "Save as my theme", exact: true }),
    ).toBeDisabled();
    // The frame of the name takes the highlight for a line, so the problem is seen on the box.
    expectSameColor(
      parseColor(await style(editor.locator(".theme-editor-name-box"), "border-top-color")),
      await highlight(page),
      "frame of an invalid name",
    );
  });

  test("a long name does not push the buttons out of the card", async ({ page }) => {
    await start(page, { themes: [MINE], width: 900, height: 700 });
    const editor = await openEditor(page, "mine");
    await nameBox(editor).fill("A theme with a very long name that goes on and on and on and on");
    const card = await box(editor);
    for (const name of ["Cancel", "Save as a new theme", "Save changes"]) {
      const at = await box(editor.getByRole("button", { name, exact: true }));
      expect(at.x + at.width).toBeLessThanOrEqual(card.x + card.width);
      expect(at.x).toBeGreaterThanOrEqual(card.x);
    }
  });
});

test.describe("the body: the preview and the column of boxes", () => {
  test("the preview takes the room on the left, the boxes are a column of 360 px on the right", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const card = await box(editor);
    const side = await box(editor.locator(".theme-editor-side"));
    const controls = await box(editor.locator(".theme-editor-controls"));
    expect(controls.width).toBeCloseTo(360, 0);
    expect(controls.x + controls.width).toBeCloseTo(card.x + card.width - 1, 0);
    expect(side.x).toBeLessThan(controls.x);
    expect(side.x + side.width).toBeCloseTo(controls.x, 0);
    expect(side.width).toBeGreaterThan(600);
    // Both columns are as tall as the body and scroll on their own.
    // (the body has a line of 1 px on top, which the columns do not cover)
    const body = await box(editor.locator(".theme-editor-body"));
    expect(Math.abs(side.height - body.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(controls.height - body.height)).toBeLessThanOrEqual(1);
  });

  test("the preview is the window the editor always drew, now filling its frame, over a night landscape", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const frame = editor.locator('[data-nr-part="theme-preview"]');
    const windowBox = await box(editor.locator(".tp-window"));
    const frameBox = await box(frame);
    // The window fills the frame but for its padding of 12 px, and is taller than it was (300 px).
    expect(windowBox.width).toBeCloseTo(frameBox.width - 24 - 2, 0);
    expect(windowBox.height).toBeGreaterThan(300);
    expect(frameBox.height).toBeGreaterThan(340);
    // The landscape: the sky of the design with the ridge and the moon drawn over it.
    expect(await style(frame, "background-color")).toBe("rgb(38, 43, 92)");
    expect(await style(frame, "background-color", "::before")).toBe("rgb(74, 52, 116)");
    expect(await style(frame, "background-color", "::after")).toBe("rgb(241, 230, 204)");
    expect(await style(frame, "width", "::after")).toBe("70px");
    expect(await style(frame, "border-top-left-radius")).toBe("12px");
    // Still a picture that says nothing to a screen reader.
    await expect(frame).toHaveAttribute("aria-hidden", "true");
  });

  for (const language of ["en", "pt-BR"] as const) {
    test(`${language}: the head of the preview has its title, the hint and the contrast of the text, which holds with the theme as it is`, async ({
      page,
    }) => {
      const words = WORDS[language];
      await start(page, { language });
      const editor = await openEditor(page, "noren-dusk", language);
      const head = editor.locator(".theme-editor-side-head");
      await expect(head.getByRole("heading", { name: words.preview, exact: true })).toBeVisible();
      const badge = editor.locator('[data-nr-part="theme-editor-contrast"]');
      await expect(badge).toHaveText(words.contrast("14.5"));
      await expect(badge).toHaveAttribute("data-nr-state", "ok");
      // The badge is a pill of 12 px type with a mark in it.
      expect(await style(badge, "font-size")).toBe("12px");
      expect(parseFloat(await style(badge, "border-top-left-radius"))).toBeGreaterThan(9);
      await expect(badge.locator("svg")).toHaveCount(1);
    });
  }

  test("the contrast follows the colors as they are typed and turns amber under the minimum the editor warns about", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const badge = editor.locator('[data-nr-part="theme-editor-contrast"]');
    await editor.getByRole("textbox", { name: "Text", exact: true }).fill("#ffffff");
    await editor.getByRole("textbox", { name: "Background", exact: true }).fill("#000000");
    await expect(badge).toHaveText("Text contrast 21.0 : 1");
    await expect(badge).toHaveAttribute("data-nr-state", "ok");
    const green = await style(badge, "background-color");
    await editor.getByRole("textbox", { name: "Text", exact: true }).fill("#222222");
    await expect(badge).toHaveText("Text contrast 1.3 : 1");
    await expect(badge).toHaveAttribute("data-nr-state", "low");
    // The note under the preview says the same in words, and the pill changed its color.
    await expect(editor.locator('[data-nr-note="text"]')).toBeVisible();
    expect(await style(badge, "background-color")).not.toBe(green);
    // A half-typed value does not move it: the theme is as it was.
    await editor.getByRole("textbox", { name: "Text", exact: true }).fill("#22");
    await expect(badge).toHaveText("Text contrast 1.3 : 1");
  });
});

test.describe("the boxes of the groups", () => {
  test("a color is one box of 30 px with the swatch of 22 px and the hex value in the mono type", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const color = field(editor, "ui.accent");
    const frame = color.locator(".theme-color-boxes");
    expect(await style(frame, "height")).toBe("30px");
    expect(await style(frame, "border-top-left-radius")).toBe("8px");
    const swatch = color.locator("input.theme-swatch");
    const at = await box(swatch);
    expect([at.width, at.height]).toEqual([22, 22]);
    expect(await style(swatch, "border-top-left-radius")).toBe("6px");
    const hex = color.getByRole("textbox", { name: "Accent", exact: true });
    expect(await style(hex, "font-size")).toBe("12px");
    expect(await style(hex, "font-family")).toContain("Geist Mono");
    expect(await style(hex, "border-top-width")).toBe("0px");
    // The label is on the left and the box is at the right end of the column.
    const label = await box(color.locator("label"));
    const frameAt = await box(frame);
    const column = await box(editor.locator(".theme-editor-controls"));
    expect(label.x + label.width).toBeLessThan(frameAt.x);
    expect(column.x + column.width - 18 - (frameAt.x + frameAt.width)).toBeCloseTo(0, 0);
  });

  test("the swatch is painted with the color of the theme", async ({ page }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const ui = NOREN_DUSK.ui;
    for (const [name, hex] of [
      ["ui.accent", ui.accent],
      ["ui.bg", ui.bg],
      ["ui.text", ui.text],
    ] as const) {
      const swatch = field(editor, name).locator("input.theme-swatch");
      const pixels = readPixels(await swatch.screenshot());
      const [r, g, b] = pixels.at(Math.floor(pixels.width / 2), Math.floor(pixels.height / 2));
      expect([r, g, b], name).toEqual([
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ]);
    }
    // Typing a color repaints it.
    await editor.getByRole("textbox", { name: "Accent", exact: true }).fill("#ff0000");
    const pixels = readPixels(
      await field(editor, "ui.accent").locator("input.theme-swatch").screenshot(),
    );
    expect(pixels.at(Math.floor(pixels.width / 2), Math.floor(pixels.height / 2))).toEqual([
      255, 0, 0,
    ]);
  });

  test("the sixteen colors are eight rows of a name and two boxes, in the same two columns", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const rows = editor.locator(".theme-palette-row");
    await expect(rows).toHaveCount(8);
    const cells = await rows.evaluateAll((elements) =>
      elements.map((element) =>
        [...element.querySelectorAll<HTMLElement>(".theme-color-boxes")].map((cell) => {
          const at = cell.getBoundingClientRect();
          return [Math.round(at.left), Math.round(at.width), Math.round(at.top)];
        }),
      ),
    );
    for (const row of cells) {
      expect(row).toHaveLength(2);
      // Every row has its boxes where the first one has them and as wide.
      expect(row[0]?.[0]).toBe(cells[0]?.[0]?.[0]);
      expect(row[1]?.[0]).toBe(cells[0]?.[1]?.[0]);
      expect(row[0]?.[1]).toBe(row[1]?.[1]);
      expect(Math.abs((row[0]?.[2] ?? 0) - (row[1]?.[2] ?? 99))).toBeLessThanOrEqual(1);
    }
    // Nothing of it reaches past the column.
    const overflow = await editor
      .locator(".theme-editor-controls")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("a number with a range is its label, a slider and its number: three columns that line up in every group", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const rows = [
      ["font.size", "Size (px)"],
      ["font.lineHeight", "Line height"],
      ["ui.radius", "Corner radius (px)"],
      ["ui.opacity", "Panel opacity"],
      ["ui.blur", "Panel blur (px)"],
      ["background.opacity", "Picture opacity"],
      ["background.blur", "Picture blur (px)"],
    ] as const;
    const columns: number[][] = [];
    for (const [name, label] of rows) {
      const holder = field(editor, name);
      await holder.scrollIntoViewIfNeeded();
      const text = await box(holder.locator(".settings-option > span"));
      const slider = await box(
        holder.getByRole("slider", { name: `${label}, slider`, exact: true }),
      );
      const number = holder.getByRole("textbox", { name: label, exact: true });
      const numberAt = await box(number);
      expect(numberAt.width, name).toBe(48);
      expect(await style(number, "font-family"), name).toContain("Geist Mono");
      expect(await style(number, "text-align"), name).toBe("right");
      expect(text.x + text.width, name).toBeLessThanOrEqual(slider.x);
      expect(slider.x + slider.width, name).toBeLessThanOrEqual(numberAt.x);
      columns.push([Math.round(text.x), Math.round(slider.x), Math.round(numberAt.x)]);
    }
    // One left edge for the labels, one for the sliders and one for the numbers.
    for (const row of columns) expect(row).toEqual(columns[0]);
  });

  test("the track of a slider is filled with the highlight up to the handle, and not past it", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const slider = editor.getByRole("slider", { name: "Corner radius (px), slider", exact: true });
    await slider.scrollIntoViewIfNeeded();
    const [min, max] = await slider.evaluate((el: HTMLInputElement) => [
      Number(el.min),
      Number(el.max),
    ]);
    await slider.fill(String((Number(min) + Number(max)) / 2));
    const pixels = readPixels(await slider.screenshot());
    const y = Math.floor(pixels.height / 2);
    const wanted = await highlight(page);
    const left = pixels.at(Math.floor(pixels.width * 0.2), y);
    expectSameColor({ r: left[0], g: left[1], b: left[2], a: 1 }, wanted, "filled part");
    const right = pixels.at(Math.floor(pixels.width * 0.8), y);
    expect(
      Math.abs(right[0] - wanted.r) + Math.abs(right[1] - wanted.g) + Math.abs(right[2] - wanted.b),
    ).toBeGreaterThan(60);
    // The number moved with it.
    await expect(
      editor.getByRole("textbox", { name: "Corner radius (px)", exact: true }),
    ).toHaveValue(String((Number(min) + Number(max)) / 2));
  });

  test("the number at the end of a slider is still a box: typing in it moves the slider and the preview", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    await editor.getByRole("textbox", { name: "Corner radius (px)", exact: true }).fill("0");
    await expect(
      editor.getByRole("slider", { name: "Corner radius (px), slider", exact: true }),
    ).toHaveValue("0");
    expect(await style(editor.locator(".tp-window"), "border-top-left-radius")).toBe("0px");
    await editor
      .getByRole("slider", { name: "Corner radius (px), slider", exact: true })
      .fill("20");
    expect(await style(editor.locator(".tp-window"), "border-top-left-radius")).toBe("20px");
  });

  test("the switch of the ligatures is the one of the design: 40 by 24, a knob of 20, the highlight when on", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const editor = await openEditor(page, "mine");
    const ligatures = editor.getByRole("switch", { name: "Ligatures", exact: true });
    await ligatures.scrollIntoViewIfNeeded();
    // MINE has them off.
    await expect(ligatures).not.toBeChecked();
    const at = await box(ligatures);
    expect([at.width, at.height]).toEqual([40, 24]);
    expect(await style(ligatures, "border-top-width")).toBe("0px");
    expect(await style(ligatures, "border-top-left-radius")).toBe("99px");
    expect(await style(ligatures, "width", "::after")).toBe("20px");
    expect(await style(ligatures, "height", "::after")).toBe("20px");
    expect(await style(ligatures, "left", "::after")).toBe("2px");
    expect(await style(ligatures, "transform", "::after")).toBe("none");
    const off = parseColor(await style(ligatures, "background-color"));
    await ligatures.click();
    await expect(ligatures).toBeChecked();
    // The track changes color in 120 ms: wait for it to be the highlight.
    await expect.poll(async () => parseColor(await style(ligatures, "background-color")).a).toBe(1);
    expectSameColor(
      parseColor(await style(ligatures, "background-color")),
      await highlight(page),
      "on",
    );
    // The knob slides in 120 ms: wait for it to be where the design puts it.
    await expect
      .poll(() => style(ligatures, "transform", "::after"))
      .toBe("matrix(1, 0, 0, 1, 16, 0)");
    expect(parseColor(await style(ligatures, "background-color")).a).toBe(1);
    expect(off.a).toBeLessThan(1);
    // The preview follows, and the keyboard turns it as well.
    expect(await style(editor.locator(".tp-terminal"), "font-variant-ligatures")).toBe("normal");
    await ligatures.focus();
    await page.keyboard.press("Space");
    await expect(ligatures).not.toBeChecked();
    expect(await style(editor.locator(".tp-terminal"), "font-variant-ligatures")).toBe("none");
    // The label is on the left of the row and the switch at its right end.
    const label = await box(editor.locator(".settings-toggle > .settings-option > span"));
    const column = await box(editor.locator(".theme-editor-controls"));
    expect(label.x + label.width).toBeLessThan(at.x);
    expect(column.x + column.width - 18 - (at.x + at.width)).toBeCloseTo(0, 0);
  });

  test("finding 352: the switch of the editor has its size in the dense style too (it was 2 by 2 px)", async ({
    page,
  }) => {
    await start(page, { style: "dense", themes: [MINE] });
    const editor = await openEditor(page, "mine");
    const ligatures = editor.getByRole("switch", { name: "Ligatures", exact: true });
    await ligatures.scrollIntoViewIfNeeded();
    const at = await box(ligatures);
    expect([at.width, at.height]).toEqual([40, 24]);
    expect(await style(ligatures, "width", "::after")).toBe("16px");
    expect(await style(ligatures, "height", "::after")).toBe("16px");
    await ligatures.click();
    await expect(ligatures).toBeChecked();
    await expect
      .poll(() => style(ligatures, "transform", "::after"))
      .toBe("matrix(1, 0, 0, 1, 16, 0)");
  });

  test("the kind of the theme is a row with a label and a track of two buttons, the chosen one lit", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const dark = editor.getByRole("radio", { name: "Dark", exact: true });
    const light = editor.getByRole("radio", { name: "Light", exact: true });
    await expect(dark).toBeChecked();
    const track = editor.locator(".theme-editor-kinds");
    expect(await style(track, "padding-top")).toBe("3px");
    const lit = dark.locator("xpath=..");
    const quiet = light.locator("xpath=..");
    expect((await box(lit)).height).toBe(30);
    expect(parseColor(await style(lit, "background-color")).a).toBeGreaterThan(0);
    expect(parseColor(await style(quiet, "background-color")).a).toBe(0);
    // The arrow keys move the choice and the lit button follows.
    await dark.focus();
    await page.keyboard.press("ArrowRight");
    await expect(light).toBeChecked();
    expect(parseColor(await style(quiet, "background-color")).a).toBeGreaterThan(0);
    expect(parseColor(await style(lit, "background-color")).a).toBe(0);
    // The row says Kind on the left and the track is at the right end.
    const label = await box(editor.locator(".theme-editor-kind > span").first());
    const trackAt = await box(track);
    expect(label.x + label.width).toBeLessThan(trackAt.x);
  });

  test("the first group has no title on the page (its row says Kind), the other eight have theirs at 13 px", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const legends = editor.locator("fieldset.theme-editor-group > legend");
    await expect(legends).toHaveCount(9);
    const sizes = await legends.evaluateAll((elements) =>
      elements.map((element) => {
        const at = element.getBoundingClientRect();
        return [at.width, at.height, getComputedStyle(element).fontSize];
      }),
    );
    expect(sizes[0]?.[0]).toBeLessThanOrEqual(1);
    expect(sizes[0]?.[1]).toBeLessThanOrEqual(1);
    for (const size of sizes.slice(1)) {
      expect(size[2]).toBe("13px");
      expect(size[0]).toBeGreaterThan(20);
    }
    // The title is still there for a screen reader.
    await expect(legends.first()).toHaveText("Name and kind");
  });

  test("the box of the font names is the width of the column, 30 px high with the corners of the other boxes", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const names = editor.getByRole("textbox", { name: "Font names", exact: true });
    await names.scrollIntoViewIfNeeded();
    const at = await box(names);
    const column = await box(editor.locator(".theme-editor-controls"));
    expect(at.height).toBe(30);
    expect(at.width).toBeCloseTo(column.width - 18 * 2 - 1, 0);
    expect(await style(names, "border-top-left-radius")).toBe("8px");
    await names.focus();
    expect(await style(names, "outline-style")).toBe("solid");
  });

  test("the picture is a card with its miniature, the name of the file and its two buttons", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const editor = await openEditor(page, "mine");
    const card = editor.locator('[data-nr-part="background-picker"]');
    await card.scrollIntoViewIfNeeded();
    expect(await style(card, "border-top-left-radius")).toBe("10px");
    const thumb = await box(card.locator('[data-nr-part="background-thumbnail-frame"]'));
    expect([thumb.width, thumb.height]).toEqual([54, 36]);
    await expect(card.locator('[data-nr-part="background-picker-name"]')).toHaveText(
      "background.png",
    );
    const buttons = ["Choose image…", "Remove"];
    const ats = await Promise.all(
      buttons.map((name) => box(card.getByRole("button", { name, exact: true }))),
    );
    for (const at of ats) expect(at.height).toBe(30);
    // The buttons are side by side under the miniature and the name, inside the card.
    expect(ats[0]?.y).toBeCloseTo(ats[1]?.y ?? 0, 0);
    expect(ats[0]?.y).toBeGreaterThan(thumb.y + thumb.height - 1);
    const cardAt = await box(card);
    for (const at of ats) {
      expect(at.x + at.width).toBeLessThanOrEqual(cardAt.x + cardAt.width);
    }
    // The chooser fills the box of the path, and Remove empties it.
    await page.evaluate((p) => (window as HookWindow).__norenTest?.setImagePick(p), PICTURE);
    await card.getByRole("button", { name: "Choose image…", exact: true }).click();
    await expect(editor.getByRole("textbox", { name: "Picture path", exact: true })).toHaveValue(
      PICTURE,
    );
    await card.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(editor.getByRole("textbox", { name: "Picture path", exact: true })).toHaveValue(
      "",
    );
    await expect(card.locator('[data-nr-part="background-picker-name"]')).toHaveText("");
  });

  test("the buttons of the picture are 30 px with 8 px corners and the one that chooses is tinted with the highlight", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    const choose = editor.getByRole("button", { name: "Choose image…", exact: true });
    const remove = editor.getByRole("button", { name: "Remove", exact: true });
    await choose.scrollIntoViewIfNeeded();
    for (const button of [choose, remove]) {
      expect((await box(button)).height).toBe(30);
      expect(await style(button, "border-top-left-radius")).toBe("8px");
    }
    expectSameColor(
      parseColor(await style(choose, "border-top-color")),
      await highlight(page),
      "choose",
    );
    // Remove has nothing to remove while there is no picture.
    await expect(remove).toBeDisabled();
  });
});

test.describe("editing, saving and cancelling", () => {
  test("what is edited shows in the preview at once, and Save writes the theme with it", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    await nameBox(editor).fill("Glass copy");
    await editor.getByRole("textbox", { name: "Accent", exact: true }).fill("#ff0000");
    await editor.getByRole("textbox", { name: "Corner radius (px)", exact: true }).fill("6");
    await editor.getByRole("switch", { name: "Ligatures", exact: true }).uncheck();
    const preview = editor.locator('[data-nr-part="theme-preview"]');
    expect(await preview.evaluate((el) => el.style.getPropertyValue("--tp-accent"))).toBe(
      "#ff0000",
    );
    expect(await style(editor.locator(".tp-window"), "border-top-left-radius")).toBe("6px");
    // Nothing is written until Save.
    expect(await themeFiles(page)).toEqual({});
    await editor.getByRole("button", { name: "Save as my theme", exact: true }).click();
    await expect(editorOf(page)).toHaveCount(0);
    const files = await themeFiles(page);
    expect(Object.keys(files)).toEqual(["glass-copy"]);
    const saved = JSON.parse(files["glass-copy"] as string) as Theme;
    expect(saved.name).toBe("Glass copy");
    expect(saved.ui.accent).toBe("#ff0000");
    expect(saved.ui.radius).toBe(6);
    expect(saved.font.ligatures).toBe(false);
    // The rest of the theme is the one it started from.
    expect(saved.ui.bg).toBe(NOREN_DUSK.ui.bg);
    expect(saved.terminal.ansi).toEqual(NOREN_DUSK.terminal.ansi);
  });

  test("Cancel and Escape write nothing and give the settings back", async ({ page }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    await editor.getByRole("textbox", { name: "Accent", exact: true }).fill("#00ff00");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editorOf(page)).toHaveCount(0);
    expect(await themeFiles(page)).toEqual({});
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    // The same with Escape.
    await page
      .locator('[data-nr-part="theme-card"][data-nr-theme="noren-dusk"] [data-nr-action="edit"]')
      .click();
    await expect(editorOf(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editorOf(page)).toHaveCount(0);
    expect(await themeFiles(page)).toEqual({});
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  });

  test("a theme of the person: Save changes writes over it, Save as a new theme adds another", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    let editor = await openEditor(page, "mine");
    await editor.getByRole("textbox", { name: "Accent", exact: true }).fill("#112233");
    await editor.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(editorOf(page)).toHaveCount(0);
    let files = await themeFiles(page);
    expect(Object.keys(files)).toEqual(["mine"]);
    expect((JSON.parse(files["mine"] as string) as Theme).ui.accent).toBe("#112233");
    editor = editorOf(page);
    await page
      .locator('[data-nr-part="theme-card"][data-nr-theme="mine"] [data-nr-action="edit"]')
      .click();
    await expect(editor).toBeVisible();
    await nameBox(editor).fill("Mine two");
    await editor.getByRole("button", { name: "Save as a new theme", exact: true }).click();
    await expect(editorOf(page)).toHaveCount(0);
    files = await themeFiles(page);
    expect(Object.keys(files).sort()).toEqual(["mine", "mine-two"]);
  });

  test("a box that is not valid keeps Save held back, says why under itself and the strip under the body says to fix it", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    await editor.getByRole("textbox", { name: "Accent", exact: true }).fill("#12");
    await expect(
      editor.getByRole("button", { name: "Save as my theme", exact: true }),
    ).toBeDisabled();
    const hint = editor.locator('[data-nr-part="theme-editor-fix"]');
    await expect(hint).toBeVisible();
    const card = await box(editor);
    const body = await box(editor.locator(".theme-editor-body"));
    const strip = await box(hint);
    // The strip is under the body, inside the card, as wide as the card.
    expect(strip.y).toBeGreaterThanOrEqual(body.y + body.height - 1);
    expect(strip.y + strip.height).toBeLessThanOrEqual(card.y + card.height);
    expect(strip.x).toBeGreaterThanOrEqual(card.x);
    const problem = field(editor, "ui.accent").locator('[role="alert"]');
    await expect(problem).toBeVisible();
    const frame = await box(field(editor, "ui.accent").locator(".theme-color-boxes"));
    expect((await box(problem)).y).toBeGreaterThanOrEqual(frame.y + frame.height - 1);
    expect(
      await style(field(editor, "ui.accent").locator(".theme-color-boxes"), "border-top-color"),
    ).not.toBe("rgba(0, 0, 0, 0)");
    await editor.getByRole("textbox", { name: "Accent", exact: true }).fill("#123456");
    await expect(hint).toHaveCount(0);
    await expect(
      editor.getByRole("button", { name: "Save as my theme", exact: true }),
    ).toBeEnabled();
  });
});

test.describe("the keyboard", () => {
  test("Tab goes from the name to the boxes of the groups first and the buttons come last, as in a dialog", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    await expect(nameBox(editor)).toBeFocused();
    await page.keyboard.press("Tab");
    // The kind of the theme is the first box of the column.
    await expect(editor.getByRole("radio", { name: "Dark", exact: true })).toBeFocused();
    // Shift+Tab goes back to the name.
    await page.keyboard.press("Shift+Tab");
    await expect(nameBox(editor)).toBeFocused();
    // The order of the page is the order of the keyboard: the name, every box of the column, Cancel, Save.
    const order = await editor.evaluate((root) => {
      const stops = [
        ...root.querySelectorAll<HTMLElement>("input, button, select, textarea, [tabindex]"),
      ].filter((el) => !(el as HTMLInputElement).disabled && el.tabIndex >= 0);
      const label = (el: HTMLElement) =>
        el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.id;
      const at = (text: string) => stops.findIndex((el) => label(el) === text);
      return {
        name: stops.findIndex((el) => el.closest(".theme-editor-name") !== null),
        firstBox: stops.findIndex((el) => el.closest(".theme-editor-controls") !== null),
        lastBox: stops.map((el) => el.closest(".theme-editor-controls") !== null).lastIndexOf(true),
        cancel: at("Cancel"),
        save: at("Save as my theme"),
        total: stops.length,
      };
    });
    expect(order.name).toBe(0);
    expect(order.firstBox).toBe(1);
    expect(order.lastBox).toBeLessThan(order.cancel);
    expect(order.cancel).toBeLessThan(order.save);
    expect(order.save).toBe(order.total - 1);
  });

  test("every control shows a ring in the color of the highlight when the keyboard is on it", async ({
    page,
  }) => {
    await start(page, { themes: [MINE] });
    const editor = await openEditor(page, "mine");
    const wanted = await highlight(page);
    const ring = async (locator: Locator, label: string, target: Locator = locator) => {
      await locator.scrollIntoViewIfNeeded();
      await locator.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(locator, label).toBeFocused();
      expect(await style(target, "outline-style"), label).toBe("solid");
      expectSameColor(parseColor(await style(target, "outline-color")), wanted, label);
    };
    await ring(editor.getByRole("button", { name: "Cancel", exact: true }), "Cancel");
    await ring(editor.getByRole("switch", { name: "Ligatures", exact: true }), "switch");
    await ring(
      editor.getByRole("slider", { name: "Corner radius (px), slider", exact: true }),
      "slider",
    );
    await ring(
      editor.getByRole("textbox", { name: "Accent", exact: true }),
      "hex box",
      field(editor, "ui.accent").locator(".theme-color-boxes"),
    );
  });
});

test.describe("narrow windows", () => {
  for (const [language, width, height] of [
    ["en", 820, 560],
    ["pt-BR", 820, 560],
    ["en", 720, 560],
    ["pt-BR", 720, 560],
  ] as const) {
    test(`${language} at ${width} by ${height}: the card fits, the buttons are in sight, the preview goes above the boxes and nothing sticks out`, async ({
      page,
    }) => {
      const words = WORDS[language];
      await start(page, { language, themes: [MINE], width, height });
      const editor = await openEditor(page, "mine", language);
      const card = await box(editor);
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.y).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width).toBeLessThanOrEqual(width);
      expect(card.y + card.height).toBeLessThanOrEqual(height);
      for (const name of [words.cancel, words.saveCopy, words.saveChanges]) {
        await expect(editor.getByRole("button", { name, exact: true })).toBeInViewport({
          ratio: 1,
        });
      }
      await expect(nameBox(editor, language)).toBeInViewport({ ratio: 1 });
      // The preview is above the boxes and the body scrolls as one.
      const side = await box(editor.locator(".theme-editor-side"));
      const controls = await box(editor.locator(".theme-editor-controls"));
      expect(side.y + side.height).toBeLessThanOrEqual(controls.y + 1);
      const body = editor.locator(".theme-editor-body");
      const scrolls = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(scrolls).toBeGreaterThan(0);
      // Nothing is wider than its column: no sideways scroll anywhere in the card.
      for (const selector of [
        ".theme-editor-body",
        ".theme-editor-controls",
        ".theme-editor-side",
      ]) {
        const wide = await editor
          .locator(selector)
          .evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(wide, selector).toBeLessThanOrEqual(1);
      }
      // No label, box or button is wider than the box that holds it.
      const over = await editor.evaluate((root) => {
        const bad: string[] = [];
        const rootAt = root.getBoundingClientRect();
        for (const element of root.querySelectorAll<HTMLElement>(
          "label, input, button, legend, .settings-hint, p",
        )) {
          const at = element.getBoundingClientRect();
          if (at.width === 0) continue;
          if (at.right > rootAt.right + 1 || at.left < rootAt.left - 1) {
            bad.push(`${element.tagName} ${element.textContent?.slice(0, 30) ?? ""}`);
          }
        }
        return bad;
      });
      expect(over).toEqual([]);
      // The last group can be reached by scrolling the body.
      await group(editor, "picture").scrollIntoViewIfNeeded();
      await expect(group(editor, "picture")).toBeInViewport({ ratio: 0.5 });
    });
  }

  test("a window of 1280 by 720: the card fits, and the two columns scroll on their own", async ({
    page,
  }) => {
    await start(page, { width: 1280, height: 720 });
    const editor = await openEditor(page, "noren-dusk");
    const card = await box(editor);
    expect(card.height).toBe(704);
    const controls = editor.locator(".theme-editor-controls");
    const scrolls = await controls.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(scrolls).toBeGreaterThan(0);
    // The groups come one under the other and none overlaps the next.
    const tops = await editor.locator(".theme-editor-controls > fieldset").evaluateAll((elements) =>
      elements.map((element) => {
        const at = element.getBoundingClientRect();
        return [at.top, at.bottom];
      }),
    );
    expect(tops).toHaveLength(9);
    for (let at = 1; at < tops.length; at++) {
      expect((tops[at] as number[])[0]).toBeGreaterThanOrEqual(
        (tops[at - 1] as number[])[1] as number,
      );
    }
  });
});

test.describe("accessibility", () => {
  for (const [language, mode] of COMBOS) {
    test(`axe: the editor of a theme that ships with the app, in ${language} and the ${mode} theme, has no violation`, async ({
      page,
    }) => {
      await start(page, { language, mode });
      await openEditor(page, THEME[mode], language);
      await expectNoAxeViolations(page, `glass theme editor (${language}, ${mode})`);
    });

    test(`axe: with a picture, in ${language} and the ${mode} theme`, async ({ page }) => {
      await start(page, { language, mode, themes: [MINE] });
      const editor = await openEditor(page, "mine", language);
      await expect(editor.locator('[data-nr-part="theme-preview"]')).toHaveAttribute(
        "data-nr-picture",
        "shown",
      );
      await expectNoAxeViolations(page, `glass theme editor with a picture (${language}, ${mode})`);
    });

    test(`axe: with problems and the notes about contrast, in ${language} and the ${mode} theme`, async ({
      page,
    }) => {
      const words = WORDS[language];
      await start(page, { language, mode });
      const editor = await openEditor(page, THEME[mode], language);
      await editor.getByRole("textbox", { name: words.accent, exact: true }).fill("#12");
      await editor.getByRole("textbox", { name: words.radius, exact: true }).fill("99");
      await editor
        .getByRole("textbox", { name: words.text, exact: true })
        .fill(mode === "dark" ? NOREN_DUSK.ui.bg : "#f6f3ec");
      await nameBox(editor, language).fill("");
      await expect(editor.locator('[data-nr-note="text"]')).toBeVisible();
      await expect(editor.locator('[data-nr-part="theme-editor-contrast"]')).toHaveAttribute(
        "data-nr-state",
        "low",
      );
      await expectNoAxeViolations(page, `glass theme editor with problems (${language}, ${mode})`);
    });
  }

  test("axe: the editor with the transparency effects of the system off, in the light theme", async ({
    page,
  }) => {
    await start(page, { mode: "light" });
    await openEditor(page, "noren-paper");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setSystemTransparencyReduced(true),
    );
    await expect
      .poll(async () => parseColor(await style(editorOf(page), "background-color")).a)
      .toBe(1);
    await expectNoAxeViolations(page, "glass theme editor, transparency off");
  });

  test("the dialog is modal and named for what it is, the preview is left out of what a screen reader reads, and the name box has its label", async ({
    page,
  }) => {
    await start(page);
    const editor = await openEditor(page, "noren-dusk");
    await expect(editor).toHaveAttribute("aria-modal", "true");
    await expect(editor.locator('[data-nr-part="theme-preview"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(editor.getByRole("heading", { name: "Preview", exact: true })).toBeVisible();
    await expect(editor.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(1);
    // The marks of the contrast badge are decoration.
    await expect(editor.locator('[data-nr-part="theme-editor-contrast"] svg')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
