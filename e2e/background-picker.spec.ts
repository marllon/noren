import { readFileSync } from "node:fs";
import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import {
  closeSettings,
  configSaveCount,
  configText,
  openSettings,
  quiet,
  seedConfig,
} from "./settings-fixture";

// Choosing the picture of the background with the file chooser (NOR-F20-08a): the "Choose image…"
// button of the settings screen and of the dialog of a space, the preview of the file chosen and the
// "Remove" button, and the picture that is already in the settings file when the app starts. The
// chooser of the system is never opened: the web build has a fake one, and a test says what it
// answers next (`__norenTest.setImagePick`). The files a path can name are the ones the web build
// holds under `noren.web.images`; the fixture picture is seeded there.

interface Hook {
  paneIds(): string[];
  setImagePick(path: string | null): void;
  failImagePick(message: string): void;
  imagePickCalls(): { title: string; filter: string }[];
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_IMAGES_KEY = "noren.web.images";
const WEB_STATE_KEY = "noren.web.state";

/** The fixture picture (48 by 32 pixels) and the path the web build serves it under. */
const FIXTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));
const PICTURE = "fixtures/background.png";
const OTHER = "fixtures/other.png";

async function seedImages(page: Page): Promise<void> {
  const value = JSON.stringify({
    [PICTURE]: FIXTURE.toString("base64"),
    [OTHER]: FIXTURE.toString("base64"),
  });
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_IMAGES_KEY, value },
  );
}

async function start(page: Page, config?: string): Promise<void> {
  await seedImages(page);
  if (config !== undefined) await seedConfig(page, config);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
}

/** What the fake file chooser answers the next time it is opened. */
const pickNext = (page: Page, path: string | null): Promise<void> =>
  page.evaluate((p) => (window as HookWindow).__norenTest?.setImagePick(p), path);

const pickCalls = (page: Page): Promise<{ title: string; filter: string }[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.imagePickCalls() ?? []);

/** The settings file text with a background in `appearance`. */
const configWith = (background: string, rest = ""): string =>
  `{ ${rest}"appearance": { "background": ${background} } }`;

const layer = (page: Page): Locator => page.locator('[data-nr-part="background"]');
const layerStyle = (page: Page, property: string): Promise<string> =>
  layer(page).evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );

const thumbnail = (within: Locator): Locator =>
  within.locator('[data-nr-part="background-thumbnail"]');
const failureNote = (within: Locator): Locator =>
  within.locator('[data-nr-part="background-thumbnail-failure"]');

/** What the preview really drew: the address it came from and the size of the picture. */
const thumbnailFacts = (within: Locator): Promise<{ src: string; width: number; height: number }> =>
  thumbnail(within).evaluate((element) => {
    const image = element as HTMLImageElement;
    return { src: image.src, width: image.naturalWidth, height: image.naturalHeight };
  });

/**
 * The preview once the picture is decoded. The element is on screen (and visible) a moment before
 * its bytes are read and decoded, so the size, which is `0` until then, is waited for and never
 * read at once.
 */
async function decodedThumbnail(
  within: Locator,
): Promise<{ src: string; width: number; height: number }> {
  await expect
    .poll(async () => {
      const size = await thumbnailFacts(within);
      return [size.width, size.height];
    })
    .toEqual([48, 32]);
  return thumbnailFacts(within);
}

const backgroundSection = (screen: Locator): Locator =>
  screen.locator('[data-nr-part="settings-background"]');

const imageBox = (within: Locator, name = "Background image (file)"): Locator =>
  within.getByRole("textbox", { name, exact: true });

const switcher = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string): Locator =>
  switcher(page).getByRole("button", { name, exact: true });
const menuItem = (page: Page, name: string): Locator =>
  page.getByRole("menuitem", { name, exact: true });

async function createSpace(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
}

const backgroundDialog = (page: Page, title = "Background image"): Locator =>
  page.getByRole("dialog", { name: title, exact: true });

/** Opens the picture dialog of a space from its menu. */
async function openBackgroundDialog(
  page: Page,
  spaceName: string,
  item = "Background image…",
  title = "Background image",
): Promise<Locator> {
  await spaceButton(page, spaceName).click({ button: "right" });
  await menuItem(page, item).click();
  const dialog = backgroundDialog(page, title);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The picture a space holds in the saved state, `undefined` for none. */
const savedBackground = (page: Page, spaceName: string): Promise<unknown> =>
  page.evaluate(
    ({ key, name }) => {
      const state = JSON.parse(window.localStorage.getItem(key) ?? "{}") as {
        spaces?: { name: string; background?: unknown }[];
      };
      return state.spaces?.find((space) => space.name === name)?.background;
    },
    { key: WEB_STATE_KEY, name: spaceName },
  );

test.describe("on a dark system", () => {
  test.use({ colorScheme: "dark" });

  test.describe("the settings screen", () => {
    test("Choose image… opens the chooser, shows what was chosen and writes it at once", async ({
      page,
    }) => {
      await start(page);
      await pickNext(page, PICTURE);
      const screen = await openSettings(page);
      const section = backgroundSection(screen);
      const choose = section.getByRole("button", { name: "Choose image…", exact: true });
      const remove = section.getByRole("button", { name: "Remove", exact: true });

      // Nothing chosen yet: an empty preview, and nothing to remove.
      await expect(thumbnail(section)).toHaveCount(0);
      await expect(section.getByText("No image", { exact: true })).toBeVisible();
      await expect(remove).toBeDisabled();

      await choose.click();
      // The chooser was opened once, with the words of the language in force on it.
      expect(await pickCalls(page)).toEqual([
        { title: "Choose a background image", filter: "Pictures" },
      ]);
      // The preview is the picture itself, read by the app and held in memory (not fetched), and
      // the box shows the path that was chosen.
      await expect(thumbnail(section)).toBeVisible();
      const facts = await decodedThumbnail(section);
      expect(facts.src).toMatch(/^blob:/);
      await expect(thumbnail(section)).toHaveAttribute("alt", "Preview of the image");
      await expect(imageBox(section)).toHaveValue(PICTURE);
      await expect(remove).toBeEnabled();
      // The window shows the picture as soon as it is chosen, and the file names it: there is no
      // Save to press.
      await expect(layer(page)).toHaveCount(1);
      expect(await layerStyle(page, "background-image")).toMatch(/^url\("blob:/);
      await expect
        .poll(async () => (await configText(page)) ?? "")
        .toContain(`"image": "${PICTURE}"`);

      await closeSettings(page);
      expect(await configText(page)).toContain(`"image": "${PICTURE}"`);
      await expect(layer(page)).toHaveCount(1);
      expect(await layerStyle(page, "background-image")).toMatch(/^url\("blob:/);
    });

    test("closing the chooser without a choice changes nothing", async ({ page }) => {
      await start(page);
      await pickNext(page, null);
      const screen = await openSettings(page);
      const section = backgroundSection(screen);
      await section.getByRole("button", { name: "Choose image…", exact: true }).click();
      await expect.poll(() => pickCalls(page).then((calls) => calls.length)).toBe(1);
      await expect(thumbnail(section)).toHaveCount(0);
      await expect(imageBox(section)).toHaveValue("");
      await quiet(page);
      expect(await configSaveCount(page)).toBe(0);
      // The button is ready for another try.
      await expect(
        section.getByRole("button", { name: "Choose image…", exact: true }),
      ).toBeEnabled();
    });

    test("Remove goes back to no image, and writes null at once", async ({ page }) => {
      await start(page, configWith(`{ "image": "${PICTURE}" }`, '// kept\n"language": "en", '));
      const screen = await openSettings(page);
      const section = backgroundSection(screen);
      // The picture of the settings file is on the preview from the start.
      await expect(thumbnail(section)).toBeVisible();
      await expect(imageBox(section)).toHaveValue(PICTURE);

      await section.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(thumbnail(section)).toHaveCount(0);
      await expect(section.getByText("No image", { exact: true })).toBeVisible();
      await expect(imageBox(section)).toHaveValue("");
      await expect(section.getByRole("button", { name: "Remove", exact: true })).toBeDisabled();
      await expect.poll(async () => (await configText(page)) ?? "").toContain('"image": null');
      await expect(layer(page)).toHaveCount(0);

      await closeSettings(page);
      const text = (await configText(page)) ?? "";
      expect(text).toContain("// kept");
      expect(text).toContain('"image": null');
      await expect(layer(page)).toHaveCount(0);
    });

    test("a picture chosen and then removed leaves the file with no picture", async ({ page }) => {
      await start(page);
      await pickNext(page, PICTURE);
      const screen = await openSettings(page);
      const section = backgroundSection(screen);
      await section.getByRole("button", { name: "Choose image…", exact: true }).click();
      await expect(thumbnail(section)).toBeVisible();
      await expect
        .poll(async () => (await configText(page)) ?? "")
        .toContain(`"image": "${PICTURE}"`);
      await section.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(thumbnail(section)).toHaveCount(0);
      await expect.poll(async () => (await configText(page)) ?? "").toContain('"image": null');
      expect(await configText(page)).not.toContain(PICTURE);
      await expect(layer(page)).toHaveCount(0);
    });

    test("the box still takes a path typed by hand, and the preview follows it", async ({
      page,
    }) => {
      await start(page);
      const screen = await openSettings(page);
      const section = backgroundSection(screen);
      await imageBox(section).fill(OTHER);
      await expect(thumbnail(section)).toBeVisible();
      expect((await decodedThumbnail(section)).width).toBe(48);
      // A path that cannot be a background has no preview and asks the backend for nothing; the
      // box tells why, as before.
      await imageBox(section).fill("https://example.com/sky.png");
      await expect(thumbnail(section)).toHaveCount(0);
      await expect(section.getByRole("alert").filter({ hasText: "web addresses" })).toBeVisible();
      // The picture that could be read is in the file; the web address, which is no picture, is not.
      await quiet(page);
      expect(await configText(page)).toContain(`"image": "${OTHER}"`);
      expect(await configText(page)).not.toContain("https://");
    });

    test("a file that cannot be read says why under the preview", async ({ page }) => {
      await start(page);
      await pickNext(page, "fixtures/missing.png");
      const screen = await openSettings(page);
      const section = backgroundSection(screen);
      await section.getByRole("button", { name: "Choose image…", exact: true }).click();
      await expect(failureNote(section)).toContainText("The image cannot be shown:");
      await expect(failureNote(section)).toContainText("fixtures/missing.png was not found");
      await expect(thumbnail(section)).toHaveCount(0);
      // The path is in the box, so the person can fix it or remove it, and it is not in the file: a
      // path the window cannot read is not a picture to keep.
      await expect(imageBox(section)).toHaveValue("fixtures/missing.png");
      await expect(section.getByRole("button", { name: "Remove", exact: true })).toBeEnabled();
      await quiet(page);
      expect(await configSaveCount(page)).toBe(0);
    });

    test("a path typed wrong is not written, and the right one is written once the window can read it", async ({
      page,
    }) => {
      await start(page);
      const screen = await openSettings(page);
      const section = backgroundSection(screen);
      // A path with a letter missing, then the right one: nothing is written for the wrong one (there is no
      // such file), and the window never asked for it.
      await imageBox(section).fill("fixtures/backgroun.png");
      await expect(failureNote(section)).toBeVisible();
      await quiet(page);
      expect(await configSaveCount(page)).toBe(0);
      await expect(layer(page)).toHaveCount(0);
      await imageBox(section).fill(PICTURE);
      await expect.poll(() => configSaveCount(page)).toBe(1);
      expect(await configText(page)).toContain(`"image": "${PICTURE}"`);
      await expect(layer(page)).toHaveCount(1);
    });

    test("a chooser that cannot be opened says why and can be tried again", async ({ page }) => {
      await start(page);
      await page.evaluate(() =>
        (
          window as HookWindow & { __norenTest?: Hook & { failImagePick(m: string): void } }
        ).__norenTest?.failImagePick("no window to open it over"),
      );
      const screen = await openSettings(page);
      const section = backgroundSection(screen);
      const choose = section.getByRole("button", { name: "Choose image…", exact: true });
      await choose.click();
      await expect(section.getByRole("alert")).toContainText(
        "The file chooser could not be opened: no window to open it over",
      );
      await expect(choose).toBeEnabled();
      await expect(imageBox(section)).toHaveValue("");
      // The next opening works, and the note goes.
      await pickNext(page, PICTURE);
      await choose.click();
      await expect(thumbnail(section)).toBeVisible();
      await expect(section.getByRole("alert")).toHaveCount(0);
    });

    test("the picture of the settings file at the start shows in the window and in the screen", async ({
      page,
    }) => {
      await start(page, configWith(`{ "image": "${PICTURE}", "opacity": 0.4 }`));
      // The window draws it from the first moment (it used to ask for the picture
      // before the app had given the store its backend, and never again).
      await expect(layer(page)).toHaveCount(1);
      expect(await layerStyle(page, "background-image")).toMatch(/^url\("blob:/);
      expect(await layerStyle(page, "opacity")).toBe("0.4");
      await expect(page.locator('[data-nr-part="background-notice"]')).toHaveCount(0);
      const screen = await openSettings(page);
      await expect(thumbnail(backgroundSection(screen))).toBeVisible();
    });
  });

  test.describe("the background dialog of a space", () => {
    test("Choose image… shows the preview, and Apply gives the space its picture", async ({
      page,
    }) => {
      await start(page);
      await createSpace(page, "Work");
      await pickNext(page, PICTURE);
      const dialog = await openBackgroundDialog(page, "Work");
      const remove = dialog.getByRole("button", { name: "Remove", exact: true });
      await expect(thumbnail(dialog)).toHaveCount(0);
      await expect(remove).toBeDisabled();

      await dialog.getByRole("button", { name: "Choose image…", exact: true }).click();
      expect(await pickCalls(page)).toEqual([
        { title: "Choose a background image", filter: "Pictures" },
      ]);
      await expect(thumbnail(dialog)).toBeVisible();
      const facts = await decodedThumbnail(dialog);
      expect(facts.src).toMatch(/^blob:/);
      await expect(imageBox(dialog, "Image file")).toHaveValue(PICTURE);
      await expect(layer(page)).toHaveCount(0);

      await dialog.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(layer(page)).toHaveCount(1);
      await expect.poll(() => savedBackground(page, "Work")).toEqual({ image: PICTURE });

      // Another space has none; coming back, the dialog shows the picture of the space.
      await spaceButton(page, "Main").click();
      await expect(layer(page)).toHaveCount(0);
      await spaceButton(page, "Work").click();
      const again = await openBackgroundDialog(page, "Work");
      await expect(thumbnail(again)).toBeVisible();
      await expect(imageBox(again, "Image file")).toHaveValue(PICTURE);
    });

    test("closing the chooser without a choice changes nothing", async ({ page }) => {
      await start(page);
      await pickNext(page, null);
      const dialog = await openBackgroundDialog(page, "Main");
      await dialog.getByRole("button", { name: "Choose image…", exact: true }).click();
      await expect.poll(() => pickCalls(page).then((calls) => calls.length)).toBe(1);
      await expect(thumbnail(dialog)).toHaveCount(0);
      await expect(imageBox(dialog, "Image file")).toHaveValue("");
    });

    test("Remove takes the picture the preview shows away from the space", async ({ page }) => {
      await start(page);
      await createSpace(page, "Work");
      await pickNext(page, PICTURE);
      const dialog = await openBackgroundDialog(page, "Work");
      await dialog.getByRole("button", { name: "Choose image…", exact: true }).click();
      await dialog.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(layer(page)).toHaveCount(1);

      const again = await openBackgroundDialog(page, "Work");
      await expect(thumbnail(again)).toBeVisible();
      await again.getByRole("button", { name: "Remove", exact: true }).click();
      // The space is back to the settings and the theme at once, and the dialog is closed.
      await expect(again).toBeHidden();
      await expect(layer(page)).toHaveCount(0);
      await expect.poll(() => savedBackground(page, "Work")).toBeUndefined();
    });

    test("Remove on a picture that was only chosen goes back to the one of the space", async ({
      page,
    }) => {
      await start(page);
      await createSpace(page, "Work");
      await pickNext(page, PICTURE);
      const first = await openBackgroundDialog(page, "Work");
      await first.getByRole("button", { name: "Choose image…", exact: true }).click();
      await first.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(layer(page)).toHaveCount(1);

      // A second picture, chosen and not applied: Remove lets it go and the first one is back.
      await pickNext(page, OTHER);
      const dialog = await openBackgroundDialog(page, "Work");
      await dialog.getByRole("button", { name: "Choose image…", exact: true }).click();
      await expect(imageBox(dialog, "Image file")).toHaveValue(OTHER);
      await dialog.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(imageBox(dialog, "Image file")).toHaveValue(PICTURE);
      await expect(thumbnail(dialog)).toBeVisible();
      // The picture of the space was not touched.
      await expect(layer(page)).toHaveCount(1);
      await expect.poll(() => savedBackground(page, "Work")).toEqual({ image: PICTURE });
    });

    test("on a space with no picture, Remove on a chosen one leaves the box empty", async ({
      page,
    }) => {
      await start(page);
      await pickNext(page, PICTURE);
      const dialog = await openBackgroundDialog(page, "Main");
      await dialog.getByRole("button", { name: "Choose image…", exact: true }).click();
      await expect(thumbnail(dialog)).toBeVisible();
      await dialog.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(thumbnail(dialog)).toHaveCount(0);
      await expect(imageBox(dialog, "Image file")).toHaveValue("");
      await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeDisabled();
    });

    test("a chooser that cannot be opened says why", async ({ page }) => {
      await start(page);
      await page.evaluate(() =>
        (
          window as HookWindow & { __norenTest?: Hook & { failImagePick(m: string): void } }
        ).__norenTest?.failImagePick("no window to open it over"),
      );
      const dialog = await openBackgroundDialog(page, "Main");
      await dialog.getByRole("button", { name: "Choose image…", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText(
        "The file chooser could not be opened: no window to open it over",
      );
      await expect(
        dialog.getByRole("button", { name: "Choose image…", exact: true }),
      ).toBeEnabled();
    });
  });

  test.describe("in Portuguese", () => {
    test("the settings screen and the dialog of a space say it in Portuguese", async ({ page }) => {
      await start(page, '{ "language": "pt-BR" }');
      await pickNext(page, PICTURE);
      await page.getByRole("button", { name: "Configurações", exact: true }).click();
      const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
      const section = backgroundSection(screen);
      await expect(section.getByText("Sem imagem", { exact: true })).toBeVisible();
      await section.getByRole("button", { name: "Escolher imagem…", exact: true }).click();
      await expect(thumbnail(section)).toHaveAttribute("alt", "Prévia da imagem");
      expect(await pickCalls(page)).toEqual([
        { title: "Escolher uma imagem de fundo", filter: "Imagens" },
      ]);
      await section.getByRole("button", { name: "Remover", exact: true }).click();
      await expect(thumbnail(section)).toHaveCount(0);
      await screen.getByRole("button", { name: "Fechar", exact: true }).click();

      await pickNext(page, PICTURE);
      await page
        .locator('[data-nr-part="space-switcher"]')
        .getByRole("button")
        .first()
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "Imagem de fundo…", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Imagem de fundo", exact: true });
      await dialog.getByRole("button", { name: "Escolher imagem…", exact: true }).click();
      await expect(thumbnail(dialog)).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Remover", exact: true })).toBeEnabled();
    });

    test("a refusal to read the file is told in Portuguese", async ({ page }) => {
      await start(page, '{ "language": "pt-BR" }');
      await pickNext(page, "fixtures/missing.png");
      await page.getByRole("button", { name: "Configurações", exact: true }).click();
      const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
      const section = backgroundSection(screen);
      await section.getByRole("button", { name: "Escolher imagem…", exact: true }).click();
      await expect(failureNote(section)).toContainText("Não foi possível mostrar a imagem:");
    });
  });

  test.describe("accessibility (axe, any impact)", () => {
    test("the settings screen with the preview on", async ({ page }) => {
      await start(page);
      await pickNext(page, PICTURE);
      const screen = await openSettings(page);
      const section = backgroundSection(screen);
      await section.getByRole("button", { name: "Choose image…", exact: true }).click();
      await expect(thumbnail(section)).toBeVisible();
      await section.scrollIntoViewIfNeeded();
      await expectNoAxeViolations(page, "the settings screen with the picture preview");
    });

    test("the settings screen with no picture, and with a preview that failed", async ({
      page,
    }) => {
      await start(page);
      const screen = await openSettings(page);
      await backgroundSection(screen).scrollIntoViewIfNeeded();
      await expectNoAxeViolations(page, "the settings screen with an empty picture chooser");
      await imageBox(backgroundSection(screen)).fill("fixtures/missing.png");
      await expect(failureNote(backgroundSection(screen))).toBeVisible();
      await expectNoAxeViolations(page, "the settings screen with a preview that failed");
    });

    test("the background dialog of a space with the preview on", async ({ page }) => {
      await start(page);
      await pickNext(page, PICTURE);
      const dialog = await openBackgroundDialog(page, "Main");
      await dialog.getByRole("button", { name: "Choose image…", exact: true }).click();
      await expect(thumbnail(dialog)).toBeVisible();
      await expectNoAxeViolations(
        page,
        "the background dialog of a space with the picture preview",
      );
    });

    test("the background dialog of a space with no picture", async ({ page }) => {
      await start(page);
      await openBackgroundDialog(page, "Main");
      await expectNoAxeViolations(page, "the background dialog of a space with no picture");
    });
  });
});

test.describe("on a light system", () => {
  test.use({ colorScheme: "light" });

  test("axe on the picture chooser of the settings screen and of a space", async ({ page }) => {
    await start(page);
    await pickNext(page, PICTURE);
    const screen = await openSettings(page);
    const section = backgroundSection(screen);
    await section.getByRole("button", { name: "Choose image…", exact: true }).click();
    await expect(thumbnail(section)).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await expectNoAxeViolations(page, "the settings screen with the picture preview, light");
    await screen.getByRole("button", { name: "Close", exact: true }).click();

    await pickNext(page, PICTURE);
    const dialog = await openBackgroundDialog(page, "Main");
    await dialog.getByRole("button", { name: "Choose image…", exact: true }).click();
    await expect(thumbnail(dialog)).toBeVisible();
    await expectNoAxeViolations(page, "the background dialog of a space with the preview, light");
  });
});
