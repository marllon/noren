import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { NOREN_DUSK } from "../packages/model/src/builtin-themes";
import {
  FAKE_GALLERY_EMBER,
  FAKE_GALLERY_HASHES,
  FAKE_GALLERY_LAGOON,
  FAKE_GALLERY_MOD,
} from "../packages/model/src/gallery-fixture";
import { expectNoAxeViolations } from "./axe-fixture";
import { closeSettings, openSettings } from "./settings-fixture";

// The gallery section of the settings screen (NOR-F18-02b): the index (here a fixture seeded under
// `noren.web.gallery`, so nothing touches the network) set against what is installed, an Install
// button for a new item, Update for one with a newer version, none for one that is up to date, and
// the reason shown on the row when the hash does not match or the theme is not usable. The web build
// keeps the theme and mod files under `noren.web.themes` and `noren.web.mods`.

interface Hook {
  paneIds(): string[];
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_GALLERY_KEY = "noren.web.gallery";
const WEB_THEMES_KEY = "noren.web.themes";
const WEB_MODS_KEY = "noren.web.mods";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const size = (text: string): number => Buffer.byteLength(text, "utf8");

const MOD_V2 = `${FAKE_GALLERY_MOD}/* 1.1.0: a little more room. */\n`;
// A theme whose hash is right and whose content is not a theme: the core installs it, the screen says so.
const BROKEN_THEME = `${JSON.stringify({ ...NOREN_DUSK, id: "broken", name: "Broken", terminal: { ansi: ["#000"] } })}\n`;

const item = (
  id: string,
  kind: "theme" | "mod",
  name: string,
  version: string,
  text: string,
  declared = hash(text),
) => ({
  id,
  kind,
  name,
  version,
  url: `https://gallery.example/${id}`,
  sha256: declared,
  size: size(text),
});

async function seedGallery(page: Page): Promise<void> {
  const seed = {
    index: {
      version: 1,
      items: [
        item("lagoon", "theme", "Lagoon", "1.1.0", FAKE_GALLERY_LAGOON),
        item("compact-tabs", "mod", "Rounded corners", "1.1.0", MOD_V2),
        item("ember", "theme", "Ember", "1.0.0", FAKE_GALLERY_EMBER),
        // The index declares a hash that is not the one of what the address serves.
        item("tampered", "theme", "Tampered", "1.0.0", "{}", "0".repeat(64)),
        item("broken", "theme", "Broken", "1.0.0", BROKEN_THEME),
      ],
    },
    downloads: {
      lagoon: { text: FAKE_GALLERY_LAGOON, sha256: hash(FAKE_GALLERY_LAGOON) },
      "compact-tabs": { text: MOD_V2, sha256: hash(MOD_V2) },
      ember: { text: FAKE_GALLERY_EMBER, sha256: hash(FAKE_GALLERY_EMBER) },
      tampered: { text: "{}", sha256: hash("{}") },
      broken: { text: BROKEN_THEME, sha256: hash(BROKEN_THEME) },
    },
    installed: [
      {
        id: "compact-tabs",
        kind: "mod",
        version: "1.0.0",
        sha256: FAKE_GALLERY_HASHES["compact-tabs"],
      },
      { id: "ember", kind: "theme", version: "1.0.0", sha256: FAKE_GALLERY_HASHES.ember },
    ],
  };
  await page.addInitScript(
    ({ key, value, modsKey, mods, themesKey, themes }) => {
      window.localStorage.setItem(key, value);
      if (window.localStorage.getItem(modsKey) === null) window.localStorage.setItem(modsKey, mods);
      if (window.localStorage.getItem(themesKey) === null) {
        window.localStorage.setItem(themesKey, themes);
      }
    },
    {
      key: WEB_GALLERY_KEY,
      value: JSON.stringify(seed),
      modsKey: WEB_MODS_KEY,
      mods: JSON.stringify({ "compact-tabs.css": FAKE_GALLERY_MOD }),
      themesKey: WEB_THEMES_KEY,
      themes: JSON.stringify({ ember: FAKE_GALLERY_EMBER }),
    },
  );
}

async function start(page: Page): Promise<Locator> {
  await seedGallery(page);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  const screen = await openSettings(page);
  return screen.getByRole("region", { name: "Gallery", exact: true });
}

const row = (gallery: Locator, name: string): Locator =>
  gallery.locator('[data-nr-part="settings-gallery-item"]').filter({ hasText: name });

const stored = (page: Page, key: string): Promise<Record<string, string>> =>
  page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) ?? "{}"), key);

test("lists the index against what is installed, with the right button for each row", async ({
  page,
}) => {
  const gallery = await start(page);
  await expect(row(gallery, "Lagoon")).toHaveCount(1);
  await expect(row(gallery, "Lagoon")).toContainText("Theme · version 1.1.0");
  await expect(row(gallery, "Lagoon")).toContainText("Not installed");
  await expect(gallery.getByRole("button", { name: "Install Lagoon", exact: true })).toBeVisible();

  await expect(row(gallery, "Rounded corners")).toContainText(
    "Mod · version 1.1.0 · installed 1.0.0",
  );
  await expect(row(gallery, "Rounded corners")).toContainText("Update available");
  await expect(
    gallery.getByRole("button", { name: "Update Rounded corners", exact: true }),
  ).toBeVisible();

  await expect(row(gallery, "Ember")).toContainText("Up to date");
  await expect(row(gallery, "Ember")).toContainText("installed 1.0.0");
  await expect(row(gallery, "Ember").getByRole("button")).toHaveCount(0);
});

test("installing a theme puts it among the themes of the app", async ({ page }) => {
  const gallery = await start(page);
  await gallery.getByRole("button", { name: "Install Lagoon", exact: true }).click();
  await expect(row(gallery, "Lagoon").getByRole("status")).toHaveText("Lagoon is installed.");
  await expect(row(gallery, "Lagoon")).toContainText("Up to date");
  await expect(row(gallery, "Lagoon").getByRole("button")).toHaveCount(0);
  expect(Object.keys(await stored(page, WEB_THEMES_KEY)).sort()).toEqual(["ember", "lagoon"]);

  await closeSettings(page);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type(">theme: lagoon");
  const options = page.locator('[data-nr-part="palette"]').getByRole("option");
  await expect(options).toHaveCount(1);
  await expect(options.first().locator(".palette-title")).toHaveText("Theme: Lagoon");
});

test("updating a mod changes its version and replaces its file", async ({ page }) => {
  const gallery = await start(page);
  expect((await stored(page, WEB_MODS_KEY))["compact-tabs.css"]).toBe(FAKE_GALLERY_MOD);
  await gallery.getByRole("button", { name: "Update Rounded corners", exact: true }).click();
  await expect(row(gallery, "Rounded corners").getByRole("status")).toHaveText(
    "Rounded corners is installed.",
  );
  await expect(row(gallery, "Rounded corners")).toContainText(
    "Mod · version 1.1.0 · installed 1.1.0",
  );
  await expect(row(gallery, "Rounded corners")).toContainText("Up to date");
  await expect(row(gallery, "Rounded corners").getByRole("button")).toHaveCount(0);
  expect((await stored(page, WEB_MODS_KEY))["compact-tabs.css"]).toBe(MOD_V2);
});

test("a hash that does not match shows the error on the row and installs nothing", async ({
  page,
}) => {
  const gallery = await start(page);
  await gallery.getByRole("button", { name: "Install Tampered", exact: true }).click();
  const said = row(gallery, "Tampered").getByRole("status");
  await expect(said).toContainText("Could not install Tampered:");
  await expect(said).toContainText("does not match the sha256 of the index");
  await expect(row(gallery, "Tampered")).toContainText("Not installed");
  await expect(
    gallery.getByRole("button", { name: "Install Tampered", exact: true }),
  ).toBeEnabled();
  expect(Object.keys(await stored(page, WEB_THEMES_KEY))).toEqual(["ember"]);
  // The other rows are untouched.
  await expect(row(gallery, "Lagoon").getByRole("status")).toHaveCount(0);
});

test("a theme that passes the hash but is not a theme is said so and left out of the themes", async ({
  page,
}) => {
  const gallery = await start(page);
  await gallery.getByRole("button", { name: "Install Broken", exact: true }).click();
  const said = row(gallery, "Broken").getByRole("status");
  await expect(said).toContainText("Broken was installed, but it is not a usable theme");
  await expect(said).toContainText("terminal");

  await closeSettings(page);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type(">theme: broken");
  await expect(page.locator('[data-nr-part="palette"]').getByRole("option")).toHaveCount(0);
});

test.describe("accessibility", () => {
  test("axe: the gallery with new, outdated and up to date items has no violation", async ({
    page,
  }) => {
    const gallery = await start(page);
    await expect(row(gallery, "Lagoon")).toHaveCount(1);
    await gallery.scrollIntoViewIfNeeded();
    await expectNoAxeViolations(page, "gallery");
  });

  test("axe: the gallery with an installed item, a hash that does not match and a broken theme has no violation", async ({
    page,
  }) => {
    const gallery = await start(page);
    await gallery.getByRole("button", { name: "Install Lagoon", exact: true }).click();
    await expect(row(gallery, "Lagoon").getByRole("status")).toHaveText("Lagoon is installed.");
    await gallery.getByRole("button", { name: "Install Tampered", exact: true }).click();
    await expect(row(gallery, "Tampered").getByRole("status")).toContainText("Could not install");
    await gallery.getByRole("button", { name: "Install Broken", exact: true }).click();
    await expect(row(gallery, "Broken").getByRole("status")).toContainText("not a usable theme");
    await gallery.scrollIntoViewIfNeeded();
    await expectNoAxeViolations(page, "gallery, with notes");
  });
});
