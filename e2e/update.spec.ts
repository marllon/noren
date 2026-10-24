import { expect, test } from "./test";
import type { Page } from "@playwright/test";
import { closeSettings, openSettings } from "./settings-fixture";
import { openCommandPalette } from "./palette-fixture";

// The update of the app in the web build (NOR-F20-02a): no screen drives it yet (the button, the
// palette command and the notice of a new version are NOR-F20-02b), so these tests hold the two
// things the layers below must keep. First, the page never checks for an update and never installs
// one by itself: a release newer than the page is seeded, the page is used the way a person uses
// it, and not one call of the update reaches the backend. Second, the seed under `noren.web.update`
// reaches the backend of the built page and the steps go the way the app's go: a check keeps the
// update only when it is newer, an install needs one found and is told how the download goes, a
// package the signature does not match is refused after it came and installs nothing, and a build
// with no key refuses before anything. The real thing (the plugin, the signature, the server) is
// tested in Rust against a server on 127.0.0.1.

interface Hook {
  paneIds(): string[];
  updateCalls(): string[];
  installedUpdates(): string[];
  updateStep(step: "status" | "check" | "install"): Promise<unknown>;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_UPDATE_KEY = "noren.web.update";

async function start(page: Page, seed: unknown): Promise<void> {
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: WEB_UPDATE_KEY,
    value: JSON.stringify(seed),
  });
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
}

const step = (page: Page, which: "status" | "check" | "install"): Promise<unknown> =>
  page.evaluate((s) => (window as HookWindow).__norenTest?.updateStep(s), which);

/** The sentence a step is rejected with, or `null` when it is not rejected. */
const refusal = (page: Page, which: "status" | "check" | "install"): Promise<string | null> =>
  page.evaluate(
    (s) =>
      (window as HookWindow).__norenTest
        ?.updateStep(s)
        .then(() => null)
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error))) ??
      null,
    which,
  );

const calls = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.updateCalls() ?? []);
const installed = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.installedUpdates() ?? []);

test("the page never checks for an update or installs one by itself", async ({ page }) => {
  await start(page, { release: { version: "9.9.9", notes: "A lot better" } });
  // Used the way a person uses it: the settings screen, the palette, a second tab.
  await openSettings(page);
  await closeSettings(page);
  await openCommandPalette(page);
  await expect(page.locator('[data-nr-part="palette"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+T");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  // Long enough for a timer at start to have fired, and a reload does not change the answer.
  await page.waitForTimeout(1500);
  expect(await calls(page)).toEqual([]);
  expect(await installed(page)).toEqual([]);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  await page.waitForTimeout(500);
  expect(await calls(page)).toEqual([]);
  expect(await installed(page)).toEqual([]);
});

test("a check keeps a newer release, and the install is a step of its own", async ({ page }) => {
  await start(page, {
    currentVersion: "0.1.0",
    release: { version: "0.2.0", notes: "Fixes", publishedAt: 1_792_584_000, bytes: 4000 },
  });
  expect(await step(page, "status")).toEqual({
    configured: true,
    currentVersion: "0.1.0",
    pending: null,
  });
  // An install with nothing found is refused, and a check installs nothing.
  expect(await refusal(page, "install")).toBe("there is no update to install: check first");
  const found = {
    version: "0.2.0",
    currentVersion: "0.1.0",
    notes: "Fixes",
    publishedAt: 1_792_584_000,
  };
  expect(await step(page, "check")).toEqual(found);
  expect(await installed(page)).toEqual([]);
  expect(await step(page, "status")).toEqual({
    configured: true,
    currentVersion: "0.1.0",
    pending: found,
  });
  expect(await step(page, "install")).toBeNull();
  expect(await installed(page)).toEqual(["0.2.0"]);
  expect(await calls(page)).toEqual([
    "updateStatus",
    "updateInstall",
    "updateCheck",
    "updateStatus",
    "updateInstall",
  ]);
  expect(await step(page, "status")).toMatchObject({ pending: null });
});

test("a release that is not newer is no update", async ({ page }) => {
  for (const version of ["0.1.0", "0.0.9"]) {
    await start(page, { release: { version } });
    expect(await step(page, "check"), version).toBeNull();
    expect(await refusal(page, "install"), version).toBe(
      "there is no update to install: check first",
    );
    expect(await installed(page), version).toEqual([]);
  }
});

test("a package the signature does not match is refused, and nothing is installed", async ({
  page,
}) => {
  await start(page, {
    release: {
      version: "0.2.0",
      refusal: "the signature does not match the package and the update key",
    },
  });
  expect(await step(page, "check")).toMatchObject({ version: "0.2.0" });
  expect(await refusal(page, "install")).toBe(
    "the update was refused: the signature does not match the package and the update key",
  );
  expect(await installed(page)).toEqual([]);
  // Still found: the person can try again once the release is fixed.
  expect(await step(page, "status")).toMatchObject({ pending: { version: "0.2.0" } });
});

test("a build with no update key refuses to check and to install", async ({ page }) => {
  await start(page, { configured: false, release: { version: "0.2.0" } });
  expect(await step(page, "status")).toMatchObject({ configured: false });
  const message = "this build has no update key yet, so it cannot check or install updates";
  expect(await refusal(page, "check")).toBe(message);
  expect(await refusal(page, "install")).toBe(message);
  expect(await installed(page)).toEqual([]);
});

test("a server that cannot be reached is an error with its words, not a crash", async ({
  page,
}) => {
  await start(page, {
    release: { version: "0.2.0" },
    failure: "the update server could not be reached: offline",
  });
  expect(await refusal(page, "check")).toBe("the update server could not be reached: offline");
  // The page is still there.
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
});
