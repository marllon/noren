import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { readPixels } from "./png-pixels";
import {
  cancelSettings,
  configText,
  openSettings,
  saveSettings,
  seedConfig,
} from "./settings-fixture";

// A picture that shows (NOR-F20-08b): with one behind the window the sidebar and the terminals are
// see-through by default (the sidebar frosted), the picture shows at a stronger default under a veil
// of the color of the theme, and three sliders (the opacity of the interface, the opacity of the
// picture and its blur) show their effect in the window at once, before Save. The terminal being
// see-through is checked in pixels, not only in styles: black behind it was the bug (xterm.css gives
// its scrolling box a solid black background). The files a path can name are the ones the web build
// holds under `noren.web.images`; the fixture picture is seeded there.

interface Hook {
  paneIds(): string[];
  setImagePick(path: string | null): void;
  renderer(): "webgl" | "dom";
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_IMAGES_KEY = "noren.web.images";

/** The fixture picture (48 by 32 pixels) and the path the web build serves it under. */
const FIXTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));
const PICTURE = "fixtures/background.png";

async function start(page: Page, config?: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_IMAGES_KEY, value: JSON.stringify({ [PICTURE]: FIXTURE.toString("base64") }) },
  );
  if (config !== undefined) await seedConfig(page, config);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
}

/** The settings file with a theme and a picture that says nothing else (so the defaults rule). */
const withPicture = (theme: string, extra = ""): string =>
  `{ "appearance": { "theme": "${theme}", ${extra}"background": { "image": "${PICTURE}" } } }`;

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/** One computed property of the first element a selector finds. */
const styleOf = (page: Page, selector: string, property: string): Promise<string> =>
  page.evaluate(
    ({ selector: query, property: name }) => {
      const element = document.querySelector(query);
      return element === null ? "" : getComputedStyle(element).getPropertyValue(name);
    },
    { selector, property },
  );

/** The alpha of a computed `rgb(...)` or `rgba(...)` color; 1 for one with none. */
function alphaOf(color: string): number {
  const match = /^rgba?\(([^)]+)\)$/.exec(color);
  if (match?.[1] === undefined) throw new Error(`not a color: ${color}`);
  const parts = match[1].split(/[\s,/]+/).filter((part) => part !== "");
  return parts.length === 4 ? Number(parts[3]) : 1;
}

/** The background of the visible terminal that xterm paints, on its scrolling element. */
const terminalPaint = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const visible = [...document.querySelectorAll<HTMLElement>(".xterm-scrollable-element")].find(
      (element) => element.getClientRects().length > 0 && element.offsetParent !== null,
    );
    return visible === undefined ? "" : getComputedStyle(visible).backgroundColor;
  });

const sidebarColor = (page: Page): Promise<string> =>
  styleOf(page, '[data-nr-part="sidebar"]', "background-color");
const paneGlass = (page: Page): Promise<string> =>
  styleOf(page, ".terminal-view", "background-color");

const layer = (page: Page): Locator => page.locator('[data-nr-part="background"]');
const layerStyle = (page: Page, property: string): Promise<string> =>
  layer(page).evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );

const windowSection = (screen: Locator): Locator =>
  screen.locator('[data-nr-part="settings-window"]');
const backgroundSection = (screen: Locator): Locator =>
  screen.locator('[data-nr-part="settings-background"]');

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

/** The picture behind the terminal really reaches the pixels: it is not a solid color. */
async function expectPictureThrough(page: Page, solid: [number, number, number]): Promise<void> {
  const box = await page.locator(".terminal-view").first().boundingBox();
  if (box === null) throw new Error("no terminal on screen");
  // Below the text, across the width: a solid terminal would be one color all over.
  const y = Math.round(box.y + box.height * 0.8);
  const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map((share) => Math.round(box.x + box.width * share));
  const pixels = readPixels(await page.screenshot());
  const colors = xs.map((x) => pixels.at(x, y));
  // Not black: the black of xterm.css behind a see-through terminal reads 0 to 4 on every channel.
  expect(
    Math.min(...colors.flat()),
    `colors across the terminal: ${JSON.stringify(colors)}`,
  ).toBeGreaterThan(12);
  const range = [0, 1, 2].map((channel) => {
    const values = colors.map((color) => color[channel] ?? 0);
    return Math.max(...values) - Math.min(...values);
  });
  expect(
    Math.max(...range),
    `colors across the terminal: ${JSON.stringify(colors)}`,
  ).toBeGreaterThan(8);
  const distance = colors.map((color) =>
    Math.max(...color.map((value, channel) => Math.abs(value - (solid[channel] ?? 0)))),
  );
  expect(Math.max(...distance), "the terminal is not its own solid color").toBeGreaterThan(8);
}

test.describe("on a dark system", () => {
  test.use({ colorScheme: "dark" });

  test("with a picture, the sidebar and the terminal are see-through by default, and the picture is behind them", async ({
    page,
  }) => {
    await start(page, withPicture("noren-dusk"));
    await expect(layer(page)).toHaveCount(1);

    // The defaults of a picture: far more of it than the 0.15 of before, a veil, half-glass panels.
    expect(Number(await rootVar(page, "--nr-background-opacity"))).toBeGreaterThan(0.15);
    expect(await rootVar(page, "--nr-background-opacity")).toBe("0.6");
    expect(await rootVar(page, "--nr-background-veil")).toBe("0.4");
    expect(await rootVar(page, "--nr-opacity")).toBe("0.55");
    expect(await layerStyle(page, "opacity")).toBe("0.6");

    // The sidebar and the pane of the terminal are glass of the theme at that opacity; the sidebar
    // blurs what it lets through, the terminal does not.
    expect(alphaOf(await sidebarColor(page))).toBeCloseTo(0.55, 2);
    expect(alphaOf(await paneGlass(page))).toBeCloseTo(0.55, 2);
    expect(await styleOf(page, '[data-nr-part="sidebar"]', "backdrop-filter")).toBe("blur(18px)");
    expect(await styleOf(page, ".terminal-view", "backdrop-filter")).toBe("none");

    // The terminal draws no background of its own, and the scrolling box xterm.css makes black is
    // clear: this is the bug of the black terminal over a picture.
    expect(await terminalPaint(page)).toBe("rgba(20, 22, 27, 0)");
    expect(await styleOf(page, ".xterm .xterm-viewport", "background-color")).toBe(
      "rgba(0, 0, 0, 0)",
    );
  });

  test("the picture is drawn on the solid background of the theme, under a veil of its color, under everything", async ({
    page,
  }) => {
    await start(page, withPicture("noren-dusk"));
    await expect(layer(page)).toHaveCount(1);
    const parts = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("main.app > [data-nr-part^='background']")].map(
        (element) => ({
          part: element.dataset["nrPart"],
          zIndex: getComputedStyle(element).zIndex,
          position: getComputedStyle(element).position,
          events: getComputedStyle(element).pointerEvents,
          color: getComputedStyle(element).backgroundColor,
          opacity: getComputedStyle(element).opacity,
        }),
      ),
    );
    // Bottom to top: what the picture is drawn on, the picture, the veil. None takes a click.
    expect(parts.map((part) => part.part)).toEqual([
      "background-backing",
      "background",
      "background-veil",
    ]);
    for (const part of parts) {
      expect(part).toMatchObject({ zIndex: "-1", position: "fixed", events: "none" });
    }
    // Dark theme: a dark veil (the background of the theme), on a solid background of the same color.
    expect(parts[0]?.color).toBe("rgb(20, 22, 27)");
    expect(parts[2]).toMatchObject({ color: "rgb(20, 22, 27)", opacity: "0.4" });
  });

  test("the picture shows through the terminal, in pixels", async ({ page }, testInfo) => {
    await start(page, withPicture("noren-dusk"));
    await expect(layer(page)).toHaveCount(1);
    // Wait for the terminal to be drawn with its see-through theme.
    await expect.poll(() => terminalPaint(page)).toBe("rgba(20, 22, 27, 0)");
    await expectPictureThrough(page, [20, 22, 27]);
    // It holds with whichever renderer the browser gave (WebGL, or the DOM one after a fallback);
    // the run says which one it was.
    const renderer = await page.evaluate(() => (window as HookWindow).__norenTest?.renderer());
    expect(["webgl", "dom"]).toContain(renderer);
    testInfo.annotations.push({ type: "renderer", description: String(renderer) });
    console.log(`picture through the terminal, renderer: ${String(renderer)}`);
  });

  test("a picture that cannot be read leaves the panels solid: nothing to see through", async ({
    page,
  }) => {
    await start(
      page,
      `{ "appearance": { "theme": "noren-dusk", "background": { "image": "fixtures/missing.png" } } }`,
    );
    await expect(page.locator('[data-nr-part="background-notice"]')).toBeVisible();
    await expect(layer(page)).toHaveCount(0);
    expect(await rootVar(page, "--nr-opacity")).toBe("1");
    expect(await sidebarColor(page)).toBe("rgb(27, 30, 37)");
    expect(await terminalPaint(page)).toBe("rgb(20, 22, 27)");
  });

  test("a window with no picture is solid and keeps its terminal, as before", async ({ page }) => {
    await start(page, `{ "appearance": { "theme": "noren-dusk" } }`);
    await expect(layer(page)).toHaveCount(0);
    expect(await rootVar(page, "--nr-opacity")).toBe("1");
    expect(await sidebarColor(page)).toBe("rgb(27, 30, 37)");
    expect(await paneGlass(page)).toBe("rgba(0, 0, 0, 0)");
    expect(await terminalPaint(page)).toBe("rgb(20, 22, 27)");
    expect(await styleOf(page, '[data-nr-part="sidebar"]', "backdrop-filter")).toBe("none");
  });

  test("the opacity of the interface in the settings wins over the default of a picture", async ({
    page,
  }) => {
    await start(page, withPicture("noren-dusk", '"window": { "opacity": 0.9 }, '));
    await expect(layer(page)).toHaveCount(1);
    expect(await rootVar(page, "--nr-opacity")).toBe("0.9");
    expect(alphaOf(await sidebarColor(page))).toBeCloseTo(0.9, 2);
    expect(alphaOf(await paneGlass(page))).toBeCloseTo(0.9, 2);
  });

  test("a see-through window with no picture has no black behind its terminal either", async ({
    page,
  }) => {
    await start(page, `{ "appearance": { "theme": "noren-dusk", "window": { "opacity": 0.7 } } }`);
    expect(await terminalPaint(page)).toBe("rgba(20, 22, 27, 0.7)");
    expect(await styleOf(page, ".xterm .xterm-viewport", "background-color")).toBe(
      "rgba(0, 0, 0, 0)",
    );
  });

  test.describe("the sliders of the settings screen", () => {
    test("three sliders, one for each number, standing where the window has it", async ({
      page,
    }) => {
      await start(page, withPicture("noren-dusk"));
      const screen = await openSettings(page);
      const panels = sliderOf(windowSection(screen), "Interface opacity");
      const opacity = sliderOf(backgroundSection(screen), "Image opacity");
      const blur = sliderOf(backgroundSection(screen), "Image blur");
      // Nothing is written in the file, so each stands at the value in force: the defaults of a picture.
      await expect(panels).toHaveValue("0.55");
      await expect(opacity).toHaveValue("0.6");
      await expect(blur).toHaveValue("0");
      // Their ranges are the ones of the settings.
      await expect(panels).toHaveAttribute("min", "0.3");
      await expect(panels).toHaveAttribute("max", "1");
      await expect(opacity).toHaveAttribute("min", "0");
      await expect(opacity).toHaveAttribute("max", "1");
      await expect(blur).toHaveAttribute("max", "100");
      await expect(panels).toHaveAttribute("aria-valuetext", "55%");
    });

    test("the opacity of the picture shows in the window at once, before Save", async ({
      page,
    }) => {
      await start(page, withPicture("noren-dusk"));
      const screen = await openSettings(page);
      await drag(sliderOf(backgroundSection(screen), "Image opacity"), 0.2);
      await expect.poll(() => rootVar(page, "--nr-background-opacity")).toBe("0.2");
      expect(await layerStyle(page, "opacity")).toBe("0.2");
      // The box next to the slider holds the same number.
      await expect(
        backgroundSection(screen).getByRole("textbox", {
          name: "Image opacity (0 to 1)",
          exact: true,
        }),
      ).toHaveValue("0.2");
      // Nothing was written.
      expect(await configText(page)).not.toContain('"opacity"');
    });

    test("the blur of the picture shows in the window at once", async ({ page }) => {
      await start(page, withPicture("noren-dusk"));
      const screen = await openSettings(page);
      await drag(sliderOf(backgroundSection(screen), "Image blur"), 14);
      await expect.poll(() => rootVar(page, "--nr-background-blur")).toBe("14px");
      expect(await layerStyle(page, "filter")).toBe("blur(14px)");
    });

    test("the opacity of the interface moves the sidebar and the terminal, and the terminal draws nothing new", async ({
      page,
    }) => {
      await start(page, withPicture("noren-dusk"));
      const screen = await openSettings(page);
      await drag(sliderOf(windowSection(screen), "Interface opacity"), 0.8);
      await expect.poll(() => rootVar(page, "--nr-opacity")).toBe("0.8");
      expect(alphaOf(await sidebarColor(page))).toBeCloseTo(0.8, 2);
      expect(alphaOf(await paneGlass(page))).toBeCloseTo(0.8, 2);
      // The pane of glass is a CSS color: xterm keeps drawing nothing, so a slider never repaints it.
      expect(await terminalPaint(page)).toBe("rgba(20, 22, 27, 0)");
      // Down to the lowest the setting allows.
      await drag(sliderOf(windowSection(screen), "Interface opacity"), 0.3);
      await expect.poll(() => rootVar(page, "--nr-opacity")).toBe("0.3");
      expect(alphaOf(await sidebarColor(page))).toBeCloseTo(0.3, 2);
    });

    test("Cancel puts the window back as the file has it", async ({ page }) => {
      await start(page, withPicture("noren-dusk"));
      const screen = await openSettings(page);
      await drag(sliderOf(backgroundSection(screen), "Image opacity"), 1);
      await drag(sliderOf(backgroundSection(screen), "Image blur"), 30);
      await drag(sliderOf(windowSection(screen), "Interface opacity"), 1);
      await expect.poll(() => rootVar(page, "--nr-opacity")).toBe("1");
      await cancelSettings(page);
      await expect.poll(() => rootVar(page, "--nr-opacity")).toBe("0.55");
      expect(await rootVar(page, "--nr-background-opacity")).toBe("0.6");
      expect(await rootVar(page, "--nr-background-blur")).toBe("0px");
      expect(await configText(page)).not.toContain('"blur"');
    });

    test("Save writes the numbers, keeps them in the window and the screen opens on them", async ({
      page,
    }) => {
      await start(page, withPicture("noren-dusk"));
      const screen = await openSettings(page);
      await drag(sliderOf(backgroundSection(screen), "Image opacity"), 0.35);
      await drag(sliderOf(backgroundSection(screen), "Image blur"), 9);
      await drag(sliderOf(windowSection(screen), "Interface opacity"), 0.7);
      await saveSettings(page);
      const text = (await configText(page)) ?? "";
      expect(text).toContain('"opacity": 0.35');
      expect(text).toContain('"blur": 9');
      expect(text).toContain('"opacity": 0.7');
      expect(await rootVar(page, "--nr-background-opacity")).toBe("0.35");
      expect(await rootVar(page, "--nr-background-blur")).toBe("9px");
      expect(await rootVar(page, "--nr-opacity")).toBe("0.7");
      const again = await openSettings(page);
      await expect(sliderOf(windowSection(again), "Interface opacity")).toHaveValue("0.7");
      await expect(sliderOf(backgroundSection(again), "Image opacity")).toHaveValue("0.35");
      await expect(sliderOf(backgroundSection(again), "Image blur")).toHaveValue("9");
    });

    test("the box and the slider are one number: typing moves the slider and the window", async ({
      page,
    }) => {
      await start(page, withPicture("noren-dusk"));
      const screen = await openSettings(page);
      const box = backgroundSection(screen).getByRole("textbox", {
        name: "Image opacity (0 to 1)",
        exact: true,
      });
      await box.fill("0.9");
      await expect(sliderOf(backgroundSection(screen), "Image opacity")).toHaveValue("0.9");
      await expect.poll(() => rootVar(page, "--nr-background-opacity")).toBe("0.9");
      // Half a number on the way leaves the window as it was, and the box says what is wrong.
      await box.fill("1.5");
      await expect(backgroundSection(screen).getByRole("alert").first()).toBeVisible();
      expect(await rootVar(page, "--nr-background-opacity")).toBe("0.9");
      // Emptying the box is "not set": the default comes back.
      await box.fill("");
      await expect.poll(() => rootVar(page, "--nr-background-opacity")).toBe("0.6");
    });

    test("a slider moved by the keyboard works too", async ({ page }) => {
      await start(page, withPicture("noren-dusk"));
      const screen = await openSettings(page);
      const slider = sliderOf(backgroundSection(screen), "Image opacity");
      await slider.focus();
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => rootVar(page, "--nr-background-opacity")).toBe("0.59");
      await page.keyboard.press("Home");
      await expect.poll(() => rootVar(page, "--nr-background-opacity")).toBe("0");
      await page.keyboard.press("End");
      await expect.poll(() => rootVar(page, "--nr-background-opacity")).toBe("1");
    });

    test("the settings screen has no violation of any impact, with the sliders", async ({
      page,
    }) => {
      await start(page, withPicture("noren-dusk"));
      const screen = await openSettings(page);
      await backgroundSection(screen).scrollIntoViewIfNeeded();
      await expectNoAxeViolations(page, "the settings screen with the sliders, dark");
      await drag(sliderOf(windowSection(screen), "Interface opacity"), 0.4);
      await expectNoAxeViolations(page, "the settings screen with a slider moved, dark");
    });
  });

  test.describe("the sliders of the dialog of a space", () => {
    const dialogOf = (page: Page): Locator =>
      page.getByRole("dialog", { name: "Background image", exact: true });

    async function openDialog(page: Page): Promise<Locator> {
      await page
        .getByRole("navigation", { name: "Spaces", exact: true })
        .getByRole("button", { name: "Main", exact: true })
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "Background image…", exact: true }).click();
      const dialog = dialogOf(page);
      await expect(dialog).toBeVisible();
      return dialog;
    }

    test("show their effect on the space on screen at once, and Cancel takes it back", async ({
      page,
    }) => {
      await start(page, withPicture("noren-dusk"));
      const dialog = await openDialog(page);
      const opacity = sliderOf(dialog, "Image opacity");
      const blur = sliderOf(dialog, "Image blur");
      // The boxes are empty (the space says nothing), so the sliders stand at the numbers in force.
      await expect(opacity).toHaveValue("0.6");
      await expect(blur).toHaveValue("0");
      await drag(opacity, 0.25);
      await drag(blur, 6);
      await expect.poll(() => rootVar(page, "--nr-background-opacity")).toBe("0.25");
      expect(await rootVar(page, "--nr-background-blur")).toBe("6px");
      expect(await layerStyle(page, "filter")).toBe("blur(6px)");
      await expect(
        dialog.getByRole("textbox", { name: "Opacity (0 to 1)", exact: true }),
      ).toHaveValue("0.25");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => rootVar(page, "--nr-background-opacity")).toBe("0.6");
      expect(await rootVar(page, "--nr-background-blur")).toBe("0px");
    });

    test("Apply keeps the numbers as the picture of the space", async ({ page }) => {
      await start(page, withPicture("noren-dusk"));
      await page.evaluate(
        (path) => (window as HookWindow).__norenTest?.setImagePick(path),
        PICTURE,
      );
      const dialog = await openDialog(page);
      await dialog.getByRole("button", { name: "Choose image…", exact: true }).click();
      await drag(sliderOf(dialog, "Image opacity"), 0.45);
      await drag(sliderOf(dialog, "Image blur"), 4);
      await dialog.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => rootVar(page, "--nr-background-opacity")).toBe("0.45");
      expect(await rootVar(page, "--nr-background-blur")).toBe("4px");
      // The settings file was not touched: the picture is the space's.
      expect(await configText(page)).not.toContain('"blur": 4');
    });

    test("have no violation of any impact", async ({ page }) => {
      await start(page, withPicture("noren-dusk"));
      const dialog = await openDialog(page);
      await drag(sliderOf(dialog, "Image opacity"), 0.3);
      await expectNoAxeViolations(page, "the background dialog of a space with sliders, dark");
    });
  });

  test("the window with a picture and its sidebar and terminal has no violation of any impact", async ({
    page,
  }) => {
    await start(page, withPicture("noren-dusk"));
    await expect(layer(page)).toHaveCount(1);
    await expectNoAxeViolations(page, "the window over a picture, dark");
  });
});

test.describe("on a light system", () => {
  test.use({ colorScheme: "light" });

  test("a light theme gets a light veil on a light solid background, and the same glass", async ({
    page,
  }) => {
    await start(page, withPicture("noren-paper"));
    await expect(layer(page)).toHaveCount(1);
    expect(await styleOf(page, '[data-nr-part="background-backing"]', "background-color")).toBe(
      "rgb(246, 243, 236)",
    );
    expect(await styleOf(page, '[data-nr-part="background-veil"]', "background-color")).toBe(
      "rgb(246, 243, 236)",
    );
    expect(alphaOf(await sidebarColor(page))).toBeCloseTo(0.55, 2);
    // Light text on a dark terminal is not the case here: the terminal of Paper is light, and the
    // picture shows through it all the same.
    expect(await terminalPaint(page)).toBe("rgba(246, 243, 236, 0)");
    await expectPictureThrough(page, [246, 243, 236]);
  });

  test("the window over a picture and the settings screen have no violation of any impact, light", async ({
    page,
  }) => {
    await start(page, withPicture("noren-paper"));
    await expect(layer(page)).toHaveCount(1);
    await expectNoAxeViolations(page, "the window over a picture, light");
    const screen = await openSettings(page);
    await backgroundSection(screen).scrollIntoViewIfNeeded();
    await expectNoAxeViolations(page, "the settings screen with the sliders, light");
  });
});

test.describe("in Portuguese", () => {
  test.use({ colorScheme: "dark" });

  test("the sliders say their names in Portuguese", async ({ page }) => {
    await start(
      page,
      `{ "language": "pt-BR", "appearance": { "theme": "noren-dusk", "background": { "image": "${PICTURE}" } } }`,
    );
    await page.getByRole("button", { name: "Configurações", exact: true }).click();
    const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
    await expect(screen).toBeVisible();
    await expect(sliderOf(screen, "Opacidade da interface")).toHaveValue("0.55");
    await expect(sliderOf(screen, "Opacidade da imagem")).toHaveValue("0.6");
    await expect(sliderOf(screen, "Desfoque da imagem")).toHaveValue("0");
    await drag(sliderOf(screen, "Opacidade da imagem"), 0.3);
    await expect.poll(() => rootVar(page, "--nr-background-opacity")).toBe("0.3");
  });
});
