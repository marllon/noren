import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { cancelSettings, configText, openSettings, seedConfig } from "./settings-fixture";

// The sync through a secret GitHub gist in the Sync section of the settings screen, in the palette
// commands "Pull settings" and "Push settings" and in the push when the app closes (NOR-F19-02b).
// The gist is the in-memory one of the web build, seeded under `noren.web.sync` (`gists`: what
// GitHub holds; `localFiles`: this computer), and the token goes to the fake keychain, so nothing
// touches a network or the real keychain. A real token never appears in these tests: the one used
// is a made-up string, and the tests check that the screen and the backend calls never hold it.

interface Hook {
  paneIds(): string[];
  syncCalls(): { method: string; remote?: string }[];
  syncLocalFile(path: string): string | null;
  setSyncLocalFile(path: string, text: string | null): void;
  putSyncGist(id: string, gist: { public?: boolean; files?: Record<string, string> }): void;
  setSyncGistFile(id: string, name: string, text: string | null): void;
  syncGistFiles(id: string): Record<string, string>;
  syncGistIds(): string[];
  failSyncGist(message: string | null): void;
}
type Outcome =
  | { kind: "skipped"; reason: string }
  | { kind: "pushed"; files: number }
  | { kind: "failed"; reason: string }
  | { kind: "timeout" };
interface CloseHook {
  run(): Promise<{ outcome: Outcome | undefined; log: string[] }>;
}
type HookWindow = Window & { __norenTest?: Hook; __norenClose?: CloseHook };

const WEB_SYNC_KEY = "noren.web.sync";
const WEB_MODS_KEY = "noren.web.mods";

const TOKEN = "ghp_madeUpTokenForTheTests0123456789";
const GIST = "a1b2c3d4e5f6";
// config.jsonc travels whole, and `sync.method` with it: a config that a pull brings keeps the gist
// as the method, as the config of the computer that pushed it did.
const MINE = '// mine\n{ "sync": { "method": "gist" }, "terminal": { "scrollback": 500 } }\n';
const THEIRS = '// theirs\n{ "sync": { "method": "gist" }, "terminal": { "scrollback": 4321 } }\n';
const MOD = "/* rounded corners */\n";
const GIST_METHOD = '{ "sync": { "method": "gist" } }\n';

interface Seed {
  localFiles?: Record<string, string>;
  gists?: Record<string, { public?: boolean; files: Record<string, string> }>;
  gistFailure?: string;
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
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenClose !== undefined))
    .toBe(true);
}

async function openSync(page: Page): Promise<{ screen: Locator; sync: Locator }> {
  const screen = await openSettings(page);
  return { screen, sync: screen.getByRole("region", { name: "Sync", exact: true }) };
}

const status = (sync: Locator): Locator => sync.locator('[data-nr-part="settings-sync-status"]');
const note = (sync: Locator): Locator => sync.locator('[data-nr-part="settings-sync-note"]');
const tokenState = (sync: Locator): Locator => sync.locator('[data-nr-part="settings-sync-token"]');
const publicWarning = (sync: Locator): Locator =>
  sync.locator('[data-nr-part="settings-sync-gist-public"]');
const tokenBox = (sync: Locator): Locator => sync.getByLabel("GitHub token", { exact: true });
const idBox = (sync: Locator): Locator =>
  sync.getByRole("textbox", { name: "Gist id", exact: true });
const button = (sync: Locator, name: string): Locator =>
  sync.getByRole("button", { name, exact: true });

/** Chooses the gist in the list "Sync through". */
async function chooseGist(sync: Locator): Promise<void> {
  await sync.getByRole("combobox", { name: "Sync through", exact: true }).selectOption("gist");
  await expect(tokenBox(sync)).toBeVisible();
}

async function saveToken(sync: Locator, token = TOKEN): Promise<void> {
  await tokenBox(sync).fill(token);
  await button(sync, "Save token").click();
  await expect(tokenState(sync)).toHaveText("A token is stored in the system keychain.");
}

/** Chooses the gist, saves the token and connects to the gist `id` (the one seeded by default). */
async function connectToGist(sync: Locator, id = GIST): Promise<void> {
  await chooseGist(sync);
  await saveToken(sync);
  await idBox(sync).fill(id);
  await button(sync, "Connect").click();
  await expect(status(sync)).toContainText(`Connected to the gist ${id}.`);
}

const calls = (page: Page): Promise<{ method: string; remote?: string }[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.syncCalls() ?? []);
const gistFiles = (page: Page, id = GIST): Promise<Record<string, string>> =>
  page.evaluate((i) => (window as HookWindow).__norenTest?.syncGistFiles(i) ?? {}, id);
const localFile = (page: Page, path: string): Promise<string | null> =>
  page.evaluate((p) => (window as HookWindow).__norenTest?.syncLocalFile(p) ?? null, path);
const stored = (page: Page, key: string): Promise<Record<string, string>> =>
  page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) ?? "{}"), key);
const close = (page: Page) =>
  page.evaluate(async () => {
    const hook = (window as HookWindow).__norenClose;
    if (hook === undefined) throw new Error("the close hook is missing");
    return hook.run();
  });

/** Runs the palette command whose title is `title`, found by typing `query`. */
async function runCommand(page: Page, query: string, title: string): Promise<void> {
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
  await box(page).fill(`>${query}`);
  await expect(palette(page).getByRole("option").first().locator(".palette-title")).toHaveText(
    title,
  );
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
}

test("git stays the method until the list says gist, and the choice is kept in config.jsonc", async ({
  page,
}) => {
  await start(page, {}, '// my settings\n{ "language": "en" }\n');
  const { sync } = await openSync(page);
  const list = sync.getByRole("combobox", { name: "Sync through", exact: true });
  await expect(list).toHaveValue("git");
  await expect(sync.getByRole("textbox", { name: "Remote address", exact: true })).toBeVisible();
  await expect(tokenBox(sync)).toHaveCount(0);

  await list.selectOption("gist");
  await expect(tokenBox(sync)).toBeVisible();
  await expect(sync.getByRole("textbox", { name: "Remote address", exact: true })).toHaveCount(0);
  await expect(status(sync)).toHaveText("Not connected to a gist.");
  await expect.poll(() => configText(page)).toContain('"method": "gist"');
  // The comments and the other settings of the file stay.
  const text = (await configText(page)) ?? "";
  expect(text).toContain("// my settings");
  expect(text).toContain('"language": "en"');
  await cancelSettings(page);

  // And it holds: a reload shows the gist, and going back to git writes it too.
  await page.reload();
  const again = await openSync(page);
  await expect(again.sync.getByRole("combobox", { name: "Sync through", exact: true })).toHaveValue(
    "gist",
  );
  await again.sync.getByRole("combobox", { name: "Sync through", exact: true }).selectOption("git");
  await expect.poll(() => configText(page)).toContain('"method": "git"');
  await expect(
    again.sync.getByRole("textbox", { name: "Remote address", exact: true }),
  ).toBeVisible();
});

test("the token is saved and removed, and the screen never shows it", async ({ page }) => {
  await start(page, {}, GIST_METHOD);
  const { sync } = await openSync(page);
  await expect(tokenState(sync)).toHaveText("No token is stored.");
  await expect(button(sync, "Remove token")).toBeDisabled();
  await expect(button(sync, "Save token")).toBeDisabled();

  // The box hides what is typed.
  await expect(tokenBox(sync)).toHaveAttribute("type", "password");
  await tokenBox(sync).fill(`  ${TOKEN}  `);
  await button(sync, "Save token").click();
  await expect(tokenState(sync)).toHaveText("A token is stored in the system keychain.");
  await expect(note(sync)).toHaveText("The token was saved in the system keychain.");
  // The box is empty again, and the token is nowhere in the page nor in what the backend was asked.
  await expect(tokenBox(sync)).toHaveValue("");
  expect(await page.content()).not.toContain(TOKEN);
  expect(JSON.stringify(await calls(page))).not.toContain(TOKEN);
  expect(await page.evaluate(() => JSON.stringify({ ...window.localStorage }))).not.toContain(
    TOKEN,
  );

  await button(sync, "Remove token").click();
  await expect(tokenState(sync)).toHaveText("No token is stored.");
  await expect(note(sync)).toHaveText("The token was removed from the system keychain.");
  await expect(button(sync, "Remove token")).toBeDisabled();
});

test("a token that cannot be one is refused with the reason and never reaches the backend", async ({
  page,
}) => {
  await start(page, {}, GIST_METHOD);
  const { sync } = await openSync(page);
  await tokenBox(sync).fill("two words");
  await button(sync, "Save token").click();
  await expect(note(sync)).toContainText("This is not a usable token");
  await expect(note(sync)).toContainText("Nothing was saved.");
  await expect(note(sync)).not.toContainText("two words");
  await expect(tokenState(sync)).toHaveText("No token is stored.");
  expect((await calls(page)).filter((call) => call.method === "syncGistSetToken")).toEqual([]);
});

test("Connect needs a token and an id that is one, and a missing gist says what GitHub said", async ({
  page,
}) => {
  await start(page, { gists: { [GIST]: { files: {} } } }, GIST_METHOD);
  const { sync } = await openSync(page);
  await idBox(sync).fill(GIST);
  await button(sync, "Connect").click();
  await expect(note(sync)).toContainText("Could not connect:");
  await expect(note(sync)).toContainText("no GitHub token is stored");
  await expect(status(sync)).toHaveText("Not connected to a gist.");

  await saveToken(sync);
  await idBox(sync).fill("https://gist.github.com/me/abc");
  await button(sync, "Connect").click();
  await expect(note(sync)).toContainText("This is not the id of a gist");
  await expect(note(sync)).toContainText("Nothing was connected.");
  // Only the first try (no token) reached the backend: an id that is not one is never sent.
  expect((await calls(page)).filter((call) => call.method === "syncGistConnect")).toHaveLength(1);

  await idBox(sync).fill("ffffffffffff");
  await button(sync, "Connect").click();
  await expect(note(sync)).toContainText("Could not connect:");
  await expect(note(sync)).toContainText("404");
  await expect(status(sync)).toHaveText("Not connected to a gist.");
  await expect(button(sync, "Pull")).toBeDisabled();
  await expect(button(sync, "Push")).toBeDisabled();
});

test("Make a secret gist sends the files that may travel and says secret is not private", async ({
  page,
}) => {
  await start(page, { localFiles: { "config.jsonc": MINE, "mods/rounded.css": MOD } }, GIST_METHOD);
  const { sync } = await openSync(page);
  await saveToken(sync);
  await button(sync, "Make a secret gist").click();
  await expect(note(sync)).toContainText("Made the secret gist");
  await expect(note(sync)).toContainText("not listed or searchable");
  await expect(note(sync)).toContainText("anyone who has its link can read it");
  await expect(note(sync)).toContainText("All of config.jsonc travels");
  await expect(publicWarning(sync)).toHaveCount(0);
  await expect(status(sync)).toContainText("Up to date.");
  const ids = await page.evaluate(() => (window as HookWindow).__norenTest?.syncGistIds() ?? []);
  expect(ids).toHaveLength(1);
  await expect(idBox(sync)).toHaveValue(ids[0] ?? "");
  expect(await gistFiles(page, ids[0])).toEqual({
    "config.jsonc": MINE,
    "mods--rounded.css": MOD,
  });
  await expect(button(sync, "Pull")).toBeEnabled();
  await expect(button(sync, "Push")).toBeEnabled();
});

test("Push sends what changed here and refuses when the gist moved on", async ({ page }) => {
  await start(
    page,
    {
      localFiles: { "config.jsonc": MINE },
      gists: { [GIST]: { files: { "config.jsonc": MINE } } },
    },
    GIST_METHOD,
  );
  const { sync } = await openSync(page);
  await connectToGist(sync);
  // Connecting copies nothing: the file of this computer is still to be sent until a pull has seen
  // the gist hold the same bytes.
  await expect(status(sync)).toHaveText(`Connected to the gist ${GIST}. 1 file to send.`);
  await expect(note(sync)).toContainText("All of config.jsonc travels");
  await button(sync, "Pull").click();
  await expect(note(sync)).toHaveText(
    "Nothing to pull: this computer is up to date. Nothing changed.",
  );
  await expect(status(sync)).toHaveText(`Connected to the gist ${GIST}. Up to date.`);

  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setSyncLocalFile("mods/rounded.css", "/* round */\n"),
  );
  // The screen reads the status again after each step; a pull of nothing is the way to look.
  await button(sync, "Pull").click();
  await expect(status(sync)).toHaveText(`Connected to the gist ${GIST}. 1 file to send.`);
  await expect(sync.locator('[data-nr-part="settings-sync-pending"]')).toHaveText(
    "mods/rounded.css (new)",
  );
  await button(sync, "Push").click();
  // The space of the window is written as a file first, so it travels too.
  await expect(note(sync)).toHaveText(
    "Pushed 2 files: mods/rounded.css, spaces/Main.noren-space.json.",
  );
  await expect(status(sync)).toHaveText(`Connected to the gist ${GIST}. Up to date.`);
  const sent = await gistFiles(page);
  expect(Object.keys(sent).sort()).toEqual([
    "config.jsonc",
    "mods--rounded.css",
    "spaces--Main.noren-space.json",
  ]);
  expect(sent["mods--rounded.css"]).toBe("/* round */\n");
  // Gist calls only: git was never asked.
  expect((await calls(page)).filter((call) => call.method === "syncPush")).toEqual([]);

  await button(sync, "Push").click();
  await expect(note(sync)).toHaveText("Nothing to push.");

  // Another computer changed the gist: the push is refused and nothing is sent.
  await page.evaluate(
    ([id, text]) =>
      (window as HookWindow).__norenTest?.setSyncGistFile(id, "mods--other.css", text),
    [GIST, "/* theirs */\n"] as const,
  );
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setSyncLocalFile("mods/rounded.css", "/* changed */\n"),
  );
  await button(sync, "Push").click();
  await expect(note(sync)).toContainText("Could not push:");
  await expect(note(sync)).toContainText("pull first");
  expect((await gistFiles(page))["mods--rounded.css"]).toBe("/* round */\n");
});

test("Pull brings the files of the gist where the app reads them, and a second one has nothing", async ({
  page,
}) => {
  await start(
    page,
    {
      gists: {
        [GIST]: {
          files: {
            "config.jsonc": THEIRS,
            "mods--rounded.css": MOD,
            "README.md": "not a file of the sync",
          },
        },
      },
    },
    GIST_METHOD,
  );
  const { sync } = await openSync(page);
  await connectToGist(sync);
  await button(sync, "Pull").click();
  await expect(note(sync)).toHaveText("Pulled 2 files: config.jsonc, mods/rounded.css.");
  expect(await configText(page)).toBe(THEIRS);
  expect(await localFile(page, "README.md")).toBeNull();
  expect(await stored(page, WEB_MODS_KEY)).toEqual({ "rounded.css": MOD });
  await expect(status(sync)).toHaveText(`Connected to the gist ${GIST}. Up to date.`);

  await button(sync, "Pull").click();
  await expect(note(sync)).toHaveText(
    "Nothing to pull: this computer is up to date. Nothing changed.",
  );
  // The pull went through the gist, not through git.
  expect((await calls(page)).filter((call) => call.method === "syncPull")).toEqual([]);
});

test("a conflict lists the paths, says nothing changed and writes nothing", async ({ page }) => {
  await start(
    page,
    {
      localFiles: { "config.jsonc": MINE },
      gists: { [GIST]: { files: { "config.jsonc": THEIRS, "mods--rounded.css": MOD } } },
    },
    MINE,
  );
  const { sync } = await openSync(page);
  await connectToGist(sync);
  await button(sync, "Pull").click();
  const said = note(sync);
  await expect(said).toContainText("Pull stopped: config.jsonc changed here and in the gist");
  await expect(said).toContainText("Nothing changed on this computer.");
  await expect(said).not.toContainText("Pulled");
  // The settings file, the mods and the sync copy of this computer are as they were.
  expect(await configText(page)).toBe(MINE);
  expect(await localFile(page, "config.jsonc")).toBe(MINE);
  expect(await localFile(page, "mods/rounded.css")).toBeNull();
  expect(await stored(page, WEB_MODS_KEY)).toEqual({});
  // And the push is refused: the file of the gist would be replaced.
  await button(sync, "Push").click();
  await expect(said).toContainText("Could not push:");
  await expect(said).toContainText("pull first");
  expect((await gistFiles(page))["config.jsonc"]).toBe(THEIRS);
});

test("a gist that anyone can read gets a warning, and a secret one does not", async ({ page }) => {
  await start(
    page,
    {
      localFiles: { "config.jsonc": MINE },
      gists: { [GIST]: { public: true, files: { "config.jsonc": MINE } } },
    },
    GIST_METHOD,
  );
  const { sync } = await openSync(page);
  await saveToken(sync);
  await expect(publicWarning(sync)).toHaveCount(0);
  await idBox(sync).fill(GIST);
  await button(sync, "Connect").click();
  await expect(publicWarning(sync)).toContainText("This gist is public");
  await expect(publicWarning(sync)).toContainText("anyone can find and read your config.jsonc");
  await expect(note(sync)).toContainText("This gist is public");
  // The warning stays as long as the gist connected is public: it is there when the screen opens again.
  await cancelSettings(page);
  const again = await openSync(page);
  await expect(publicWarning(again.sync)).toContainText("This gist is public");

  // Making a secret gist leaves the public one: the warning goes with it.
  await button(again.sync, "Make a secret gist").click();
  await expect(note(again.sync)).toContainText("Made the secret gist");
  await expect(publicWarning(again.sync)).toHaveCount(0);
});

test("a status that cannot be read says why and leaves the rest of the section working", async ({
  page,
}) => {
  await start(
    page,
    {
      localFiles: { "config.jsonc": MINE },
      gists: { [GIST]: { files: { "config.jsonc": MINE } } },
    },
    GIST_METHOD,
  );
  const first = await openSync(page);
  await connectToGist(first.sync);
  await cancelSettings(page);
  // A file of the config folder grows past what a sync carries (1 MiB): the status cannot list it.
  await page.evaluate(
    (text) => (window as HookWindow).__norenTest?.setSyncLocalFile("mods/big.css", text),
    "x".repeat(1024 * 1024 + 1),
  );
  const { sync } = await openSync(page);
  await expect(status(sync)).toContainText("Could not read the sync status:");
  await expect(status(sync)).toContainText("mods/big.css is larger than 1024 KiB");
  // Nothing else is hidden: the method, the token and the gist can still be set.
  await expect(sync.getByRole("combobox", { name: "Sync through", exact: true })).toBeVisible();
  await expect(tokenState(sync)).toBeVisible();
  await expect(idBox(sync)).toBeVisible();
  await idBox(sync).fill(GIST);
  await expect(button(sync, "Make a secret gist")).toBeEnabled();
  await expect(button(sync, "Connect")).toBeEnabled();
  await tokenBox(sync).fill("another-token");
  await expect(button(sync, "Save token")).toBeEnabled();

  // After a step the status is read again, and says the same.
  await button(sync, "Connect").click();
  await expect(note(sync)).toContainText("Could not connect:");
  await expect(note(sync)).toContainText("mods/big.css is larger than 1024 KiB");
  await expect(status(sync)).toContainText("Could not read the sync status:");

  // And once the file is back under the limit the status is there again.
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setSyncLocalFile("mods/big.css", null),
  );
  await cancelSettings(page);
  const again = await openSync(page);
  await expect(status(again.sync)).toContainText(`Connected to the gist ${GIST}.`);
});

test("a failure of the gist sync shows the text it gave", async ({ page }) => {
  await start(
    page,
    {
      localFiles: { "config.jsonc": MINE },
      gists: { [GIST]: { files: { "config.jsonc": MINE } } },
    },
    GIST_METHOD,
  );
  const { sync } = await openSync(page);
  await connectToGist(sync);
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.failSyncGist("GitHub cannot be reached: try again later"),
  );
  await button(sync, "Pull").click();
  await expect(note(sync)).toHaveText("Could not pull: GitHub cannot be reached: try again later");
  await button(sync, "Push").click();
  await expect(note(sync)).toHaveText("Could not push: GitHub cannot be reached: try again later");
  await expect(button(sync, "Pull")).toBeEnabled();
});

test.describe("Pull settings and Push settings in the palette", () => {
  test("say where to connect, then run through the gist and not through git", async ({ page }) => {
    await start(
      page,
      {
        localFiles: { "config.jsonc": MINE },
        gists: { [GIST]: { files: { "mods--rounded.css": MOD } } },
      },
      GIST_METHOD,
    );
    // No token: the notice says so and nothing is asked of the gist.
    await runCommand(page, "pull settings", "Pull settings");
    await expect(notice(page)).toHaveText(
      "No GitHub token is stored. Save one in Settings, in the Sync section.",
    );
    const { sync } = await openSync(page);
    await saveToken(sync);
    await cancelSettings(page);
    // A token and no gist.
    await runCommand(page, "push settings", "Push settings");
    await expect(notice(page)).toHaveText(
      "No gist is connected. Connect one in Settings, in the Sync section.",
    );
    expect((await calls(page)).map((call) => call.method)).not.toContain("syncGistPush");

    const again = await openSync(page);
    await idBox(again.sync).fill(GIST);
    await button(again.sync, "Connect").click();
    await expect(status(again.sync)).toContainText(`Connected to the gist ${GIST}.`);
    await cancelSettings(page);

    await runCommand(page, "pull settings", "Pull settings");
    await expect(notice(page)).toHaveText("Pulled 1 file: mods/rounded.css.");
    expect(await stored(page, WEB_MODS_KEY)).toEqual({ "rounded.css": MOD });

    await runCommand(page, "push settings", "Push settings");
    await expect(notice(page)).toContainText(
      "Pushed 2 files: config.jsonc, spaces/Main.noren-space.json.",
    );
    expect((await gistFiles(page))["config.jsonc"]).toBe(MINE);

    await runCommand(page, "push settings", "Push settings");
    await expect(notice(page)).toHaveText("Nothing to push.");
    const methods = (await calls(page)).map((call) => call.method);
    expect(methods).toContain("syncGistPush");
    expect(methods).toContain("syncGistPull");
    // Not one call of the sync through git.
    expect(methods.filter((name) => /^sync(Status|Connect|Pull|Push)$/.test(name))).toEqual([]);
  });

  test("a conflict and a failure of the gist reach the notice too", async ({ page }) => {
    await start(
      page,
      {
        localFiles: { "config.jsonc": MINE },
        gists: { [GIST]: { files: { "config.jsonc": THEIRS } } },
      },
      GIST_METHOD,
    );
    const { sync } = await openSync(page);
    await connectToGist(sync);
    await cancelSettings(page);
    await runCommand(page, "pull settings", "Pull settings");
    await expect(notice(page)).toContainText(
      "Pull stopped: config.jsonc changed here and in the gist",
    );
    await expect(notice(page)).toContainText("Nothing changed on this computer.");

    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.failSyncGist("the keychain is locked"),
    );
    await runCommand(page, "push settings", "Push settings");
    await expect(notice(page)).toHaveText("Could not read the sync status: the keychain is locked");
  });

  test("keep using git when the method is git, though a gist is connected", async ({ page }) => {
    await start(
      page,
      { localFiles: { "config.jsonc": MINE }, gists: { [GIST]: { files: {} } } },
      GIST_METHOD,
    );
    const { sync } = await openSync(page);
    await connectToGist(sync);
    await sync.getByRole("combobox", { name: "Sync through", exact: true }).selectOption("git");
    await expect.poll(() => configText(page)).toContain('"method": "git"');
    await cancelSettings(page);
    await runCommand(page, "push settings", "Push settings");
    // The remote of git is not connected: the notice is the git one and the gist got no push.
    await expect(notice(page)).toHaveText(
      "No remote is connected. Connect one in Settings, in the Sync section.",
    );
    expect(await gistFiles(page)).toEqual({});
    expect((await calls(page)).filter((call) => call.method === "syncGistPush")).toEqual([]);
  });
});

test.describe("the push when Noren closes", () => {
  const ON = '{ "sync": { "method": "gist", "pushOnClose": true } }\n';

  test("goes to the gist, once, and not again with nothing new", async ({ page }) => {
    await start(
      page,
      { localFiles: { "config.jsonc": MINE }, gists: { [GIST]: { files: {} } } },
      ON,
    );
    const { sync } = await openSync(page);
    await connectToGist(sync);
    await cancelSettings(page);
    const { outcome, log } = await close(page);
    expect(outcome).toEqual({ kind: "pushed", files: 2 });
    expect(log).toEqual([]);
    const sent = await gistFiles(page);
    expect(Object.keys(sent).sort()).toEqual(["config.jsonc", "spaces--Main.noren-space.json"]);
    expect(sent["config.jsonc"]).toBe(MINE);
    expect((await close(page)).outcome).toEqual({ kind: "skipped", reason: "nothing-pending" });
    const methods = (await calls(page)).map((call) => call.method);
    expect(methods.filter((name) => name === "syncGistPush")).toHaveLength(1);
    expect(methods).not.toContain("syncPush");
  });

  test("does nothing with no gist connected, or with the option off", async ({ page }) => {
    await start(
      page,
      { localFiles: { "config.jsonc": MINE }, gists: { [GIST]: { files: {} } } },
      ON,
    );
    expect((await close(page)).outcome).toEqual({ kind: "skipped", reason: "no-remote" });

    const { sync } = await openSync(page);
    await connectToGist(sync);
    await sync.getByRole("checkbox", { name: "Push when Noren closes", exact: true }).uncheck();
    await expect.poll(() => configText(page)).toContain('"pushOnClose": false');
    await cancelSettings(page);
    expect((await close(page)).outcome).toEqual({ kind: "skipped", reason: "off" });
    expect(await gistFiles(page)).toEqual({});
  });

  test("a failure of the gist is recorded and the close still ends", async ({ page }) => {
    await start(
      page,
      { localFiles: { "config.jsonc": MINE }, gists: { [GIST]: { files: {} } } },
      ON,
    );
    const { sync } = await openSync(page);
    await connectToGist(sync);
    await cancelSettings(page);
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.failSyncGist("GitHub cannot be reached"),
    );
    const { outcome, log } = await close(page);
    expect(outcome).toEqual({ kind: "failed", reason: "GitHub cannot be reached" });
    expect(log).toEqual(["push on close failed: GitHub cannot be reached"]);
    expect(await gistFiles(page)).toEqual({});
  });
});

test("removing the token stops Pull and Push of the palette from reaching the gist", async ({
  page,
}) => {
  await start(
    page,
    {
      localFiles: { "config.jsonc": MINE },
      gists: { [GIST]: { files: { "config.jsonc": MINE } } },
    },
    GIST_METHOD,
  );
  const { sync } = await openSync(page);
  await connectToGist(sync);
  await button(sync, "Remove token").click();
  await expect(tokenState(sync)).toHaveText("No token is stored.");
  await cancelSettings(page);
  await runCommand(page, "push settings", "Push settings");
  await expect(notice(page)).toHaveText(
    "No GitHub token is stored. Save one in Settings, in the Sync section.",
  );
  expect((await calls(page)).filter((call) => call.method === "syncGistPush")).toEqual([]);
});
