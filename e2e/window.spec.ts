import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  configText,
  openSettings,
  closeSettings,
  seedConfig,
  settingsScreen,
} from "./settings-fixture";

// The window itself: the effect the system paints behind it (Mica, Acrylic, vibrancy) and how
// opaque the interface is. The web build has no window to paint, so it plays the part of the
// system: `noren.web.window-effects` in the browser storage lists the effects this "system" can
// paint (a browser paints none, so without it every effect falls back to an opaque window), and the
// opacity shows in the computed styles of the page. How Mica really looks is not checked here.

interface Hook {
  paneIds(): string[];
  setConfig(text: string | null): void;
  windowEffectCalls(): { effect: string; scheme: string }[];
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_WINDOW_EFFECTS_KEY = "noren.web.window-effects";

// Noren Dusk, the theme of a dark system (packages/model/src/builtin-themes.ts).
const DUSK = { bg: "rgb(20, 22, 27)", surface: "rgb(27, 30, 37)", text: "#e6e6e6" };

async function seedEffects(page: Page, effects: string[]): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_WINDOW_EFFECTS_KEY, value: JSON.stringify(effects) },
  );
}

async function start(page: Page): Promise<void> {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
}

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const computed = (page: Page, selector: string, property: string): Promise<string> =>
  page.evaluate(
    ({ selector, property }) => {
      const element = document.querySelector(selector);
      return element === null ? "" : getComputedStyle(element).getPropertyValue(property);
    },
    { selector, property },
  );
const bodyBackground = (page: Page): Promise<string> => computed(page, "body", "background-color");
const sidebarBackground = (page: Page): Promise<string> =>
  computed(page, '[data-nr-part="sidebar"]', "background-color");
const titleBackground = (page: Page): Promise<string> =>
  computed(page, ".titlebar", "background-color");
/** The background of the terminal on screen (xterm sets it on its scrollable element). */
const terminalBackground = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const visible = [...document.querySelectorAll<HTMLElement>(".xterm-scrollable-element")].find(
      (element) => element.getClientRects().length > 0 && element.offsetParent !== null,
    );
    return visible === undefined ? "" : getComputedStyle(visible).backgroundColor;
  });
const effectOf = (page: Page): Promise<string | null> =>
  page.locator("main.app").getAttribute("data-nr-window-effect");

/** The alpha of a computed color: `rgba(r, g, b, a)` has one, `rgb(r, g, b)` is solid. */
function alphaOf(color: string): number {
  const match = /^rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\s*\)$/.exec(color);
  return match === null ? 1 : Number(match[1]);
}
/** The channels of a computed color, without the alpha. */
const channelsOf = (color: string): string =>
  (/\(([^)]*)\)/.exec(color)?.[1] ?? "").split(",").slice(0, 3).join(",").replace(/\s/g, "");

const effectNote = (page: Page): Locator =>
  page.locator('[data-nr-part="settings-window-effect-note"]');
const opacityBox = (screen: Locator): Locator =>
  screen.getByRole("textbox", { name: "Interface opacity (0.3 to 1)", exact: true });

test.describe("on a dark system", () => {
  test.use({ colorScheme: "dark" });

  test("a plain window is solid: no effect, opacity 1, the colors of the theme", async ({
    page,
  }) => {
    await start(page);
    expect(await effectOf(page)).toBe("none");
    expect(await rootVar(page, "--nr-opacity")).toBe("1");
    expect(await rootVar(page, "--nr-bg-glass")).toBe("#14161b");
    expect(await bodyBackground(page)).toBe(DUSK.bg);
    expect(await sidebarBackground(page)).toBe(DUSK.surface);
    expect(await titleBackground(page)).toBe(DUSK.surface);
    expect(await terminalBackground(page)).toBe(DUSK.bg);
    // Nobody asked for an effect: the backend was not asked either.
    expect(
      await page.evaluate(() => (window as HookWindow).__norenTest?.windowEffectCalls()),
    ).toEqual([]);
  });

  test("Mica on a system that paints it: the window has Mica and the surfaces take the opacity of the theme", async ({
    page,
  }) => {
    await seedEffects(page, ["mica"]);
    await seedConfig(page, '{ "appearance": { "window": { "effect": "mica" } } }');
    await start(page);

    await expect.poll(() => effectOf(page)).toBe("mica");
    // Noren Dusk has an opacity of 0.92; it is the opacity of the interface while there is an effect.
    expect(await rootVar(page, "--nr-opacity")).toBe("0.92");
    for (const background of [
      await bodyBackground(page),
      await sidebarBackground(page),
      await titleBackground(page),
    ]) {
      expect(alphaOf(background)).toBeCloseTo(0.92, 2);
    }
    expect(channelsOf(await bodyBackground(page))).toBe("20,22,27");
    expect(channelsOf(await sidebarBackground(page))).toBe("27,30,37");
    // The theme follows the system, so the window does too.
    expect(
      await page.evaluate(() => (window as HookWindow).__norenTest?.windowEffectCalls()),
    ).toEqual([{ effect: "mica", scheme: "system" }]);
  });

  test("the interface stays readable: text is not faded and menus and dialogs stay solid", async ({
    page,
  }) => {
    await seedEffects(page, ["acrylic"]);
    await seedConfig(
      page,
      '{ "appearance": { "window": { "effect": "acrylic", "opacity": 0.4 } } }',
    );
    await start(page);
    await expect.poll(() => effectOf(page)).toBe("acrylic");
    expect(await rootVar(page, "--nr-opacity")).toBe("0.4");
    expect(alphaOf(await sidebarBackground(page))).toBeCloseTo(0.4, 2);

    // Text, borders and the accent keep their colors.
    expect(await rootVar(page, "--nr-text")).toBe(DUSK.text);
    const textColor = await computed(page, '[data-nr-part="item-title"]', "color");
    expect(alphaOf(textColor)).toBe(1);
    expect(await computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("1");

    // A dialog is painted with the solid color of the surface, not the see-through one.
    const screen = await openSettings(page);
    const dialogBackground = await screen.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("background-color"),
    );
    expect(dialogBackground).toBe(DUSK.surface);
    await screen.getByRole("button", { name: "Close", exact: true }).click();
  });

  test("a system that cannot paint the effect keeps the window opaque, and the settings say why", async ({
    page,
  }) => {
    // No effects seeded: the "system" is a browser.
    await seedConfig(page, '{ "appearance": { "window": { "effect": "mica" } } }');
    await start(page);

    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.windowEffectCalls()))
      .toEqual([{ effect: "mica", scheme: "system" }]);
    expect(await effectOf(page)).toBe("none");
    expect(await rootVar(page, "--nr-opacity")).toBe("1");
    expect(await bodyBackground(page)).toBe(DUSK.bg);
    expect(await sidebarBackground(page)).toBe(DUSK.surface);

    // The file is valid, so no notice of a problem with it; the Window section tells what happened.
    await expect(page.locator('[data-nr-part="config-notice"]')).toHaveCount(0);
    const screen = await openSettings(page);
    await expect(effectNote(page)).toContainText(
      "Mica was not applied, so the window stays opaque.",
    );
    await expect(effectNote(page)).toContainText("a browser window has no window effects");
    await expect(screen.getByRole("combobox", { name: "Window effect", exact: true })).toHaveValue(
      "mica",
    );
  });

  test("an opacity in the settings works with no effect: the surfaces and the terminal are see-through", async ({
    page,
  }) => {
    await seedConfig(page, '{ "appearance": { "window": { "opacity": 0.6 } } }');
    await start(page);

    expect(await effectOf(page)).toBe("none");
    expect(await rootVar(page, "--nr-opacity")).toBe("0.6");
    expect(alphaOf(await bodyBackground(page))).toBeCloseTo(0.6, 2);
    expect(alphaOf(await sidebarBackground(page))).toBeCloseTo(0.6, 2);
    expect(alphaOf(await titleBackground(page))).toBeCloseTo(0.6, 2);
    expect(channelsOf(await terminalBackground(page))).toBe("20,22,27");
    expect(alphaOf(await terminalBackground(page))).toBeCloseTo(0.6, 2);
  });

  test("an opacity out of range is a problem of the file with its line, and the last valid one stays", async ({
    page,
  }) => {
    await seedConfig(page, '{ "appearance": { "window": { "opacity": 0.8 } } }');
    await start(page);
    expect(await rootVar(page, "--nr-opacity")).toBe("0.8");

    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setConfig(
        '{\n  "appearance": {\n    "window": { "opacity": 0.1 }\n  }\n}',
      ),
    );
    const notice = page.locator('[data-nr-part="config-notice"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("appearance.window.opacity");
    await expect(notice).toContainText("line 3");
    expect(await rootVar(page, "--nr-opacity")).toBe("0.8");

    // The lowest allowed is accepted.
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setConfig(
        '{ "appearance": { "window": { "opacity": 0.3 } } }',
      ),
    );
    await expect(notice).toHaveCount(0);
    expect(await rootVar(page, "--nr-opacity")).toBe("0.3");
  });

  test("the file follows the settings: changing it changes the window without a reload", async ({
    page,
  }) => {
    await seedEffects(page, ["mica", "acrylic"]);
    await start(page);
    expect(await effectOf(page)).toBe("none");

    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setConfig(
        '{ "appearance": { "window": { "effect": "acrylic" } } }',
      ),
    );
    await expect.poll(() => effectOf(page)).toBe("acrylic");
    expect(await rootVar(page, "--nr-opacity")).toBe("0.92");

    await page.evaluate(() => (window as HookWindow).__norenTest?.setConfig("{}"));
    await expect.poll(() => effectOf(page)).toBe("none");
    expect(await rootVar(page, "--nr-opacity")).toBe("1");
    expect(await bodyBackground(page)).toBe(DUSK.bg);
    expect(
      await page.evaluate(() => (window as HookWindow).__norenTest?.windowEffectCalls()),
    ).toEqual([
      { effect: "acrylic", scheme: "system" },
      { effect: "none", scheme: "system" },
    ]);
  });

  test("the effect follows the kind of a theme that was chosen, not the mode of the system, and the system when the theme follows it", async ({
    page,
  }) => {
    await seedEffects(page, ["mica"]);
    await seedConfig(
      page,
      '{ "appearance": { "theme": "noren-paper", "window": { "effect": "mica" } } }',
    );
    await start(page);
    // The system is dark and the theme is a light one: Mica is asked for in light.
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.windowEffectCalls()))
      .toEqual([{ effect: "mica", scheme: "light" }]);

    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setConfig(
        '{ "appearance": { "theme": "noren-fjord", "window": { "effect": "mica" } } }',
      ),
    );
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.windowEffectCalls()))
      .toEqual([
        { effect: "mica", scheme: "light" },
        { effect: "mica", scheme: "dark" },
      ]);

    // Back to following the system: the window follows it too, and is not left with a look of its own.
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setConfig(
        '{ "appearance": { "theme": "system", "window": { "effect": "mica" } } }',
      ),
    );
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.windowEffectCalls()))
      .toEqual([
        { effect: "mica", scheme: "light" },
        { effect: "mica", scheme: "dark" },
        { effect: "mica", scheme: "system" },
      ]);
  });

  test("the settings screen writes the effect and the opacity, keeps the comments, and the window follows", async ({
    page,
  }) => {
    await seedEffects(page, ["mica"]);
    await seedConfig(page, '// my window\n{\n  "appearance": { "tabs": "sidebar" }, // tabs\n}\n');
    await start(page);

    const screen = await openSettings(page);
    await screen.getByRole("combobox", { name: "Window effect", exact: true }).selectOption("mica");
    await opacityBox(screen).fill("0.8");
    await closeSettings(page);

    const text = (await configText(page)) ?? "";
    expect(text).toContain("// my window");
    expect(text).toContain("// tabs");
    expect(text).toContain('"effect": "mica"');
    expect(text).toContain('"opacity": 0.8');
    await expect.poll(() => effectOf(page)).toBe("mica");
    expect(await rootVar(page, "--nr-opacity")).toBe("0.8");
    expect(alphaOf(await bodyBackground(page))).toBeCloseTo(0.8, 2);

    // It is still there after a reload, and the screen shows what the file says.
    await page.reload();
    await expect.poll(() => effectOf(page)).toBe("mica");
    const again = await openSettings(page);
    await expect(again.getByRole("combobox", { name: "Window effect", exact: true })).toHaveValue(
      "mica",
    );
    await expect(opacityBox(again)).toHaveValue("0.8");
  });

  test("emptying the opacity box writes null, and a value out of range is refused where it is typed", async ({
    page,
  }) => {
    await seedEffects(page, ["mica"]);
    await seedConfig(page, '{ "appearance": { "window": { "effect": "mica", "opacity": 0.5 } } }');
    await start(page);
    expect(await rootVar(page, "--nr-opacity")).toBe("0.5");

    const screen = await openSettings(page);
    await opacityBox(screen).fill("0.1");
    await expect(screen.getByRole("alert").filter({ hasText: "0.3 to 1" })).toBeVisible();
    // Out of range: nothing is written, and the file keeps its 0.5.
    await page.waitForTimeout(700);
    expect(await configText(page)).toContain('"opacity": 0.5');
    await opacityBox(screen).fill("");
    await closeSettings(page);

    expect(await configText(page)).toContain('"opacity": null');
    // No value any more: the opacity of the theme, since the window has Mica.
    await expect.poll(() => rootVar(page, "--nr-opacity")).toBe("0.92");
    await openSettings(page);
    await expect(opacityBox(settingsScreen(page))).toHaveValue("");
  });
});
