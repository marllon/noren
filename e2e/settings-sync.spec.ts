import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { FAKE_GALLERY_LAGOON } from "../packages/model/src/gallery-fixture";
import { expectNoAxeViolations } from "./axe-fixture";
import { closeSettings, configText, openSettings, seedConfig } from "./settings-fixture";
import { openCommandPalette } from "./palette-fixture";

// The Sync section of the settings screen and the "Pull settings" and "Push settings" commands of
// the palette (NOR-F19-01b). The sync is the in-memory one of the web build, seeded under
// `noren.web.sync` (the files of this computer and the files another computer already pushed), so
// nothing runs git or touches a network. Connecting shows the status, an address that is refused
// says why and connects nothing, a push sends the pending files, a pull brings the remote's files
// where the app reads them, a conflict lists the paths and changes nothing, and a failure of git
// shows its own text.

interface Hook {
  paneIds(): string[];
  syncCalls(): { method: string; remote?: string }[];
  syncLocalFile(path: string): string | null;
  syncRemoteFiles(): Record<string, string>;
  setSyncLocalFile(path: string, text: string | null): void;
  setSyncRemoteFile(path: string, text: string | null): void;
  failSync(message: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_SYNC_KEY = "noren.web.sync";
const WEB_THEMES_KEY = "noren.web.themes";
const WEB_MODS_KEY = "noren.web.mods";

const REMOTE = "https://example.com/me/noren-settings.git";
const MINE = '// mine\n{ "terminal": { "scrollback": 500 } }\n';
const THEIRS = '// theirs\n{ "terminal": { "scrollback": 4321 } }\n';
const MOD = "/* rounded corners */\n";

interface Seed {
  localFiles?: Record<string, string>;
  remoteFiles?: Record<string, string>;
  failure?: string;
}

const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const box = (page: Page): Locator =>
  palette(page).getByRole("combobox", { name: "Command palette", exact: true });
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');

async function start(page: Page, seed: Seed, config: string | null = null): Promise<void> {
  // Only on the first load, so a reload finds the sync as the app left it.
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_SYNC_KEY, value: JSON.stringify(seed) },
  );
  if (config !== null) await seedConfig(page, config);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
}

async function openSync(page: Page): Promise<{ screen: Locator; sync: Locator }> {
  const screen = await openSettings(page);
  return { screen, sync: screen.getByRole("region", { name: "Sync", exact: true }) };
}

const status = (sync: Locator): Locator => sync.locator('[data-nr-part="settings-sync-status"]');
const note = (sync: Locator): Locator => sync.locator('[data-nr-part="settings-sync-note"]');
const remoteBox = (sync: Locator): Locator =>
  sync.getByRole("textbox", { name: "Remote address", exact: true });
const button = (sync: Locator, name: string): Locator =>
  sync.getByRole("button", { name, exact: true });

async function connect(sync: Locator, address = REMOTE): Promise<void> {
  await remoteBox(sync).fill(address);
  await button(sync, "Connect").click();
}

const calls = (page: Page): Promise<{ method: string; remote?: string }[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.syncCalls() ?? []);
const localFile = (page: Page, path: string): Promise<string | null> =>
  page.evaluate((p) => (window as HookWindow).__norenTest?.syncLocalFile(p) ?? null, path);
const remoteFiles = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.syncRemoteFiles() ?? {});
const stored = (page: Page, key: string): Promise<Record<string, string>> =>
  page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) ?? "{}"), key);

/** Runs the palette command whose title is `title`, found by typing `query`. */
async function runCommand(page: Page, query: string, title: string): Promise<void> {
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await openCommandPalette(page);
  await expect(palette(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
  await box(page).fill(`>${query}`);
  await expect(palette(page).getByRole("option").first().locator(".palette-title")).toHaveText(
    title,
  );
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
}

test("starts not connected, then Connect shows the status and warns what travels", async ({
  page,
}) => {
  await start(page, { localFiles: { "config.jsonc": MINE } });
  const { sync } = await openSync(page);
  await expect(status(sync)).toHaveText("Not connected to a remote.");
  await expect(button(sync, "Pull")).toBeDisabled();
  await expect(button(sync, "Push")).toBeDisabled();
  // Before connecting the section already says what travels and what the app cannot ask.
  await expect(sync.locator('[data-nr-part="settings-sync-warning"]')).toContainText(
    "All of config.jsonc is sent",
  );

  await connect(sync);
  await expect(status(sync)).toHaveText(`Connected to ${REMOTE} (branch main). 1 file to send.`);
  await expect(sync.locator('[data-nr-part="settings-sync-pending"]')).toHaveText(
    "config.jsonc (new)",
  );
  await expect(note(sync)).toContainText("All of config.jsonc travels");
  await expect(note(sync)).toContainText("password or an ssh passphrase");
  await expect(note(sync)).toContainText("in a terminal first");
  await expect(button(sync, "Pull")).toBeEnabled();
  await expect(button(sync, "Push")).toBeEnabled();
  expect(await calls(page)).toContainEqual({ method: "syncConnect", remote: REMOTE });
});

test("an address that is refused says why and connects nothing", async ({ page }) => {
  await start(page, {});
  const { sync } = await openSync(page);
  await connect(sync, "http://example.com/me/noren-settings.git");
  await expect(note(sync)).toContainText("This is not a usable remote: http is not encrypted");
  await expect(note(sync)).toContainText("Nothing was connected.");
  await expect(status(sync)).toHaveText("Not connected to a remote.");

  await connect(sync, "https://me:secret@example.com/s.git");
  await expect(note(sync)).toContainText("has a password");
  await connect(sync, "ext::sh -c calc");
  await expect(note(sync)).toContainText("Nothing was connected.");
  // None of the three reached the backend.
  expect((await calls(page)).filter((call) => call.method === "syncConnect")).toEqual([]);
  await expect(button(sync, "Pull")).toBeDisabled();
});

test("Push sends the pending files and only the ones that may travel", async ({ page }) => {
  await start(page, {
    localFiles: { "config.jsonc": MINE, "mods/rounded.css": MOD, "state.json": "{}" },
  });
  const { sync } = await openSync(page);
  await connect(sync);
  await expect(status(sync)).toHaveText(`Connected to ${REMOTE} (branch main). 2 files to send.`);
  await button(sync, "Push").click();
  // The space of the window is written as a file first, so it travels with the other two.
  await expect(note(sync)).toHaveText(
    "Pushed 3 files: config.jsonc, mods/rounded.css, spaces/Main.noren-space.json.",
  );
  await expect(status(sync)).toHaveText(`Connected to ${REMOTE} (branch main). Up to date.`);
  await expect(sync.locator('[data-nr-part="settings-sync-pending"]')).toHaveCount(0);
  const sent = await remoteFiles(page);
  expect(Object.keys(sent).sort()).toEqual([
    "config.jsonc",
    "mods/rounded.css",
    "spaces/Main.noren-space.json",
  ]);
  expect(sent["config.jsonc"]).toBe(MINE);
  expect(sent["mods/rounded.css"]).toBe(MOD);

  await button(sync, "Push").click();
  await expect(note(sync)).toHaveText("Nothing to push.");
});

test("Pull brings the files of the remote where the app reads them", async ({ page }) => {
  await start(page, {
    remoteFiles: {
      "config.jsonc": THEIRS,
      "themes/lagoon.json": FAKE_GALLERY_LAGOON,
      "mods/rounded.css": MOD,
    },
  });
  const { sync } = await openSync(page);
  await connect(sync);
  await button(sync, "Pull").click();
  await expect(note(sync)).toHaveText(
    "Pulled 3 files: config.jsonc, mods/rounded.css, themes/lagoon.json.",
  );
  expect(await configText(page)).toBe(THEIRS);
  expect(Object.keys(await stored(page, WEB_THEMES_KEY))).toEqual(["lagoon"]);
  expect(await stored(page, WEB_MODS_KEY)).toEqual({ "rounded.css": MOD });

  // The theme is among the themes of the app without a restart.
  await closeSettings(page);
  await runCommand(page, "theme: lagoon", "Theme: Lagoon");

  // The settings file the pull wrote is the one the screen reads now.
  const again = await openSettings(page);
  await expect(again.getByRole("textbox", { name: "Scrollback (lines)", exact: true })).toHaveValue(
    "4321",
  );
  await closeSettings(page);

  const second = await openSync(page);
  await button(second.sync, "Pull").click();
  await expect(note(second.sync)).toHaveText(
    "Nothing to pull: this computer is up to date. Nothing changed.",
  );
});

test("a conflict lists the paths, says nothing changed and leaves the config alone", async ({
  page,
}) => {
  await start(
    page,
    {
      localFiles: { "config.jsonc": MINE },
      remoteFiles: { "config.jsonc": THEIRS, "themes/lagoon.json": FAKE_GALLERY_LAGOON },
    },
    MINE,
  );
  const { sync } = await openSync(page);
  await connect(sync);
  await button(sync, "Pull").click();
  const said = note(sync);
  await expect(said).toContainText("Pull stopped: config.jsonc changed here and on the remote");
  await expect(said).toContainText("Nothing changed on this computer.");
  await expect(said).not.toContainText("Pulled");
  // The settings file, the themes and the sync copy of this computer are as they were.
  expect(await configText(page)).toBe(MINE);
  expect(await localFile(page, "config.jsonc")).toBe(MINE);
  expect(await localFile(page, "themes/lagoon.json")).toBeNull();
  expect(await stored(page, WEB_THEMES_KEY)).toEqual({});
  // And the push is refused too: the remote's file would be replaced.
  await button(sync, "Push").click();
  await expect(said).toContainText("Could not push:");
  await expect(said).toContainText("pull first");
  expect(await remoteFiles(page)).toEqual({
    "config.jsonc": THEIRS,
    "themes/lagoon.json": FAKE_GALLERY_LAGOON,
  });
});

test("a failure of git shows the text git gave", async ({ page }) => {
  await start(page, { localFiles: { "config.jsonc": MINE } });
  const { sync } = await openSync(page);
  await connect(sync);
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.failSync("git is not installed: install it and try again"),
  );
  await button(sync, "Pull").click();
  await expect(note(sync)).toHaveText(
    "Could not pull: git is not installed: install it and try again",
  );
  await button(sync, "Push").click();
  await expect(note(sync)).toHaveText(
    "Could not push: git is not installed: install it and try again",
  );
  await connect(sync, "https://example.com/me/other.git");
  await expect(note(sync)).toHaveText(
    "Could not connect: git is not installed: install it and try again",
  );
  // The buttons come back so the person can try again once git works.
  await expect(button(sync, "Pull")).toBeEnabled();
});

test("a git that fails when the screen opens is said, and Connect stays available", async ({
  page,
}) => {
  await start(page, { failure: "git is not installed: install it and try again" });
  const { sync } = await openSync(page);
  await expect(note(sync)).toHaveText(
    "Could not read the sync status: git is not installed: install it and try again",
  );
  await expect(remoteBox(sync)).toBeVisible();
});

test("Pull settings and Push settings in the palette say where to connect, then run", async ({
  page,
}) => {
  await start(page, {
    localFiles: { "config.jsonc": MINE },
    remoteFiles: { "mods/rounded.css": MOD },
  });
  // No remote yet: the notice says where to connect and nothing is asked of git.
  await runCommand(page, "pull settings", "Pull settings");
  await expect(notice(page)).toHaveText(
    "No remote is connected. Connect one in Settings, in the Sync section.",
  );
  await runCommand(page, "push settings", "Push settings");
  await expect(notice(page)).toHaveText(
    "No remote is connected. Connect one in Settings, in the Sync section.",
  );
  expect((await calls(page)).map((call) => call.method)).toEqual(["syncStatus", "syncStatus"]);

  const { sync } = await openSync(page);
  await connect(sync);
  await closeSettings(page);

  await runCommand(page, "pull settings", "Pull settings");
  await expect(notice(page)).toHaveText("Pulled 1 file: mods/rounded.css.");
  expect(await stored(page, WEB_MODS_KEY)).toEqual({ "rounded.css": MOD });

  await runCommand(page, "push settings", "Push settings");
  // The pull before it saved the local state in the clone; the push adds the file of the space.
  await expect(notice(page)).toHaveText("Pushed 1 file: spaces/Main.noren-space.json.");
  expect((await remoteFiles(page))["config.jsonc"]).toBe(MINE);

  await runCommand(page, "push settings", "Push settings");
  await expect(notice(page)).toHaveText("Nothing to push.");
});

test("a conflict and a failure reach the notice of the palette commands too", async ({ page }) => {
  await start(page, {
    localFiles: { "config.jsonc": MINE },
    remoteFiles: { "config.jsonc": THEIRS },
  });
  const { sync } = await openSync(page);
  await connect(sync);
  await closeSettings(page);
  await runCommand(page, "pull settings", "Pull settings");
  await expect(notice(page)).toContainText("Pull stopped: config.jsonc");
  await expect(notice(page)).toContainText("Nothing changed on this computer.");

  await page.evaluate(() => (window as HookWindow).__norenTest?.failSync("git is not installed"));
  await runCommand(page, "push settings", "Push settings");
  await expect(notice(page)).toHaveText("Could not read the sync status: git is not installed");
});

test.describe("accessibility", () => {
  test("axe: the section not connected, then connected with files to send, has no violation", async ({
    page,
  }) => {
    await start(page, { localFiles: { "config.jsonc": MINE } });
    const { sync } = await openSync(page);
    await expect(status(sync)).toHaveText("Not connected to a remote.");
    await sync.scrollIntoViewIfNeeded();
    await expectNoAxeViolations(page, "Sync section, not connected");
    await connect(sync);
    await expect(sync.locator('[data-nr-part="settings-sync-pending"]')).toBeVisible();
    await expectNoAxeViolations(page, "Sync section, connected");
  });

  test("axe: the section with a refused address, a conflict and a failure of git has no violation", async ({
    page,
  }) => {
    await start(
      page,
      { localFiles: { "config.jsonc": MINE }, remoteFiles: { "config.jsonc": THEIRS } },
      MINE,
    );
    const { sync } = await openSync(page);
    await connect(sync, "http://example.com/me/noren-settings.git");
    await expect(note(sync)).toContainText("This is not a usable remote");
    await expectNoAxeViolations(page, "Sync section, refused address");
    await connect(sync);
    await button(sync, "Pull").click();
    await expect(note(sync)).toContainText("Pull stopped");
    await expectNoAxeViolations(page, "Sync section, conflict");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.failSync("git is not installed: install it"),
    );
    await button(sync, "Push").click();
    await expect(note(sync)).toContainText("Could not push");
    await expectNoAxeViolations(page, "Sync section, failure");
  });
});
