import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { NOREN_DUSK, NOREN_PAPER } from "../packages/model/src/builtin-themes";
import { contrastRatio } from "../packages/model/src/theme";
import { expectNoAxeViolations } from "./axe-fixture";
import { readPixels } from "./png-pixels";
import { GLASS_GAP, configText, openSettings, seedConfig } from "./settings-fixture";
import { SPLIT_FIXTURE, seedSidebarState } from "./sidebar-fixture";

// The surfaces of the glass style (NOR-F20-18a, the default style): the window behind everything (the
// illustrated backdrop, or the picture of the person), the sidebar and the panes as cards of glass with
// a blur, a line and a gap between them, the color of the space as the highlight, the controls of the
// settings that move the glass at once, opaque panels with `prefers-reduced-transparency` and with the
// Windows switch of transparency effects off, and text that stays at 4.5:1 over the glass whatever the
// picture is. The dense style keeps its flat look. The numbers are the ones of the design
// (`vidro-janela`): 14 px and 12 px corners, an 8 px gap, a line at 8%, blur(30px) saturate(160%) and
// blur(24px), the sidebar 0.2 less opaque than the panels (0.62).

interface Hook {
  paneIds(): string[];
  setSystemTransparencyReduced(reduced: boolean): void;
  backendCalls(methods: string[]): string[];
  windowEffectCalls(): { effect: string; scheme: string }[];
}
type HookWindow = Window & { __norenTest?: Hook };

type Mode = "dark" | "light";
const THEME: Record<Mode, typeof NOREN_DUSK> = { dark: NOREN_DUSK, light: NOREN_PAPER };

const WEB_IMAGES_KEY = "noren.web.images";
const WEB_WINDOW_EFFECTS_KEY = "noren.web.window-effects";

/** A computed color as 0 to 255 channels and an alpha, whichever form the browser writes it in. */
interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(css: string): Color {
  const value = css.trim();
  // `color(srgb 0.9 0.9 0.8 / 0.42)`: channels from 0 to 1.
  const srgb = /^color\(srgb ([0-9.]+) ([0-9.]+) ([0-9.]+)(?: \/ ([0-9.]+))?\)$/.exec(value);
  if (srgb !== null) {
    const [, r, g, b, a] = srgb;
    return {
      r: Number(r) * 255,
      g: Number(g) * 255,
      b: Number(b) * 255,
      a: a === undefined ? 1 : Number(a),
    };
  }
  // `rgb(20, 22, 27)`, `rgba(20, 22, 27, 0.6)` and `rgb(20 22 27 / 0.6)`.
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

const hex = (color: { r: number; g: number; b: number }): string =>
  `#${[color.r, color.g, color.b]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;

/** The channels of a `#rrggbb` color. */
function channels(color: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(color.slice(1, 3), 16),
    g: parseInt(color.slice(3, 5), 16),
    b: parseInt(color.slice(5, 7), 16),
  };
}

function expectColor(actual: Color, expected: string, alpha: number, label: string): void {
  const want = channels(expected);
  // Within a step of rounding: the page works in 0 to 1 floats, the test in 0 to 255.
  expect(actual.r, `${label} red`).toBeCloseTo(want.r, -0.5);
  expect(actual.g, `${label} green`).toBeCloseTo(want.g, -0.5);
  expect(actual.b, `${label} blue`).toBeCloseTo(want.b, -0.5);
  expect(actual.a, `${label} alpha`).toBeCloseTo(alpha, 2);
}

/** A solid picture of 16 by 16 pixels, a PNG made here (the worst a picture can be: white or black). */
function solidPng(color: string): Buffer {
  const { r, g, b } = channels(color);
  const size = 16;
  const row = Buffer.concat([
    Buffer.from([0]),
    ...Array.from({ length: size }, () => Buffer.from([r, g, b])),
  ]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buffer) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface StartOptions {
  lang?: "en" | "pt-BR";
  mode?: Mode;
  style?: "glass" | "dense";
  /** The rest of `appearance`, as JSON text: `"window": { ... }`, `"background": { ... }`. */
  appearance?: string;
  /** A picture the settings name as `pic.png`: its colour. */
  picture?: string;
  /** The effects the (fake) system can paint. */
  effects?: string[];
  seed?: Parameters<typeof seedSidebarState>[1];
}

async function start(page: Page, options: StartOptions = {}): Promise<void> {
  const { lang = "en", mode = "dark", style = "glass" } = options;
  const appearance = [
    `"theme": "${THEME[mode].id}"`,
    `"style": "${style}"`,
    ...(options.picture !== undefined ? ['"background": { "image": "pic.png" }'] : []),
    ...(options.appearance !== undefined ? [options.appearance] : []),
  ].join(", ");
  await seedConfig(
    page,
    `{ ${lang === "pt-BR" ? '"language": "pt-BR", ' : ""}"appearance": { ${appearance} } }`,
  );
  if (options.picture !== undefined) {
    const images = { "pic.png": solidPng(options.picture).toString("base64") };
    await page.addInitScript(
      ({ key, value }) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      { key: WEB_IMAGES_KEY, value: JSON.stringify(images) },
    );
  }
  if (options.effects !== undefined) {
    await page.addInitScript(
      ({ key, value }) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      { key: WEB_WINDOW_EFFECTS_KEY, value: JSON.stringify(options.effects) },
    );
  }
  if (options.seed !== undefined) await seedSidebarState(page, options.seed);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
}

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/** One computed property of the first element a selector finds ("" for none). */
const styleOf = (
  page: Page,
  selector: string,
  property: string,
  pseudo?: string,
): Promise<string> =>
  page.evaluate(
    ({ selector: query, property: name, pseudo: after }) => {
      const element = document.querySelector(query);
      return element === null ? "" : getComputedStyle(element, after).getPropertyValue(name);
    },
    { selector, property, pseudo },
  );

const colorOf = async (page: Page, selector: string, property: string): Promise<Color> =>
  parseColor(await styleOf(page, selector, property));

const SIDEBAR = '[data-nr-part="sidebar"]';
const PANE = '[data-nr-part="pane"]';
const BACKDROP = '[data-nr-part="glass-backdrop"]';

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not on screen");
  return found;
};

for (const mode of ["dark", "light"] as const) {
  const theme = THEME[mode];

  test.describe(`the surfaces of the glass window, ${mode} theme`, () => {
    test("the window has the illustrated backdrop behind everything, and it is not content", async ({
      page,
    }) => {
      await start(page, { mode });
      const backdrop = page.locator(BACKDROP);
      await expect(backdrop).toHaveCount(1);
      await expect(backdrop).toHaveAttribute("aria-hidden", "true");
      expect(await styleOf(page, BACKDROP, "position")).toBe("fixed");
      expect(await styleOf(page, BACKDROP, "z-index")).toBe("-1");
      expect(await styleOf(page, BACKDROP, "pointer-events")).toBe("none");
      const at = await box(backdrop);
      const viewport = page.viewportSize();
      expect([at.x, at.y, at.width, at.height]).toEqual([0, 0, viewport?.width, viewport?.height]);
      // The picture of the design: a sky, a moon, stars and three ridges of hills, in the colors of the
      // kind of the theme (a night landscape under a dark theme, a pale one under a light theme).
      await expect(backdrop.locator(".glass-backdrop-sky")).toHaveCount(1);
      await expect(backdrop.locator(".glass-backdrop-moon")).toHaveCount(1);
      await expect(backdrop.locator(".glass-backdrop-star")).toHaveCount(6);
      await expect(backdrop.locator(".glass-backdrop-ridge")).toHaveCount(3);
      const sky = await colorOf(page, ".glass-backdrop-sky", "background-color");
      expect(hex(sky)).toBe(mode === "dark" ? "#1d2046" : "#eceffb");
      // Nothing is clickable through it: a click on the sidebar reaches the sidebar.
      expect(
        await page.evaluate(() => document.elementFromPoint(100, 300)?.closest("aside") !== null),
      ).toBe(true);
    });

    test("the sidebar is a card of glass: 14 px corners, a blur, a line, the glass of the style", async ({
      page,
    }) => {
      await start(page, { mode });
      expect(await styleOf(page, SIDEBAR, "border-top-left-radius")).toBe("14px");
      expect(await styleOf(page, SIDEBAR, "border-bottom-right-radius")).toBe("14px");
      expect(await styleOf(page, SIDEBAR, "border-top-width")).toBe("1px");
      expect(await styleOf(page, SIDEBAR, "backdrop-filter")).toBe("blur(30px) saturate(1.6)");
      // The fill is the surface of the theme, 0.42 of it (0.2 less than the panels); the line is the text
      // color at 8%.
      expectColor(await colorOf(page, SIDEBAR, "background-color"), theme.ui.surface, 0.42, "fill");
      expectColor(await colorOf(page, SIDEBAR, "border-top-color"), theme.ui.text, 0.08, "line");
    });

    test("the panes are cards of glass: 12 px corners, a blur, a line, the glass of the style", async ({
      page,
    }) => {
      await start(page, { mode });
      expect(await styleOf(page, PANE, "border-top-left-radius")).toBe("12px");
      expect(await styleOf(page, PANE, "border-bottom-right-radius")).toBe("12px");
      expect(await styleOf(page, PANE, "border-top-width")).toBe("1px");
      expect(await styleOf(page, PANE, "backdrop-filter")).toBe("blur(24px)");
      expect(await styleOf(page, PANE, "overflow")).toBe("hidden");
      expectColor(await colorOf(page, PANE, "background-color"), theme.ui.bg, 0.62, "fill");
      expectColor(await colorOf(page, PANE, "border-top-color"), theme.ui.text, 0.08, "line");
      // The terminal draws nothing of its own on the glass: its own paint is the color of the theme at 0.
      expect((await colorOf(page, ".xterm-scrollable-element", "background-color")).a).toBe(0);
      expect(parseColor(await styleOf(page, ".terminal-view", "background-color")).a).toBe(0);
    });

    test("the cards keep an 8 px gap from the window and from each other", async ({ page }) => {
      await start(page, { mode });
      const titlebar = await box(page.locator(".titlebar"));
      const side = await box(page.locator(SIDEBAR));
      const content = await box(page.getByRole("region", { name: "Content", exact: true }));
      const viewport = page.viewportSize() ?? { width: 0, height: 0 };
      expect(GLASS_GAP).toBe(8);
      // Around: the window, the title bar above.
      expect(side.x).toBe(GLASS_GAP);
      expect(side.y).toBe(titlebar.y + titlebar.height + GLASS_GAP);
      expect(viewport.height - (side.y + side.height)).toBe(GLASS_GAP);
      expect(viewport.width - (content.x + content.width)).toBe(GLASS_GAP);
      expect(viewport.height - (content.y + content.height)).toBe(GLASS_GAP);
      // Between: the sidebar and the panes.
      expect(content.x - (side.x + side.width)).toBe(GLASS_GAP);
    });

    test("the panes of a tab are cards with the gap between them", async ({ page }) => {
      await start(page, { mode, seed: { split: true } });
      await page
        .getByRole("tree", { name: "Tabs", exact: true })
        .getByRole("treeitem", { name: SPLIT_FIXTURE.title, exact: true })
        .click();
      const first = page.locator(`[data-pane-id="${SPLIT_FIXTURE.first}"]`);
      const second = page.locator(`[data-pane-id="${SPLIT_FIXTURE.second}"]`);
      await expect(first).toBeVisible();
      const a = await box(first);
      const b = await box(second);
      expect(b.x - (a.x + a.width)).toBeCloseTo(GLASS_GAP, 0);
      expect(a.y).toBeCloseTo(b.y, 0);
      // No pane is bigger than the panel that holds it: a panel is a scroll box, and a pane that spilled
      // over it (its line outside its box) drew a native scroll bar in the gap in the real app.
      const spill = await page.evaluate(() =>
        [...document.querySelectorAll(".split-panel")].map((panel) => ({
          x: panel.scrollWidth - panel.clientWidth,
          y: panel.scrollHeight - panel.clientHeight,
        })),
      );
      expect(spill.length).toBeGreaterThan(1);
      for (const one of spill) expect(one).toEqual({ x: 0, y: 0 });
      for (const selector of [first, second]) {
        expect(await selector.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe(
          "12px",
        );
      }
    });

    test("the title bar is a strip of the glass of the sidebar", async ({ page }) => {
      await start(page, { mode });
      expect(await styleOf(page, ".titlebar", "backdrop-filter")).toBe("blur(30px) saturate(1.6)");
      expectColor(
        await colorOf(page, ".titlebar", "background-color"),
        theme.ui.surface,
        0.42,
        "fill",
      );
    });
  });
}

test.describe("the dense style keeps its flat look", () => {
  test("no backdrop, no glass, no gap: solid panels against the edges", async ({ page }) => {
    await start(page, { style: "dense" });
    await expect(page.locator(BACKDROP)).toHaveCount(0);
    expect((await box(page.locator(SIDEBAR))).x).toBe(0);
    expect(await styleOf(page, SIDEBAR, "border-top-left-radius")).toBe("0px");
    expect(await styleOf(page, SIDEBAR, "backdrop-filter")).toBe("none");
    expect(await styleOf(page, PANE, "border-top-left-radius")).toBe("0px");
    expect(await styleOf(page, PANE, "backdrop-filter")).toBe("none");
    expect(await rootVar(page, "--nr-opacity")).toBe("1");
    expect((await colorOf(page, SIDEBAR, "background-color")).a).toBe(1);
    expect((await colorOf(page, ".xterm-scrollable-element", "background-color")).a).toBe(1);
  });

  test("changing the style in the file changes the surfaces at once, both ways", async ({
    page,
  }) => {
    await start(page, { style: "glass" });
    await expect(page.locator(BACKDROP)).toHaveCount(1);
    await page.evaluate(() =>
      (
        window as HookWindow & { __norenTest?: { setConfig(text: string): void } }
      ).__norenTest?.setConfig('{ "appearance": { "style": "dense" } }'),
    );
    await expect(page.locator(BACKDROP)).toHaveCount(0);
    expect((await box(page.locator(SIDEBAR))).x).toBe(0);
    await page.evaluate(() =>
      (
        window as HookWindow & { __norenTest?: { setConfig(text: string): void } }
      ).__norenTest?.setConfig('{ "appearance": { "style": "glass" } }'),
    );
    await expect(page.locator(BACKDROP)).toHaveCount(1);
    expect((await box(page.locator(SIDEBAR))).x).toBe(GLASS_GAP);
  });
});

test.describe("the highlight is the color of the space", () => {
  /** What `rgba(r, g, b, a)` of a ring should be for a `#rrggbb` highlight at 55%. */
  const ring = async (page: Page): Promise<Color> =>
    parseColor(await styleOf(page, '[data-nr-focused="true"]', "border-top-color", "::after"));

  test("--nr-highlight is the color of the active space, the ring of the focused pane is that color at 55%, and a space change moves both", async ({
    page,
  }) => {
    await start(page, { seed: { secondSpace: true, split: true } });
    await page
      .getByRole("tree", { name: "Tabs", exact: true })
      .getByRole("treeitem", { name: SPLIT_FIXTURE.title, exact: true })
      .click();
    await expect(page.locator('[data-nr-focused="true"]')).toHaveCount(1);
    // The space "Main" is blue in the saved workspace.
    expect(await rootVar(page, "--nr-highlight")).toBe("#6b8afd");
    expect(await rootVar(page, "--nr-space-color")).toBe("#6b8afd");
    const main = await ring(page);
    expectColor(main, "#6b8afd", 0.55, "ring of Main");
    // The ring is a border that follows the corners of the card.
    expect(await styleOf(page, '[data-nr-focused="true"]', "border-top-width", "::after")).toBe(
      "1px",
    );
    expect(
      await styleOf(page, '[data-nr-focused="true"]', "border-top-left-radius", "::after"),
    ).toBe("12px");

    await page
      .getByRole("navigation", { name: "Spaces", exact: true })
      .getByRole("button", { name: "Other", exact: true })
      .click();
    await expect.poll(() => rootVar(page, "--nr-highlight")).toBe("#e0a458");
    expect(await rootVar(page, "--nr-space-color")).toBe("#e0a458");
  });

  test("the highlight does not touch the colors of the theme", async ({ page }) => {
    await start(page, { mode: "dark" });
    expect(await rootVar(page, "--nr-accent")).toBe(NOREN_DUSK.ui.accent);
    expect(await rootVar(page, "--nr-highlight")).not.toBe(NOREN_DUSK.ui.accent);
  });
});

test.describe("the controls of the settings move the glass at once", () => {
  const sliderOf = (within: Locator, name: string): Locator =>
    within.getByRole("slider", { name, exact: true });

  /** Moves a slider the way a drag does: the value is set and the input events are fired. */
  async function drag(slider: Locator, value: number): Promise<void> {
    await slider.evaluate((element, wanted) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, String(wanted));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  }

  test("the transparency of the interface: the panes follow it, the sidebar is 0.2 less opaque, solid at 1", async ({
    page,
  }) => {
    await start(page);
    const screen = await openSettings(page);
    const slider = sliderOf(
      screen.locator('[data-nr-part="settings-window"]'),
      "Interface opacity",
    );
    // Nothing is written: the slider stands at the opacity of the glass, which is 0.62.
    await expect(slider).toHaveValue("0.62");
    expect(await rootVar(page, "--nr-opacity")).toBe("0.62");

    await drag(slider, 0.8);
    await expect.poll(() => rootVar(page, "--nr-opacity")).toBe("0.8");
    expect((await colorOf(page, PANE, "background-color")).a).toBeCloseTo(0.8, 2);
    expect((await colorOf(page, SIDEBAR, "background-color")).a).toBeCloseTo(0.6, 2);
    expect((await colorOf(page, ".titlebar", "background-color")).a).toBeCloseTo(0.6, 2);

    await drag(slider, 0.3);
    await expect.poll(() => rootVar(page, "--nr-opacity")).toBe("0.3");
    expect((await colorOf(page, PANE, "background-color")).a).toBeCloseTo(0.3, 2);
    // Never under 0.2: the sidebar stays a surface.
    expect((await colorOf(page, SIDEBAR, "background-color")).a).toBeCloseTo(0.2, 2);

    // At the end of the slider the panes are solid and so is the sidebar, and the terminal paints itself again.
    await drag(slider, 1);
    await expect.poll(() => rootVar(page, "--nr-opacity")).toBe("1");
    expect((await colorOf(page, PANE, "background-color")).a).toBe(1);
    expect((await colorOf(page, SIDEBAR, "background-color")).a).toBe(1);
    await expect
      .poll(async () => (await colorOf(page, ".xterm-scrollable-element", "background-color")).a)
      .toBe(1);
    // A moment later the file has it, and the glass keeps it.
    await expect.poll(async () => (await configText(page)) ?? "").toContain('"opacity": 1');
    expect(await rootVar(page, "--nr-opacity")).toBe("1");
  });

  test("the blur softens the backdrop at once, and the backdrop reaches past the window so the blur does not fade its edges", async ({
    page,
  }) => {
    await start(page);
    const screen = await openSettings(page);
    const blur = sliderOf(screen.locator('[data-nr-part="settings-background"]'), "Image blur");
    expect(await styleOf(page, BACKDROP, "filter")).toBe("blur(0px)");
    await drag(blur, 14);
    await expect.poll(() => rootVar(page, "--nr-background-blur")).toBe("14px");
    expect(await styleOf(page, BACKDROP, "filter")).toBe("blur(14px)");
    // The backdrop reaches out past the window by twice the blur, so the blur does not fade its edges.
    const at = await box(page.locator(BACKDROP));
    expect(at.x).toBe(-28);
    expect(at.y).toBe(-28);
  });

  test("with a picture, the opacity, the blur and the transparency of the panels move the window at once", async ({
    page,
  }) => {
    await start(page, { picture: "#808080" });
    await expect(page.locator(BACKDROP)).toHaveCount(0);
    const layer = page.locator('[data-nr-part="background"]');
    await expect(layer).toHaveCount(1);
    const screen = await openSettings(page);
    await drag(
      sliderOf(screen.locator('[data-nr-part="settings-background"]'), "Image opacity"),
      0.3,
    );
    await expect.poll(() => rootVar(page, "--nr-background-opacity")).toBe("0.3");
    expect(await styleOf(page, '[data-nr-part="background"]', "opacity")).toBe("0.3");
    await drag(sliderOf(screen.locator('[data-nr-part="settings-background"]'), "Image blur"), 9);
    await expect.poll(() => rootVar(page, "--nr-background-blur")).toBe("9px");
    expect(await styleOf(page, '[data-nr-part="background"]', "filter")).toBe("blur(9px)");
    await drag(
      sliderOf(screen.locator('[data-nr-part="settings-window"]'), "Interface opacity"),
      0.45,
    );
    await expect.poll(() => rootVar(page, "--nr-opacity")).toBe("0.45");
    expect((await colorOf(page, PANE, "background-color")).a).toBeCloseTo(0.45, 2);
    expect((await colorOf(page, SIDEBAR, "background-color")).a).toBeCloseTo(0.25, 2);
  });
});

test.describe("the window behind the glass", () => {
  test("a picture of the person takes the place of the backdrop, under a veil of the glass", async ({
    page,
  }) => {
    await start(page, { picture: "#808080" });
    await expect(page.locator(BACKDROP)).toHaveCount(0);
    await expect(page.locator('[data-nr-part="background"]')).toHaveCount(1);
    await expect(page.locator('[data-nr-part="background-veil"]')).toHaveCount(1);
    // The veil of the glass style is stronger than the one of the dense style (0.4): 0.55.
    expect(await rootVar(page, "--nr-background-veil")).toBe("0.55");
    // The cards are glass over the picture, as over the backdrop.
    expect((await colorOf(page, PANE, "background-color")).a).toBeCloseTo(0.62, 2);
    expect(await styleOf(page, SIDEBAR, "backdrop-filter")).toBe("blur(30px) saturate(1.6)");
  });

  test("a picture that cannot be read leaves the illustrated backdrop", async ({ page }) => {
    await seedConfig(
      page,
      '{ "appearance": { "style": "glass", "background": { "image": "missing.png" } } }',
    );
    await page.goto("/");
    await expect(page.locator('[data-nr-part="background-notice"]')).toBeVisible();
    await expect(page.locator(BACKDROP)).toHaveCount(1);
  });

  test("a system effect (Mica) is the window behind the glass: no illustration over it", async ({
    page,
  }) => {
    await start(page, { effects: ["mica"], appearance: '"window": { "effect": "mica" }' });
    await expect
      .poll(() =>
        page.evaluate(() => (window as HookWindow).__norenTest?.windowEffectCalls().length),
      )
      .toBeGreaterThan(0);
    await expect(page.locator(".app")).toHaveAttribute("data-nr-window-effect", "mica");
    await expect(page.locator(BACKDROP)).toHaveCount(0);
    // The glass stays glass over it.
    expect(await styleOf(page, SIDEBAR, "backdrop-filter")).toBe("blur(30px) saturate(1.6)");
  });
});

test.describe("opaque panels", () => {
  /** The fill and the blur the cards compute to. */
  const seen = async (page: Page) => ({
    side: (await colorOf(page, SIDEBAR, "background-color")).a,
    pane: (await colorOf(page, PANE, "background-color")).a,
    title: (await colorOf(page, ".titlebar", "background-color")).a,
    sideBlur: await styleOf(page, SIDEBAR, "backdrop-filter"),
    paneBlur: await styleOf(page, PANE, "backdrop-filter"),
    titleBlur: await styleOf(page, ".titlebar", "backdrop-filter"),
    line: await styleOf(page, SIDEBAR, "border-top-width"),
    radius: await styleOf(page, SIDEBAR, "border-top-left-radius"),
  });

  test("with prefers-reduced-transparency the sidebar, the title bar and the panes are solid and sharp", async ({
    page,
  }) => {
    await start(page);
    const glass = await seen(page);
    expect(glass.side).toBeCloseTo(0.42, 2);
    expect(glass.pane).toBeCloseTo(0.62, 2);
    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    await expect.poll(async () => (await seen(page)).pane).toBe(1);
    const opaque = await seen(page);
    expect(opaque).toMatchObject({
      side: 1,
      pane: 1,
      title: 1,
      sideBlur: "none",
      paneBlur: "none",
      titleBlur: "none",
      // The shape stays: only the see-through goes.
      line: "1px",
      radius: "14px",
    });
    // The terminal still draws nothing of its own: the solid card is behind it.
    expect((await colorOf(page, ".xterm-scrollable-element", "background-color")).a).toBe(0);
  });

  test("with the transparency effects of the system off the panels are solid too, and they come back when it is on", async ({
    page,
  }) => {
    await start(page);
    // The system was asked when the window started.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as HookWindow).__norenTest?.backendCalls(["systemTransparencyReduced"]).length,
        ),
      )
      .toBeGreaterThan(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-nr-transparency", /.*/);
    expect((await seen(page)).pane).toBeCloseTo(0.62, 2);

    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setSystemTransparencyReduced(true),
    );
    await expect(page.locator("html")).toHaveAttribute("data-nr-transparency", "reduced");
    await expect.poll(async () => (await seen(page)).pane).toBe(1);
    expect(await seen(page)).toMatchObject({
      side: 1,
      pane: 1,
      title: 1,
      sideBlur: "none",
      paneBlur: "none",
      line: "1px",
      radius: "14px",
    });

    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setSystemTransparencyReduced(false),
    );
    await expect(page.locator("html")).not.toHaveAttribute("data-nr-transparency", /.*/);
    await expect.poll(async () => (await seen(page)).pane).toBeCloseTo(0.62, 2);
  });

  test("the window asks the system again when it gains the focus, so a change made meanwhile is followed", async ({
    page,
  }) => {
    await start(page);
    const calls = () =>
      page.evaluate(
        () =>
          (window as HookWindow).__norenTest?.backendCalls(["systemTransparencyReduced"]).length ??
          0,
      );
    const before = await calls();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(calls).toBeGreaterThan(before);
  });
});

test.describe("text over the glass keeps 4.5:1", () => {
  /** Every colour of a grid of points of an element in a screenshot, away from its edges and its text. */
  async function pixelsOf(
    page: Page,
    selector: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Promise<string[]> {
    const png = await page.screenshot();
    const pixels = readPixels(png);
    const at = await box(page.locator(selector).first());
    const found: string[] = [];
    for (let row = 0; row <= 5; row++) {
      for (let column = 0; column <= 5; column++) {
        const x = Math.round(at.x + at.width * (from.x + ((to.x - from.x) * column) / 5));
        const y = Math.round(at.y + at.height * (from.y + ((to.y - from.y) * row) / 5));
        found.push(hex({ r: pixels.at(x, y)[0], g: pixels.at(x, y)[1], b: pixels.at(x, y)[2] }));
      }
    }
    return found;
  }

  const cases: { mode: Mode; picture?: string; label: string }[] = [
    { mode: "dark", label: "the illustrated backdrop, a dark theme" },
    { mode: "light", label: "the illustrated backdrop, a light theme" },
    { mode: "dark", picture: "#ffffff", label: "a white picture, a dark theme (the worst of it)" },
    { mode: "dark", picture: "#000000", label: "a black picture, a dark theme" },
    {
      mode: "light",
      picture: "#000000",
      label: "a black picture, a light theme (the worst of it)",
    },
    { mode: "light", picture: "#ffffff", label: "a white picture, a light theme" },
  ];

  for (const { mode, picture, label } of cases) {
    test(`the text of the sidebar and of the terminal over ${label}`, async ({ page }) => {
      await start(page, { mode, ...(picture !== undefined ? { picture } : {}) });
      // Let the picture, the blur and the fonts settle before the page is looked at.
      await page.waitForTimeout(500);
      const theme = THEME[mode];
      // The sidebar below its list and the terminal under its first line are empty: the pixels there are
      // what the text of the card is read against.
      const side = await pixelsOf(page, SIDEBAR, { x: 0.15, y: 0.5 }, { x: 0.85, y: 0.85 });
      const terminal = await pixelsOf(page, PANE, { x: 0.1, y: 0.1 }, { x: 0.95, y: 0.95 });
      const worst = (colors: string[], text: string): number =>
        Math.min(...colors.map((color) => contrastRatio(text, color)));
      expect(
        worst(side, theme.ui.text),
        `text of the sidebar over ${label}`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        worst(terminal, theme.terminal.foreground),
        `text of the terminal over ${label}`,
      ).toBeGreaterThanOrEqual(4.5);
      // The secondary text is held to the same level over the backdrop, and to 3:1 over any picture.
      expect(worst(side, theme.ui.muted), `muted text over ${label}`).toBeGreaterThanOrEqual(
        picture === undefined ? 4.5 : 3,
      );
    });
  }
});

test.describe("axe", () => {
  const surfaces: { mode: Mode; lang: "en" | "pt-BR"; picture?: string; label: string }[] = [];
  for (const mode of ["dark", "light"] as const) {
    for (const lang of ["en", "pt-BR"] as const) {
      surfaces.push({ mode, lang, label: "the illustrated backdrop" });
      surfaces.push({ mode, lang, picture: "#ffffff", label: "a white picture" });
      surfaces.push({ mode, lang, picture: "#000000", label: "a black picture" });
    }
  }
  for (const { mode, lang, picture, label } of surfaces) {
    test(`the glass window over ${label} has no violation (${lang}, ${mode})`, async ({ page }) => {
      await start(page, { mode, lang, ...(picture !== undefined ? { picture } : {}) });
      await page.waitForTimeout(300);
      await expectNoAxeViolations(page, `the glass window over ${label}, ${lang}, ${mode}`);
    });
  }

  for (const mode of ["dark", "light"] as const) {
    test(`the glass window with a split tab has no violation (en, ${mode})`, async ({ page }) => {
      await start(page, { mode, seed: { split: true } });
      await page
        .getByRole("tree", { name: "Tabs", exact: true })
        .getByRole("treeitem", { name: SPLIT_FIXTURE.title, exact: true })
        .click();
      await expect(page.locator(`[data-pane-id="${SPLIT_FIXTURE.second}"]`)).toBeVisible();
      await expectNoAxeViolations(page, `the glass window with a split tab, ${mode}`);
    });
  }
});
