import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { NOREN_DUSK } from "../packages/model/src/builtin-themes";
import { configText, openSettings, closeSettings, seedConfig } from "./settings-fixture";

// The picture behind the terminals. It is a file on this computer: the web build keeps the files a
// path can name under `noren.web.images` in the browser storage (a fixture picture is seeded
// there), the app asks the backend for the bytes and shows them from memory, and nothing is ever
// fetched. It can come from the theme, from the settings file or from a space; the last one that
// says a part wins. The tests read the computed styles of the layer that draws it.

interface Hook {
  paneIds(): string[];
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook; __stillHere?: boolean };

const WEB_IMAGES_KEY = "noren.web.images";
const WEB_THEMES_KEY = "noren.web.themes";
const WEB_STATE_KEY = "noren.web.state";

/** The fixture picture (48 by 32 pixels) and the path the web build serves it under. */
const FIXTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));
const PICTURE = "fixtures/background.png";

async function seedImages(page: Page, files: Record<string, Buffer>): Promise<void> {
  const value = JSON.stringify(
    Object.fromEntries(
      Object.entries(files).map(([path, bytes]) => [path, bytes.toString("base64")]),
    ),
  );
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_IMAGES_KEY, value },
  );
}

async function start(page: Page): Promise<void> {
  await seedImages(page, { [PICTURE]: FIXTURE });
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
}

/** The settings file text with a background in `appearance`. */
const configWith = (background: string, rest = ""): string =>
  `{ "appearance": { ${rest}"background": ${background} } }`;

const layer = (page: Page): Locator => page.locator('[data-nr-part="background"]');
const notice = (page: Page): Locator => page.locator('[data-nr-part="background-notice"]');
const layerStyle = (page: Page, property: string): Promise<string> =>
  layer(page).evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );
const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const pictureAttribute = (page: Page): Promise<string | null> =>
  page.locator("main.app").getAttribute("data-nr-picture");
/** The background of the terminal on screen (xterm sets it on its scrollable element). */
const terminalBackground = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const visible = [...document.querySelectorAll<HTMLElement>(".xterm-scrollable-element")].find(
      (element) => element.getClientRects().length > 0 && element.offsetParent !== null,
    );
    return visible === undefined ? "" : getComputedStyle(visible).backgroundColor;
  });

/** The address of the picture the layer draws, taken from its computed `background-image`. */
async function pictureAddress(page: Page): Promise<string> {
  const image = await layerStyle(page, "background-image");
  const match = /^url\("(blob:[^"]+)"\)$/.exec(image);
  if (match?.[1] === undefined) throw new Error(`not a blob picture: ${image}`);
  return match[1];
}

const switcher = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string): Locator =>
  switcher(page).getByRole("button", { name, exact: true });
const menu = (page: Page, spaceName: string): Locator =>
  page.getByRole("menu", { name: `${spaceName} options`, exact: true });
const menuItem = (page: Page, name: string): Locator =>
  page.getByRole("menuitem", { name, exact: true });

async function createSpace(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function openMenu(page: Page, spaceName: string): Promise<void> {
  await spaceButton(page, spaceName).click({ button: "right" });
  await expect(menu(page, spaceName)).toBeVisible();
}

const backgroundDialog = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Background image", exact: true });

/** Opens the picture dialog of a space from its menu. */
async function openBackgroundDialog(page: Page, spaceName: string): Promise<Locator> {
  await openMenu(page, spaceName);
  await menuItem(page, "Background image…").click();
  const dialog = backgroundDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("on a dark system", () => {
  test.use({ colorScheme: "dark" });

  test("a window with no picture draws nothing behind the terminals", async ({ page }) => {
    await start(page);
    await expect(layer(page)).toHaveCount(0);
    expect(await pictureAttribute(page)).toBeNull();
    expect(await rootVar(page, "--nr-background-image")).toBe("none");
    // The terminal keeps its own solid background.
    expect(await terminalBackground(page)).toBe("rgb(20, 22, 27)");
  });

  test("the picture of the settings file is drawn behind everything, at its opacity and blur", async ({
    page,
  }) => {
    await seedConfig(page, configWith(`{ "image": "${PICTURE}", "opacity": 0.4, "blur": 6 }`));
    await start(page);

    await expect(layer(page)).toHaveCount(1);
    // The computed style of the layer: a picture held in memory, the opacity and the blur asked for,
    // under everything and out of the way of the mouse.
    expect(await layerStyle(page, "background-image")).toMatch(/^url\("blob:/);
    expect(await layerStyle(page, "opacity")).toBe("0.4");
    expect(await layerStyle(page, "filter")).toBe("blur(6px)");
    expect(await layerStyle(page, "position")).toBe("fixed");
    expect(await layerStyle(page, "z-index")).toBe("-1");
    expect(await layerStyle(page, "pointer-events")).toBe("none");
    expect(await layerStyle(page, "background-size")).toBe("cover");
    expect(await pictureAttribute(page)).toBe("shown");
    expect(await rootVar(page, "--nr-background-opacity")).toBe("0.4");
    expect(await rootVar(page, "--nr-background-blur")).toBe("6px");
    // The terminals have no background of their own while a picture shows behind them.
    expect(await terminalBackground(page)).toBe("rgba(20, 22, 27, 0)");
  });

  test("the picture on screen is the bytes of the file, read by the app and not fetched", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await seedConfig(page, configWith(`{ "image": "${PICTURE}" }`));
    await start(page);
    await expect(layer(page)).toHaveCount(1);

    const address = await pictureAddress(page);
    const read = await page.evaluate(async (url) => {
      const response = await fetch(url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const image = new Image();
      image.src = url;
      await image.decode();
      return { bytes: [...bytes], width: image.naturalWidth, height: image.naturalHeight };
    }, address);
    expect(Buffer.from(read.bytes).equals(FIXTURE)).toBe(true);
    expect([read.width, read.height]).toEqual([48, 32]);
    // The page asked for no address that belongs to the picture (a path, a file or a web address).
    expect(requests.filter((url) => url.includes("background.png"))).toEqual([]);
    expect(
      requests.filter((url) => !url.startsWith("http://127.0.0.1") && !url.startsWith("blob:")),
    ).toEqual([]);
  });

  test("a web address is not a picture: the file is refused with its line and nothing is requested", async ({
    page,
  }) => {
    const outside: string[] = [];
    await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (route) => {
      outside.push(route.request().url());
      return route.abort();
    });
    await seedConfig(
      page,
      `{\n  "appearance": {\n    "background": { "image": "https://example.com/sky.png" }\n  }\n}`,
    );
    await start(page);

    const problem = page.locator('[data-nr-part="config-notice"]');
    await expect(problem).toBeVisible();
    await expect(problem).toContainText("appearance.background.image");
    await expect(problem).toContainText("line 3");
    await expect(problem).toContainText("web addresses");
    await expect(layer(page)).toHaveCount(0);
    expect(outside).toEqual([]);
  });

  test("other paths that are not a local picture are refused the same way", async ({ page }) => {
    await start(page);
    const problem = page.locator('[data-nr-part="config-notice"]');
    for (const [image, words] of [
      ["file:///C:/sky.png", "web addresses"],
      ["\\\\\\\\server\\\\share\\\\sky.png", "network paths"],
      ["../sky.png", "climb out"],
      ["notes.txt", "png, jpg"],
    ] as const) {
      await page.evaluate(
        (text) => (window as HookWindow).__norenTest?.setConfig(text),
        configWith(`{ "image": "${image}" }`),
      );
      await expect(problem).toContainText(words);
      await expect(layer(page)).toHaveCount(0);
    }
  });

  test("a file that cannot be read leaves the window as it was, with a notice that says why", async ({
    page,
  }) => {
    await seedConfig(page, configWith(`{ "image": "fixtures/missing.png" }`));
    await start(page);

    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText("The background image cannot be shown.");
    await expect(notice(page)).toContainText("fixtures/missing.png was not found");
    await expect(layer(page)).toHaveCount(0);
    expect(await terminalBackground(page)).toBe("rgb(20, 22, 27)");

    // Closing the notice hides it; putting the file back and pointing at it shows the picture.
    await notice(page).getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(notice(page)).toHaveCount(0);
    await page.evaluate(
      (text) => (window as HookWindow).__norenTest?.setConfig(text),
      configWith(`{ "image": "${PICTURE}" }`),
    );
    await expect(layer(page)).toHaveCount(1);
    await expect(notice(page)).toHaveCount(0);
  });

  test("a file that is text with the name of a picture is not shown", async ({ page }) => {
    await seedImages(page, { "fixtures/fake.png": Buffer.from("not a picture at all") });
    await seedConfig(page, configWith(`{ "image": "fixtures/fake.png" }`));
    await page.goto("/");
    await expect(notice(page)).toContainText("not a picture");
    await expect(layer(page)).toHaveCount(0);
  });

  test("the theme can bring the picture, the settings win part by part, and null takes it away", async ({
    page,
  }) => {
    const theme = {
      ...NOREN_DUSK,
      id: "dusk-sky",
      name: "Dusk Sky",
      background: { image: PICTURE, opacity: 0.3, blur: 2 },
    };
    await page.addInitScript(
      ({ key, value }) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      { key: WEB_THEMES_KEY, value: JSON.stringify({ "dusk-sky": JSON.stringify(theme) }) },
    );
    await seedConfig(page, '{ "appearance": { "theme": "dusk-sky" } }');
    await start(page);

    // The theme brings the picture, and its opacity and blur.
    await expect(layer(page)).toHaveCount(1);
    expect(await layerStyle(page, "opacity")).toBe("0.3");
    expect(await layerStyle(page, "filter")).toBe("blur(2px)");

    // The settings file wins over the theme: a part it sets replaces the theme's.
    await page.evaluate(
      (text) => (window as HookWindow).__norenTest?.setConfig(text),
      '{ "appearance": { "theme": "dusk-sky", "background": { "opacity": 0.7 } } }',
    );
    await expect.poll(() => layerStyle(page, "opacity")).toBe("0.7");
    expect(await layerStyle(page, "filter")).toBe("blur(2px)");

    await page.evaluate(
      (text) => (window as HookWindow).__norenTest?.setConfig(text),
      '{ "appearance": { "theme": "dusk-sky", "background": { "image": null } } }',
    );
    await expect(layer(page)).toHaveCount(0);
  });

  test("the settings screen writes the picture, keeps the comments, and emptying the box writes null", async ({
    page,
  }) => {
    await seedConfig(page, '// my picture\n{\n  "appearance": { "tabs": "sidebar" }, // tabs\n}\n');
    await start(page);

    const screen = await openSettings(page);
    await screen
      .getByRole("textbox", { name: "Background image (file)", exact: true })
      .fill(PICTURE);
    await screen.getByRole("textbox", { name: "Image opacity (0 to 1)", exact: true }).fill("0.5");
    await screen.getByRole("textbox", { name: "Image blur (px)", exact: true }).fill("10");
    await closeSettings(page);

    const text = (await configText(page)) ?? "";
    expect(text).toContain("// my picture");
    expect(text).toContain("// tabs");
    expect(text).toContain(`"image": "${PICTURE}"`);
    expect(text).toContain('"opacity": 0.5');
    expect(text).toContain('"blur": 10');
    await expect(layer(page)).toHaveCount(1);
    expect(await layerStyle(page, "opacity")).toBe("0.5");
    expect(await layerStyle(page, "filter")).toBe("blur(10px)");

    // Back to nothing: the boxes are emptied and null is written, the comments stay.
    const again = await openSettings(page);
    await again.getByRole("textbox", { name: "Background image (file)", exact: true }).fill("");
    await again.getByRole("textbox", { name: "Image opacity (0 to 1)", exact: true }).fill("");
    await again.getByRole("textbox", { name: "Image blur (px)", exact: true }).fill("");
    await closeSettings(page);
    const after = (await configText(page)) ?? "";
    expect(after).toContain("// my picture");
    expect(after).toContain('"image": null');
    expect(after).toContain('"blur": null');
    await expect(layer(page)).toHaveCount(0);
  });

  test("the settings screen refuses a web address where it is typed", async ({ page }) => {
    await start(page);
    const screen = await openSettings(page);
    await screen
      .getByRole("textbox", { name: "Background image (file)", exact: true })
      .fill("https://example.com/sky.png");
    await expect(screen.getByRole("alert").filter({ hasText: "web addresses" })).toBeVisible();
    // A web address is not a picture the file takes: nothing is written for it.
    await page.waitForTimeout(700);
    expect(await configText(page)).toBeNull();
  });

  test("a space can have a picture of its own, that shows only while it is the active space", async ({
    page,
  }) => {
    await start(page);
    await createSpace(page, "Work");
    await expect(layer(page)).toHaveCount(0);

    const dialog = await openBackgroundDialog(page, "Work");
    // Nothing to take away yet.
    await expect(dialog.getByRole("button", { name: "Remove image", exact: true })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Image file", exact: true }).fill(PICTURE);
    await dialog.getByRole("textbox", { name: "Opacity (0 to 1)", exact: true }).fill("0.5");
    await dialog.getByRole("textbox", { name: "Blur (px)", exact: true }).fill("3");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(dialog).toBeHidden();

    // "Work" was created active, so its picture is on screen.
    await expect(layer(page)).toHaveCount(1);
    expect(await layerStyle(page, "opacity")).toBe("0.5");
    expect(await layerStyle(page, "filter")).toBe("blur(3px)");

    // Another space has none.
    await spaceButton(page, "Main").click();
    await expect(layer(page)).toHaveCount(0);
    expect(await pictureAttribute(page)).toBeNull();
    expect(await terminalBackground(page)).toBe("rgb(20, 22, 27)");
    await spaceButton(page, "Work").click();
    await expect(layer(page)).toHaveCount(1);

    // It is kept with the space in state.json, and survives a reload.
    await expect
      .poll(async () => {
        const saved = await page.evaluate((key) => window.localStorage.getItem(key), WEB_STATE_KEY);
        const state = JSON.parse(saved ?? "{}") as {
          spaces?: { name: string; background?: unknown }[];
        };
        return state.spaces?.find((space) => space.name === "Work")?.background;
      })
      .toEqual({ image: PICTURE, opacity: 0.5, blur: 3 });
    await page.reload();
    await expect(layer(page)).toHaveCount(1);
    expect(await layerStyle(page, "opacity")).toBe("0.5");

    // The same menu takes it away.
    await openMenu(page, "Work");
    await menuItem(page, "Remove background image").click();
    await expect(layer(page)).toHaveCount(0);
    await openMenu(page, "Work");
    await expect(menuItem(page, "Remove background image")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("the picture of a space wins over the settings for the parts it sets", async ({ page }) => {
    await seedConfig(page, configWith(`{ "image": "${PICTURE}", "opacity": 0.2, "blur": 5 }`));
    await start(page);
    await expect(layer(page)).toHaveCount(1);
    expect(await layerStyle(page, "opacity")).toBe("0.2");

    // The space sets the opacity and not the blur: the opacity is its own, the blur the settings'.
    const dialog = await openBackgroundDialog(page, "Main");
    // The boxes of a space with no picture are empty, whatever the settings say.
    await expect(dialog.getByRole("textbox", { name: "Image file", exact: true })).toHaveValue("");
    await dialog.getByRole("textbox", { name: "Image file", exact: true }).fill(PICTURE);
    await dialog.getByRole("textbox", { name: "Opacity (0 to 1)", exact: true }).fill("0.9");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(() => layerStyle(page, "opacity")).toBe("0.9");
    expect(await layerStyle(page, "filter")).toBe("blur(5px)");

    // Taking the space's picture away gives the settings' back.
    await openMenu(page, "Main");
    await menuItem(page, "Remove background image").click();
    await expect.poll(() => layerStyle(page, "opacity")).toBe("0.2");
  });

  test("the dialog of a space tells what is wrong with a box and applies nothing", async ({
    page,
  }) => {
    await start(page);
    const dialog = await openBackgroundDialog(page, "Main");
    const apply = dialog.getByRole("button", { name: "Apply", exact: true });

    await apply.click();
    await expect(dialog.getByRole("alert")).toContainText("Give the path of a picture file.");

    await dialog
      .getByRole("textbox", { name: "Image file", exact: true })
      .fill("https://example.com/sky.png");
    await dialog.getByRole("textbox", { name: "Opacity (0 to 1)", exact: true }).fill("3");
    await apply.click();
    await expect(dialog.getByRole("alert").filter({ hasText: "web addresses" })).toBeVisible();
    await expect(dialog.getByRole("alert").filter({ hasText: "0 to 1" })).toBeVisible();
    await expect(layer(page)).toHaveCount(0);

    // Escape writes nothing.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(layer(page)).toHaveCount(0);
  });

  test("a picture and a see-through window go together: the surfaces let it through", async ({
    page,
  }) => {
    await seedConfig(
      page,
      configWith(`{ "image": "${PICTURE}", "opacity": 0.6 }`, '"window": { "opacity": 0.5 }, '),
    );
    await start(page);
    await expect(layer(page)).toHaveCount(1);
    const sidebar = await page.evaluate(() => {
      const element = document.querySelector('[data-nr-part="sidebar"]');
      return element === null ? "" : getComputedStyle(element).backgroundColor;
    });
    expect(sidebar).toBe("rgba(27, 30, 37, 0.5)");
    expect(await terminalBackground(page)).toBe("rgba(20, 22, 27, 0)");
  });
});
