import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  JSON_BROKEN,
  JSON_PROFILES_FILE,
  JSON_SCHEME_LIST,
  NOT_A_SCHEME,
  PLIST_LAGOON,
} from "../packages/model/src/import-fixtures";
import {
  closeSettings,
  configText,
  openSettings,
  seedConfig,
  settingsScreen,
} from "./settings-fixture";

// Importing from the settings screen. "Import profiles..." reads a settings file (JSON with
// comments), shows the profiles it would add with their command lines (the hidden ones are
// ignored and counted), and only on Import writes them to `profiles` in `config.jsonc`, keeping its
// comments; they join the list of profiles in the command palette. Nothing is started or run.
// "Import color scheme..." is the flow of the palette: a theme added to the list of themes.

interface Hook {
  configSaves(): number;
  failConfigSaves(message: string | null): void;
  paneIds(): string[];
  setConfig(text: string | null): void;
  sessionStarts(): { profileId?: string; cwd?: string }[];
  userProfileSessions(): { profileId: string; program: string; args: string[]; cwd: string }[];
}
type HookWindow = Window & { __norenTest?: Hook; __stillHere?: boolean };

/** The shells the web build is told the machine has: the second one is named like a profile of the fixture. */
const MACHINE = [
  { id: "fake", name: "Fake shell", default: true },
  { id: "git-bash", name: "Git Bash", default: false },
];
const MACHINE_TITLES = ["New Fake shell tab", "New Git Bash tab"];

/** The profiles the fixture gives, in the order of the file, with the names the ids force. */
const IMPORTED_TITLES = [
  "New Git Bash (2) tab",
  "New Dev Shell tab",
  "New Fake (2) tab",
  "New Twice tab",
  "New Twice (2) tab",
];

/** The settings file of the user: a comment over everything, one of their own, and a trailing comma. */
const CONFIG = '// my notes\n{\n  "notifications": { "enabled": false }, // quiet\n}\n';

const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const options = (page: Page): Locator => palette(page).getByRole("option");
const box = (page: Page): Locator =>
  palette(page).getByRole("combobox", { name: "Command palette", exact: true });
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
const importStatus = (page: Page): Locator =>
  page.locator('[data-nr-part="settings-import-status"]');
const preview = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Import profiles", exact: true });

const saves = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.configSaves() ?? 0);
const sessionStarts = (page: Page): Promise<{ profileId?: string; cwd?: string }[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts() ?? []);

async function start(page: Page, config: string | null = CONFIG): Promise<void> {
  await page.addInitScript((profiles) => {
    window.localStorage.setItem("noren.web.profiles", JSON.stringify(profiles));
  }, MACHINE);
  if (config !== null) await seedConfig(page, config);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  // Marks this document: it is gone if the page reloads.
  await page.evaluate(() => {
    (window as HookWindow).__stillHere = true;
  });
}

async function openPalette(page: Page): Promise<void> {
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
}

/** The titles of the profile entries of the palette, which is then closed. */
async function profileTitles(page: Page): Promise<string[]> {
  await openPalette(page);
  const titles = await palette(page)
    .locator('[data-nr-kind="profile"] .palette-title')
    .allTextContents();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
  return titles;
}

/** Clicks "Import profiles..." in the open settings screen and answers the file picker with `file`. */
async function pickProfilesFile(
  page: Page,
  screen: Locator,
  file: { name: string; text: string },
): Promise<void> {
  // Heard from before the click: Playwright turns the interception of the picker on asynchronously.
  const chooser = page.waitForEvent("filechooser");
  await screen.getByRole("button", { name: "Import profiles...", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: file.name,
    mimeType: "application/json",
    buffer: Buffer.from(file.text, "utf8"),
  });
}

const FIXTURE = { name: "settings.json", text: JSON_PROFILES_FILE };

test("the settings screen has the two imports, and they act only when asked", async ({ page }) => {
  await start(page);
  const screen = await openSettings(page);
  const section = screen.getByRole("region", { name: "Import", exact: true });
  await expect(section.getByRole("button")).toHaveText([
    "Import color scheme...",
    "Import profiles...",
  ]);
  // Opening the screen reads and writes nothing.
  expect(await saves(page)).toBe(0);
  expect(await configText(page)).toBe(CONFIG);
  await closeSettings(page);
});

test("importing profiles shows what would be added before anything is written", async ({
  page,
}) => {
  await start(page);
  const screen = await openSettings(page);
  await pickProfilesFile(page, screen, FIXTURE);

  await expect(preview(page)).toBeVisible();
  await expect(preview(page).getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(preview(page)).toContainText(
    '5 profiles from "settings.json" will be added to config.jsonc.',
  );
  await expect(preview(page)).toContainText("nothing is started or run");

  // Each profile with its name and the command line that would start it.
  const items = preview(page).getByRole("list", { name: "Profiles to import", exact: true });
  await expect(items.getByRole("listitem")).toHaveCount(5);
  await expect(items.getByRole("listitem").nth(0)).toContainText("Git Bash (2)");
  await expect(items.getByRole("listitem").nth(0).locator("code")).toHaveText(
    '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i',
  );
  await expect(items.getByRole("listitem").nth(1)).toContainText("Dev Shell");
  await expect(items.getByRole("listitem").nth(1).locator("code")).toHaveText(
    `pwsh.exe -NoLogo -Command "Set-Location 'C:\\My Files'"`,
  );
  await expect(items.getByRole("listitem").nth(4).locator("code")).toHaveText(
    "second.exe /k title",
  );

  // The hidden profile is ignored and counted; the one with no command line is left out, with the reason.
  await expect(preview(page).locator('[data-nr-part="profile-import-hidden"]')).toHaveText(
    "1 hidden profile in the file was ignored.",
  );
  await expect(preview(page).locator('[data-nr-part="profile-import-skipped"]')).toHaveText(
    "Left out: No Command (it has no command line).",
  );
  await expect(items).not.toContainText("Old Shell");

  // Reading the file wrote nothing, and started nothing.
  expect(await saves(page)).toBe(0);
  expect(await configText(page)).toBe(CONFIG);
  expect(await sessionStarts(page)).toHaveLength(1);
});

test("confirming adds the profiles to the list and to config.jsonc, keeping its comments", async ({
  page,
}) => {
  await start(page);
  expect(await profileTitles(page)).toEqual(MACHINE_TITLES);

  const screen = await openSettings(page);
  await pickProfilesFile(page, screen, FIXTURE);
  await expect(preview(page)).toBeVisible();
  await preview(page).getByRole("button", { name: "Import 5 profiles", exact: true }).click();

  // The preview is gone and the screen says what happened, with the way to use them.
  await expect(preview(page)).toHaveCount(0);
  await expect(importStatus(page)).toHaveText(
    'Imported 5 profiles: "Git Bash (2)", "Dev Shell" and 3 more. Open one with "New ... tab" in the command palette.',
  );
  await expect(
    screen.getByRole("button", { name: "Import profiles...", exact: true }),
  ).toBeFocused();

  // The file: one write, the comments where they were, the profiles after them.
  expect(await saves(page)).toBe(1);
  const text = (await configText(page)) ?? "";
  expect(text.startsWith("// my notes\n{\n")).toBe(true);
  expect(text).toContain('"notifications": { "enabled": false }, // quiet');
  expect(text).toContain('"profiles": [');
  const written = JSON.parse(text.replace(/\/\/[^\n]*/g, "").replace(/,(\s*[}\]])/g, "$1")) as {
    profiles: { id: string; name: string; program: string; args?: string[]; cwd?: string }[];
  };
  expect(written.profiles).toEqual([
    {
      id: "git-bash-2",
      name: "Git Bash (2)",
      program: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--login", "-i"],
      cwd: "%USERPROFILE%",
    },
    {
      id: "dev-shell",
      name: "Dev Shell",
      program: "pwsh.exe",
      args: ["-NoLogo", "-Command", "Set-Location 'C:\\My Files'"],
      cwd: "C:\\work",
    },
    { id: "fake-2", name: "Fake (2)", program: "fake.exe" },
    { id: "twice", name: "Twice", program: "first.exe" },
    { id: "twice-2", name: "Twice (2)", program: "second.exe", args: ["/k", "title"] },
  ]);
  // The colour scheme the profile used is not carried over, and neither is the hidden profile.
  expect(text).not.toContain("colorScheme");
  expect(text).not.toContain("Old Shell");

  // The list of profiles in the palette: the machine's shells, then the imported ones.
  await closeSettings(page);
  expect(await profileTitles(page)).toEqual([...MACHINE_TITLES, ...IMPORTED_TITLES]);

  // No window reload, and importing started no shell: only the one the app opened.
  expect(await page.evaluate(() => (window as HookWindow).__stillHere)).toBe(true);
  expect(await sessionStarts(page)).toHaveLength(1);
});

test("an imported profile opens a tab that starts its program, arguments and folder", async ({
  page,
}) => {
  await start(page);
  const screen = await openSettings(page);
  await pickProfilesFile(page, screen, FIXTURE);
  await preview(page).getByRole("button", { name: "Import 5 profiles", exact: true }).click();
  await expect(preview(page)).toHaveCount(0);
  await closeSettings(page);

  await openPalette(page);
  await box(page).fill(">new dev shell");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveText(/New Dev Shell tab/);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();

  await expect.poll(async () => (await sessionStarts(page)).length).toBe(2);
  expect((await sessionStarts(page))[1]).toMatchObject({ profileId: "dev-shell" });
  const sessions = await page.evaluate(
    () => (window as HookWindow).__norenTest?.userProfileSessions() ?? [],
  );
  expect(sessions).toEqual([
    {
      profileId: "dev-shell",
      program: "pwsh.exe",
      args: ["-NoLogo", "-Command", "Set-Location 'C:\\My Files'"],
      cwd: "C:\\work",
    },
  ]);
});

test("the imported profiles are still there after a reload", async ({ page }) => {
  await start(page);
  const screen = await openSettings(page);
  await pickProfilesFile(page, screen, FIXTURE);
  await preview(page).getByRole("button", { name: "Import 5 profiles", exact: true }).click();
  await expect(preview(page)).toHaveCount(0);
  await closeSettings(page);

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  expect(await profileTitles(page)).toEqual([...MACHINE_TITLES, ...IMPORTED_TITLES]);
});

test("cancelling the preview, or pressing Escape, writes nothing and adds nothing", async ({
  page,
}) => {
  await start(page);
  const screen = await openSettings(page);

  await pickProfilesFile(page, screen, FIXTURE);
  await expect(preview(page)).toBeVisible();
  await preview(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(preview(page)).toHaveCount(0);
  await expect(screen).toBeVisible();

  // Escape closes only the preview, not the screen under it.
  await pickProfilesFile(page, screen, FIXTURE);
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview(page)).toHaveCount(0);
  await expect(screen).toBeVisible();

  expect(await saves(page)).toBe(0);
  expect(await configText(page)).toBe(CONFIG);
  await closeSettings(page);
  expect(await profileTitles(page)).toEqual(MACHINE_TITLES);
});

test("a hidden profile never reaches the list, even when it is the only one", async ({ page }) => {
  await start(page);
  const screen = await openSettings(page);
  await pickProfilesFile(page, screen, {
    name: "hidden.json",
    text: '{ "profiles": [ { "name": "Old Shell", "commandline": "old.exe", "hidden": true } ] }',
  });
  await expect(importStatus(page)).toHaveText(
    'Could not import "hidden.json": there is no profile to import: 1 profile is hidden.',
  );
  await expect(preview(page)).toHaveCount(0);
  expect(await saves(page)).toBe(0);
  await closeSettings(page);
  expect(await profileTitles(page)).toEqual(MACHINE_TITLES);
});

test("a file that is not a settings file with profiles says so and writes nothing", async ({
  page,
}) => {
  await start(page);
  const screen = await openSettings(page);

  await pickProfilesFile(page, screen, { name: "notes.txt", text: NOT_A_SCHEME });
  await expect(importStatus(page)).toContainText('Could not import "notes.txt": ');
  await pickProfilesFile(page, screen, { name: "schemes.json", text: JSON_SCHEME_LIST });
  await expect(importStatus(page)).toHaveText(
    'Could not import "schemes.json": This JSON file has no list of profiles',
  );
  await pickProfilesFile(page, screen, { name: "broken.json", text: JSON_BROKEN });
  await expect(importStatus(page)).toContainText('Could not import "broken.json": line 1');

  await expect(preview(page)).toHaveCount(0);
  expect(await saves(page)).toBe(0);
  expect(await configText(page)).toBe(CONFIG);
  await closeSettings(page);
  expect(await profileTitles(page)).toEqual(MACHINE_TITLES);
});

test("a settings file with a problem of its own is not edited: the preview says why", async ({
  page,
}) => {
  const broken = '{ "appearance": { "tabs": 5 } }';
  await start(page, broken);
  const screen = await openSettings(page);
  await pickProfilesFile(page, screen, FIXTURE);
  await expect(preview(page)).toBeVisible();
  await preview(page).getByRole("button", { name: "Import 5 profiles", exact: true }).click();

  await expect(preview(page).locator('[data-nr-part="profile-import-failure"]')).toContainText(
    "The settings file has a problem, so nothing was saved.",
  );
  // The preview stays, so the person can try again after fixing the file or give up.
  await expect(preview(page)).toBeVisible();
  expect(await saves(page)).toBe(0);
  expect(await configText(page)).toBe(broken);
  await preview(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await closeSettings(page);
});

test("a refused write keeps the preview open with the reason", async ({ page }) => {
  await start(page);
  const screen = await openSettings(page);
  await pickProfilesFile(page, screen, FIXTURE);
  await page.evaluate(() => (window as HookWindow).__norenTest?.failConfigSaves("disk full"));
  await preview(page).getByRole("button", { name: "Import 5 profiles", exact: true }).click();
  await expect(preview(page).locator('[data-nr-part="profile-import-failure"]')).toHaveText(
    "Could not write config.jsonc: disk full",
  );
  expect(await configText(page)).toBe(CONFIG);

  // The disk works again: the same preview can be confirmed.
  await page.evaluate(() => (window as HookWindow).__norenTest?.failConfigSaves(null));
  await preview(page).getByRole("button", { name: "Import 5 profiles", exact: true }).click();
  await expect(preview(page)).toHaveCount(0);
  expect((await configText(page)) ?? "").toContain('"id": "dev-shell"');
});

test("importing the same file again numbers the ids and names, and every profile is kept", async ({
  page,
}) => {
  await start(page);
  for (let round = 0; round < 2; round++) {
    const screen = await openSettings(page);
    await pickProfilesFile(page, screen, FIXTURE);
    await preview(page).getByRole("button", { name: "Import 5 profiles", exact: true }).click();
    await expect(preview(page)).toHaveCount(0);
    await closeSettings(page);
  }
  const titles = await profileTitles(page);
  expect(titles).toHaveLength(2 + 5 + 5);
  expect(new Set(titles).size).toBe(titles.length);
  expect(titles.slice(7)).toEqual([
    "New Git Bash (3) tab",
    "New Dev Shell (2) tab",
    "New Fake (3) tab",
    "New Twice (3) tab",
    "New Twice (4) tab",
  ]);
});

test("a profile written in config.jsonc by hand joins the list with no reload, and a refused one says why", async ({
  page,
}) => {
  await start(page);
  const profile = (id: string, name: string) =>
    `{ "id": "${id}", "name": "${name}", "program": "sh" }`;

  await page.evaluate(
    (text) => (window as HookWindow).__norenTest?.setConfig(text),
    `// hand\n{ "profiles": [ ${profile("by-hand", "By Hand")} ] }`,
  );
  await expect.poll(() => profileTitles(page)).toEqual([...MACHINE_TITLES, "New By Hand tab"]);

  // An id the machine has is refused as a whole: the list in force stays, and a notice says why.
  await page.evaluate(
    (text) => (window as HookWindow).__norenTest?.setConfig(text),
    `{ "profiles": [ ${profile("by-hand", "By Hand")}, ${profile("fake", "Clash")} ] }`,
  );
  await expect(notice(page)).toHaveText(
    'The profiles in config.jsonc were not applied. Profile "Clash": the id "fake" is already a shell of this machine',
  );
  expect(await profileTitles(page)).toEqual([...MACHINE_TITLES, "New By Hand tab"]);

  // An empty program is refused by the settings file itself, with its line, and the list stays.
  await page.evaluate(
    (text) => (window as HookWindow).__norenTest?.setConfig(text),
    `{\n  "profiles": [\n    { "id": "empty", "name": "Empty", "program": "" }\n  ]\n}`,
  );
  await expect(page.locator(".config-notice")).toContainText("profiles[0].program");
  expect(await profileTitles(page)).toEqual([...MACHINE_TITLES, "New By Hand tab"]);

  // Taking the profile out of the file takes it out of the list.
  await page.evaluate((text) => (window as HookWindow).__norenTest?.setConfig(text), "{}");
  await expect.poll(() => profileTitles(page)).toEqual(MACHINE_TITLES);
});

test("a profile the file lists is there from the first frame", async ({ page }) => {
  await start(
    page,
    '{ "profiles": [ { "id": "boot-shell", "name": "Boot Shell", "program": "sh", "cwd": "/srv" } ] }',
  );
  expect(await profileTitles(page)).toEqual([...MACHINE_TITLES, "New Boot Shell tab"]);
});

test("importing a color scheme from the settings screen puts the theme on the list", async ({
  page,
}) => {
  await start(page);
  const screen = await openSettings(page);
  const chooser = page.waitForEvent("filechooser");
  await screen.getByRole("button", { name: "Import color scheme...", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Lagoon.itermcolors",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(PLIST_LAGOON, "utf8"),
  });
  await expect(importStatus(page)).toHaveText(
    'Imported color scheme "Lagoon". Pick it with "Theme: Lagoon" in the command palette.',
  );
  // Importing a scheme writes a theme file, not the settings file.
  expect(await saves(page)).toBe(0);
  expect(await configText(page)).toBe(CONFIG);
  await closeSettings(page);

  await openPalette(page);
  await box(page).fill(">theme: lagoon");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveAttribute("data-nr-kind", "theme");
  await expect(options(page).first().locator(".palette-title")).toHaveText("Theme: Lagoon");
});

test("a color scheme file that is not one says so in the screen and adds no theme", async ({
  page,
}) => {
  await start(page);
  const screen = await openSettings(page);
  const chooser = page.waitForEvent("filechooser");
  await screen.getByRole("button", { name: "Import color scheme...", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(NOT_A_SCHEME, "utf8"),
  });
  await expect(importStatus(page)).toContainText(
    'Could not import "notes.txt": This file is not a color scheme',
  );
  expect(await page.evaluate(() => window.localStorage.getItem("noren.web.themes"))).toBeNull();
  await expect(settingsScreen(page)).toBeVisible();
  await closeSettings(page);
});
