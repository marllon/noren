import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { ManualClock } from "../packages/model/src/clock";
import { createDefaultWorkspace } from "../packages/model/src/default-workspace";
import { createSequentialIds } from "../packages/model/src/ids";
import { reduce } from "../packages/model/src/reducer";
import { exportSpace } from "../packages/model/src/space-file";
import { closeSettings, openSettings } from "./settings-fixture";
import { openCommandPalette } from "./palette-fixture";

// The spaces in the sync (NOR-F19-01c). The sync is the in-memory one of the web build, seeded under
// `noren.web.sync`, so nothing runs git or touches a network. A push writes every space as a
// `spaces/<name>.noren-space.json` file first and sends it; a pull makes spaces of the files that
// came in; and a second pull does not make them again, nor does the pull after a push bring back the
// spaces this computer wrote.

interface Hook {
  paneIds(): string[];
  syncLocalFile(path: string): string | null;
  syncRemoteFiles(): Record<string, string>;
  setSyncRemoteFile(path: string, text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_SYNC_KEY = "noren.web.sync";
const REMOTE = "https://example.com/me/noren-settings.git";

/** The file another computer would push for a space named `name` with `tabs` tabs (the first is the space's own). */
function remoteSpaceFile(name: string, tabs = 1): string {
  const ctx = { newId: createSequentialIds("remote"), clock: new ManualClock() };
  let ws = createDefaultWorkspace();
  const space = ws.spaces[0];
  if (space === undefined) throw new Error("the default workspace has a space");
  ws = reduce(ws, { type: "space/rename", spaceId: space.id, name }, ctx);
  for (let n = 1; n < tabs; n++) {
    ws = reduce(ws, { type: "item/create", spaceId: space.id }, ctx);
  }
  const made = exportSpace(ws.spaces[0] ?? space);
  if (!made.ok) throw new Error(made.error);
  return made.text;
}

const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const box = (page: Page): Locator =>
  palette(page).getByRole("combobox", { name: "Command palette", exact: true });
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
const switcher = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Spaces", exact: true });
const tabs = (page: Page): Locator =>
  page.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem");

/** Names of the space buttons, left to right (without "New space" and "Space options"). */
const spaceNames = (page: Page): Promise<string[]> =>
  switcher(page)
    .locator(".space-button:not(.space-add):not(.space-more)")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
const remoteFiles = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.syncRemoteFiles() ?? {});
const localFile = (page: Page, path: string): Promise<string | null> =>
  page.evaluate((p) => (window as HookWindow).__norenTest?.syncLocalFile(p) ?? null, path);
const setRemoteFile = (page: Page, path: string, text: string): Promise<void> =>
  page.evaluate(({ p, t }) => (window as HookWindow).__norenTest?.setSyncRemoteFile(p, t), {
    p: path,
    t: text,
  });

interface Seed {
  localFiles?: Record<string, string>;
  remoteFiles?: Record<string, string>;
}

async function start(page: Page, seed: Seed = {}): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_SYNC_KEY, value: JSON.stringify(seed) },
  );
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  expect(await spaceNames(page)).toEqual(["Main"]);
}

async function newSpace(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function connect(page: Page): Promise<void> {
  const screen = await openSettings(page);
  const sync = screen.getByRole("region", { name: "Sync", exact: true });
  await sync.getByRole("textbox", { name: "Remote address", exact: true }).fill(REMOTE);
  await sync.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(sync.locator('[data-nr-part="settings-sync-status"]')).toContainText("Connected to");
  await closeSettings(page);
}

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

/** Presses Push or Pull in the Sync section and returns what the section said. */
async function press(page: Page, name: "Push" | "Pull"): Promise<string> {
  const screen = await openSettings(page);
  const sync = screen.getByRole("region", { name: "Sync", exact: true });
  const said = sync.locator('[data-nr-part="settings-sync-note"]');
  await sync.getByRole("button", { name, exact: true }).click();
  await expect(said).toBeVisible();
  const text = (await said.textContent()) ?? "";
  await closeSettings(page);
  return text;
}

test("a space goes out with the push, as a file named after it", async ({ page }) => {
  await start(page);
  await newSpace(page, "Work: API");
  expect(await spaceNames(page)).toEqual(["Main", "Work: API"]);
  await connect(page);

  const said = await press(page, "Push");
  expect(said).toBe(
    "Pushed 2 files: spaces/Main.noren-space.json, spaces/Work- API.noren-space.json.",
  );
  const files = await remoteFiles(page);
  expect(Object.keys(files).sort()).toEqual([
    "spaces/Main.noren-space.json",
    "spaces/Work- API.noren-space.json",
  ]);
  expect(files["spaces/Work- API.noren-space.json"]).toContain('"name": "Work: API"');
  // Nothing but the closed list went: the local record of which file is which space stays here.
  expect(Object.keys(files).every((path) => path.startsWith("spaces/"))).toBe(true);

  const again = await press(page, "Push");
  expect(again).toBe("Nothing to push.");
});

test("two spaces with the same name get two files", async ({ page }) => {
  await start(page);
  await newSpace(page, "Work");
  await newSpace(page, "work");
  await connect(page);
  await press(page, "Push");
  expect(Object.keys(await remoteFiles(page)).sort()).toEqual([
    "spaces/Main.noren-space.json",
    "spaces/Work.noren-space.json",
    "spaces/work-2.noren-space.json",
  ]);
});

test("a space of the remote comes in with the pull, and a second pull does not repeat it", async ({
  page,
}) => {
  await start(page, {
    remoteFiles: { "spaces/Came.noren-space.json": remoteSpaceFile("Came") },
  });
  await connect(page);

  const first = await press(page, "Pull");
  expect(first).toBe(
    'Pulled 1 file: spaces/Came.noren-space.json. Added the space "Came" from the remote.',
  );
  expect(await spaceNames(page)).toEqual(["Main", "Came"]);
  // The pull did not take the person to the new space.
  await expect(switcher(page).getByRole("button", { name: "Main", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );

  const second = await press(page, "Pull");
  expect(second).toBe("Nothing to pull: this computer is up to date. Nothing changed.");
  expect(await spaceNames(page)).toEqual(["Main", "Came"]);

  // The same through the palette, and still one Came.
  await runCommand(page, "pull settings", "Pull settings");
  await expect(notice(page)).toHaveText(
    "Nothing to pull: this computer is up to date. Nothing changed.",
  );
  expect(await spaceNames(page)).toEqual(["Main", "Came"]);

  // Pushing what came in sends the same file back: the remote has not changed, and a pull after
  // it brings nothing.
  await press(page, "Push");
  expect(Object.keys(await remoteFiles(page)).sort()).toEqual([
    "spaces/Came.noren-space.json",
    "spaces/Main.noren-space.json",
  ]);
  expect(await press(page, "Pull")).toBe(
    "Nothing to pull: this computer is up to date. Nothing changed.",
  );
  expect(await spaceNames(page)).toEqual(["Main", "Came"]);
});

test("a space this computer exported does not come back as a second one on the next pull", async ({
  page,
}) => {
  await start(page);
  await newSpace(page, "Work");
  await connect(page);
  await press(page, "Push");

  // Another computer changes a mod; the pull brings that and no space.
  await setRemoteFile(page, "mods/other.css", "/* other */\n");
  expect(await press(page, "Pull")).toBe("Pulled 1 file: mods/other.css.");
  expect(await spaceNames(page)).toEqual(["Main", "Work"]);

  // And when another computer changes the file of Work, Work is made again in its place.
  const changed = remoteSpaceFile("Work", 2);
  await setRemoteFile(page, "spaces/Work.noren-space.json", changed);
  const said = await press(page, "Pull");
  expect(said).toContain('Updated the space "Work" from the remote');
  expect(said).toContain("closed tabs");
  expect(await spaceNames(page)).toEqual(["Main", "Work"]);
  await switcher(page).getByRole("button", { name: "Work", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  expect(await press(page, "Pull")).toBe(
    "Nothing to pull: this computer is up to date. Nothing changed.",
  );
  await expect(tabs(page)).toHaveCount(2);
});

test("Push settings and Pull settings in the palette carry the spaces too", async ({ page }) => {
  await start(page, {
    remoteFiles: { "spaces/Came.noren-space.json": remoteSpaceFile("Came") },
  });
  await connect(page);

  await runCommand(page, "pull settings", "Pull settings");
  await expect(notice(page)).toHaveText(
    'Pulled 1 file: spaces/Came.noren-space.json. Added the space "Came" from the remote.',
  );
  expect(await spaceNames(page)).toEqual(["Main", "Came"]);

  await runCommand(page, "push settings", "Push settings");
  await expect(notice(page)).toHaveText("Pushed 1 file: spaces/Main.noren-space.json.");
  expect(await localFile(page, "spaces/Main.noren-space.json")).toContain('"name": "Main"');
  expect((await remoteFiles(page))["spaces/Main.noren-space.json"]).toContain('"name": "Main"');
});

test("a file that is not a space file is said and skipped, and the others still come in", async ({
  page,
}) => {
  await start(page, {
    remoteFiles: {
      "spaces/Broken.noren-space.json": "{ not json",
      "spaces/Came.noren-space.json": remoteSpaceFile("Came"),
    },
  });
  await connect(page);
  const said = await press(page, "Pull");
  expect(said).toContain('Added the space "Came" from the remote.');
  expect(said).toContain("Skipped spaces/Broken.noren-space.json: it is not valid JSON.");
  expect(await spaceNames(page)).toEqual(["Main", "Came"]);
  expect(await localFile(page, "spaces/Broken.noren-space.json")).toBe("{ not json");
});
