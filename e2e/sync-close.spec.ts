import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { closeSettings, configText, openSettings, seedConfig } from "./settings-fixture";

// The push when the app closes (NOR-F19-01d). The web build has no window to close, so a test hook
// (`window.__norenClose.run()`) runs what the closing page runs: it saves, and then pushes only when
// `sync.pushOnClose` is on, a remote is connected and something waits. The sync is the in-memory one
// of the web build, seeded under `noren.web.sync`, so nothing runs git or touches a network.

interface Hook {
  paneIds(): string[];
  syncCalls(): { method: string; remote?: string }[];
  syncRemoteFiles(): Record<string, string>;
  setSyncLocalFile(path: string, text: string | null): void;
  failSync(message: string | null): void;
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
const REMOTE = "https://example.com/me/noren-settings.git";
const MINE = '// mine\n{ "terminal": { "scrollback": 500 } }\n';
const ON = '{ "sync": { "pushOnClose": true } }\n';

async function start(page: Page, config: string | null, localFiles: Record<string, string> = {}) {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_SYNC_KEY, value: JSON.stringify({ localFiles }) },
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

/** Connects the remote through the Sync section, then leaves the settings screen. */
async function connect(page: Page): Promise<void> {
  const screen = await openSettings(page);
  const sync = screen.getByRole("region", { name: "Sync", exact: true });
  await sync.getByRole("textbox", { name: "Remote address", exact: true }).fill(REMOTE);
  await sync.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(sync.locator('[data-nr-part="settings-sync-status"]')).toContainText(
    `Connected to ${REMOTE}`,
  );
  await closeSettings(page);
}

const close = (page: Page) =>
  page.evaluate(async () => {
    const hook = (window as HookWindow).__norenClose;
    if (hook === undefined) throw new Error("the close hook is missing");
    return hook.run();
  });
const remoteFiles = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.syncRemoteFiles() ?? {});
const pushes = async (page: Page): Promise<number> =>
  (await page.evaluate(() => (window as HookWindow).__norenTest?.syncCalls() ?? [])).filter(
    (call) => call.method === "syncPush",
  ).length;

test("closing with the option on and a file waiting pushes the settings and the spaces", async ({
  page,
}) => {
  await start(page, ON, { "config.jsonc": MINE });
  await connect(page);
  const { outcome, log } = await close(page);
  expect(outcome).toEqual({ kind: "pushed", files: 2 });
  expect(log).toEqual([]);
  const sent = await remoteFiles(page);
  expect(Object.keys(sent).sort()).toEqual(["config.jsonc", "spaces/Main.noren-space.json"]);
  expect(sent["config.jsonc"]).toBe(MINE);
  expect(JSON.parse(sent["spaces/Main.noren-space.json"] ?? "{}")).toMatchObject({
    format: "noren-space",
  });
  // Closed again with nothing new: nothing is pushed a second time.
  expect((await close(page)).outcome).toEqual({ kind: "skipped", reason: "nothing-pending" });
  expect(await pushes(page)).toBe(1);
});

test("closing with the option off sends nothing, even with files waiting", async ({ page }) => {
  await start(page, null, { "config.jsonc": MINE });
  await connect(page);
  const { outcome } = await close(page);
  expect(outcome).toEqual({ kind: "skipped", reason: "off" });
  expect(await remoteFiles(page)).toEqual({});
  expect(await pushes(page)).toBe(0);
});

test("closing with no remote connected does not try to push", async ({ page }) => {
  await start(page, ON, { "config.jsonc": MINE });
  const { outcome, log } = await close(page);
  expect(outcome).toEqual({ kind: "skipped", reason: "no-remote" });
  expect(log).toEqual([]);
  expect(await pushes(page)).toBe(0);
  expect(await remoteFiles(page)).toEqual({});
});

test("a failure of git is recorded and the close still ends", async ({ page }) => {
  await start(page, ON, { "config.jsonc": MINE });
  await connect(page);
  await page.evaluate(() => (window as HookWindow).__norenTest?.failSync("git is not installed"));
  const { outcome, log } = await close(page);
  expect(outcome).toEqual({ kind: "failed", reason: "git is not installed" });
  expect(log).toEqual(["push on close failed: git is not installed"]);
  expect(await remoteFiles(page)).toEqual({});
});

test("a file changed after the last push is pushed at the next close", async ({ page }) => {
  await start(page, ON, { "config.jsonc": MINE });
  await connect(page);
  expect((await close(page)).outcome).toEqual({ kind: "pushed", files: 2 });
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setSyncLocalFile("mods/round.css", "/* round */\n"),
  );
  expect((await close(page)).outcome).toEqual({ kind: "pushed", files: 1 });
  expect((await remoteFiles(page))["mods/round.css"]).toBe("/* round */\n");
});

test.describe("the check box in the Sync section", () => {
  const box = (screen: Locator): Locator =>
    screen
      .getByRole("region", { name: "Sync", exact: true })
      .getByRole("switch", { name: "Push when Noren closes", exact: true });

  test("is off by default, and turning it on writes sync.pushOnClose to config.jsonc", async ({
    page,
  }) => {
    await start(page, '// my settings\n{ "language": "en" }\n');
    const screen = await openSettings(page);
    await expect(box(screen)).not.toBeChecked();
    await box(screen).check();
    await expect(box(screen)).toBeChecked();
    await expect.poll(() => configText(page)).toContain('"pushOnClose": true');
    // The comments and the other settings of the file stay.
    const text = (await configText(page)) ?? "";
    expect(text).toContain("// my settings");
    expect(text).toContain('"language": "en"');
    await closeSettings(page);

    // And it holds: the setting is in force for the next close, and a reload shows it checked.
    await page.reload();
    const again = await openSettings(page);
    await expect(box(again)).toBeChecked();
    await box(again).uncheck();
    await expect.poll(() => configText(page)).toContain('"pushOnClose": false');
    await closeSettings(page);
  });

  test("changes what the close does at once, with no restart", async ({ page }) => {
    await start(page, null, { "config.jsonc": MINE });
    await connect(page);
    expect((await close(page)).outcome).toEqual({ kind: "skipped", reason: "off" });
    const screen = await openSettings(page);
    await box(screen).check();
    await closeSettings(page);
    expect((await close(page)).outcome).toEqual({ kind: "pushed", files: expect.any(Number) });
  });
});
