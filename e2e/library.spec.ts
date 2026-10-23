import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { seedConfig } from "./settings-fixture";

// The auto-archive and the library. A tab nobody uses goes to the archive after `archive.afterHours`
// (a short wait in these tests), with its place and its output, and comes back from the library
// with its folder and the old output dimmed above a new shell. The library also lists the closed
// tabs, searches by title and folder, and deletes for good. The fake shell of web mode keeps the
// snapshot files in the browser storage and its clock is moved by the page (`advanceClock`), which
// is also the clock of the checks of the archive: an hour on it is an hour for every tab.

interface Hook {
  lines(): string[];
  paneIds(): string[];
  paneDimLines(paneId: string): string[];
  sessionStarts(): { profileId?: string; cwd?: string }[];
  scrollbackFiles(): Record<string, string>;
  advanceClock(ms: number): void;
  scrollbackCalls(): {
    method: "loadScrollback" | "saveScrollback" | "deleteScrollback";
    paneId: string;
  }[];
}
type HookWindow = Window & { __norenTest?: Hook };

const MARKER = /^session restored \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const MINUTE = 60_000;
const CLOSE = "Control+Shift+W";
const LIBRARY = "Control+Alt+Shift+L";

/** One hour of waiting, and the tabs that are quiet get archived. */
const ONE_HOUR = '{ "archive": { "afterHours": 1 } }';

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const labels = (page: Page): Promise<string[]> =>
  list(page)
    .locator('[data-nr-part="item"]')
    .evaluateAll((all) =>
      all.map((el) => el.querySelector('[data-nr-part="item-title"]')?.textContent ?? ""),
    );

const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);
const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const dimLines = (page: Page, paneId: string): Promise<string[]> =>
  page.evaluate((id) => (window as HookWindow).__norenTest?.paneDimLines(id) ?? [], paneId);
const sessionStarts = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts() ?? []);
const files = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.scrollbackFiles() ?? {});
const calls = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.scrollbackCalls() ?? []);
const advance = (page: Page, ms: number): Promise<void> =>
  page.evaluate((by) => (window as HookWindow).__norenTest?.advanceClock(by), ms);

async function waitForPrompt(page: Page): Promise<void> {
  await expect.poll(async () => (await lines(page)).some((l) => l.startsWith("fake$"))).toBe(true);
}

async function run(page: Page, line: string): Promise<void> {
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function waitForLine(page: Page, text: string): Promise<void> {
  await expect.poll(async () => (await lines(page)).includes(text)).toBe(true);
}

/** Gives the tab on screen a name that stays (a typed name locks the title). */
async function renameCurrent(page: Page, from: string, to: string): Promise<void> {
  await tab(page, from).dblclick();
  const field = page.getByRole("textbox", { name: "Tab name", exact: true });
  await field.fill(to);
  await page.keyboard.press("Enter");
  await expect(field).toBeHidden();
  // The focus goes back to the row that was renamed; keys typed before that would be lost.
  await expect(tab(page, to)).toBeFocused();
}

interface Made {
  name: string;
  folder: string;
  paneId: string;
}

/**
 * Opens a tab (the first one already exists) named `name`, moves its shell to `/srv/<name>` and
 * prints `out-<name>`: the folder and the output that must come back. The new tab is the one shown.
 */
async function makeTab(page: Page, name: string, first = false): Promise<Made> {
  const before = (await labels(page)).length;
  if (!first) await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect.poll(async () => (await labels(page)).length).toBe(before + (first ? 0 : 1));
  // The shell tells the home folder at its first prompt, and a tab nobody named is called after it.
  await renameCurrent(page, "~", name);
  await waitForPrompt(page);
  const folder = `/srv/${name}`;
  await run(page, `cd ${folder}`);
  // The shell reports its folder at the next prompt: the next line is typed after that.
  await expect(tab(page, name)).toContainText(folder);
  await run(page, `echo out-${name}`);
  await waitForLine(page, `out-${name}`);
  const [paneId = ""] = await paneIds(page);
  return { name, folder, paneId };
}

async function showTab(page: Page, name: string): Promise<void> {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute("aria-current", "true");
}

const library = (page: Page): Locator => page.getByRole("dialog", { name: "Library", exact: true });
const rows = (page: Page): Locator => library(page).locator('[data-nr-part="library-row"]');
const section = (page: Page, name: "Archive" | "Closed"): Locator =>
  library(page).getByRole("tab", { name, exact: true });
const search = (page: Page): Locator =>
  library(page).getByRole("textbox", { name: "Search the library", exact: true });

async function openLibrary(page: Page): Promise<void> {
  await page.keyboard.press(LIBRARY);
  await expect(library(page)).toBeVisible();
  await expect(search(page)).toBeFocused();
}

/** The tab that shows is `made`: its old output above the marker, dimmed, and a prompt of a new shell below it. */
async function expectRestored(page: Page, made: Made, shellsBefore: number): Promise<void> {
  await expect(tab(page, made.name)).toHaveAttribute("aria-current", "true");
  await expect.poll(async () => (await lines(page)).some((l) => MARKER.test(l))).toBe(true);
  await waitForPrompt(page);
  const shown = await lines(page);
  const old = shown.indexOf(`out-${made.name}`);
  const marker = shown.findIndex((l) => MARKER.test(l));
  expect(old).toBeGreaterThanOrEqual(0);
  expect(marker).toBeGreaterThan(old);
  expect(shown.slice(marker + 1).some((l) => l.startsWith("fake$"))).toBe(true);
  // A new shell, in the folder the old one had moved to.
  const starts = await sessionStarts(page);
  expect(starts).toHaveLength(shellsBefore + 1);
  expect(starts.at(-1)?.cwd).toBe(made.folder);
  // The old lines are dimmed in the terminal buffer; the prompt of the new shell is not.
  const [pane = ""] = await paneIds(page);
  expect(pane).toBe(made.paneId);
  const dim = await dimLines(page, pane);
  expect(dim).toContain(`out-${made.name}`);
  expect(dim.some((l) => MARKER.test(l))).toBe(true);
}

test("an idle tab goes to the archive and comes back from the library with its folder and its output dimmed", async ({
  page,
}) => {
  await seedConfig(page, ONE_HOUR);
  await page.goto("/");
  await waitForPrompt(page);
  const alpha = await makeTab(page, "alpha", true);
  await makeTab(page, "beta");
  expect(await labels(page)).toEqual(["alpha", "beta"]);
  expect(await files(page)).toEqual({});

  // Fifty minutes is not an hour: nothing moves.
  await advance(page, 50 * MINUTE);
  expect(await labels(page)).toEqual(["alpha", "beta"]);

  // Past the hour the tab nobody used goes; the one on screen stays.
  await advance(page, 12 * MINUTE);
  await expect.poll(() => labels(page)).toEqual(["beta"]);
  // Its output was written as it left, with no minute of saves in between.
  await expect.poll(async () => (await files(page))[alpha.paneId] ?? "").toContain("out-alpha");

  await openLibrary(page);
  await expect(section(page, "Archive")).toHaveAttribute("aria-selected", "true");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("alpha");
  await expect(rows(page).first()).toContainText("/srv/alpha");
  await expect(rows(page).first()).toContainText("Main");

  const shells = (await sessionStarts(page)).length;
  await library(page)
    .getByRole("button", { name: /^Restore alpha / })
    .click();
  await expect(library(page)).toBeHidden();
  // Back where it was, shown, with its folder and its old output.
  await expect.poll(() => labels(page)).toEqual(["alpha", "beta"]);
  await expectRestored(page, alpha, shells);
  // The terminal has the keyboard again.
  await expect(page.getByRole("textbox", { name: "Terminal input", exact: true })).toBeFocused();
  // The file stays: the tab that is open again owns it.
  expect((await files(page))[alpha.paneId]).toContain("out-alpha");
  expect((await calls(page)).filter((c) => c.method === "deleteScrollback")).toEqual([]);
});

test("a tab with a command running, a pinned tab and a favorite are never archived", async ({
  page,
}) => {
  await seedConfig(page, ONE_HOUR);
  await page.goto("/");
  await waitForPrompt(page);
  await makeTab(page, "runner", true);
  await run(page, "sleep 7200");
  await expect(tab(page, "runner")).toContainText("sleep 7200");
  await makeTab(page, "pinned");
  await makeTab(page, "fav");
  await makeTab(page, "idle");
  await makeTab(page, "keeper");

  await tab(page, "pinned").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await tab(page, "fav").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add to favorites", exact: true }).click();
  await showTab(page, "keeper");

  // An hour goes by, and a little more: only the quiet one leaves.
  await advance(page, 62 * MINUTE);
  await expect.poll(async () => (await labels(page)).includes("idle")).toBe(false);
  expect((await labels(page)).sort()).toEqual(["fav", "keeper", "pinned", "runner"]);

  // Two hours in, the command ends and the tab prints its prompt: the quiet time starts there.
  await advance(page, 60 * MINUTE);
  expect(await labels(page)).toContain("runner");
  await advance(page, 30 * MINUTE);
  expect(await labels(page)).toContain("runner");
  await advance(page, 40 * MINUTE);
  await expect.poll(async () => (await labels(page)).includes("runner")).toBe(false);
  // Pinned and favorite are still here, a long time later.
  await advance(page, 24 * 60 * MINUTE);
  expect((await labels(page)).sort()).toEqual(["fav", "keeper", "pinned"]);
});

test("with the setting off nothing is archived, however long it takes", async ({ page }) => {
  await seedConfig(page, '{ "archive": { "enabled": false, "afterHours": 1 } }');
  await page.goto("/");
  await waitForPrompt(page);
  await makeTab(page, "alpha", true);
  await makeTab(page, "beta");
  await advance(page, 5 * 60 * MINUTE);
  expect(await labels(page)).toEqual(["alpha", "beta"]);
  await openLibrary(page);
  await expect(rows(page)).toHaveCount(0);
  await expect(library(page).getByRole("status")).toHaveText("Nothing in the archive yet.");
});

test("the library lists the archive and the closed tabs, searches by title and folder, restores a closed one and deletes for good", async ({
  page,
}) => {
  await seedConfig(page, ONE_HOUR);
  await page.goto("/");
  await waitForPrompt(page);
  const alpha = await makeTab(page, "alpha", true);
  const beta = await makeTab(page, "beta");
  const gamma = await makeTab(page, "gamma");
  const delta = await makeTab(page, "delta");
  const keeper = await makeTab(page, "keeper");

  // gamma and delta close; alpha and beta go quiet.
  for (const made of [gamma, delta]) {
    await showTab(page, made.name);
    await page.keyboard.press(CLOSE);
    await expect(tab(page, made.name)).toHaveCount(0);
  }
  await showTab(page, "keeper");
  await advance(page, 62 * MINUTE);
  await expect.poll(() => labels(page)).toEqual(["keeper"]);

  await openLibrary(page);
  await expect(section(page, "Archive")).toHaveAttribute("aria-selected", "true");
  await expect(rows(page)).toHaveCount(2);
  await expect(section(page, "Archive")).toContainText("2");
  await expect(section(page, "Closed")).toContainText("2");

  // The search narrows by title...
  await search(page).fill("alp");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("alpha");
  // ...and by folder, whatever case it is typed in.
  await search(page).fill("/SRV/beta");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("beta");
  await search(page).fill("zzz");
  await expect(rows(page)).toHaveCount(0);
  await expect(library(page).getByRole("status")).toHaveText("No matches");
  await search(page).fill("");
  await expect(rows(page)).toHaveCount(2);

  // The closed tabs are the other section, the last closed first.
  await section(page, "Closed").click();
  await expect(section(page, "Closed")).toHaveAttribute("aria-selected", "true");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText("delta");
  await expect(rows(page).nth(1)).toContainText("gamma");

  // Deleting asks first; "Cancel" keeps everything.
  await library(page).getByRole("button", { name: "Delete gamma", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete from library", exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(rows(page)).toHaveCount(2);
  expect((await files(page))[gamma.paneId]).toContain("out-gamma");

  // Confirming removes the entry and its file.
  await library(page).getByRole("button", { name: "Delete gamma", exact: true }).click();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("delta");
  await expect.poll(async () => (await files(page))[gamma.paneId]).toBeUndefined();
  expect(await files(page)).toHaveProperty([delta.paneId]);

  // An archived tab goes the same way.
  await section(page, "Archive").click();
  await library(page).getByRole("button", { name: "Delete beta", exact: true }).click();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("alpha");
  await expect.poll(async () => (await files(page))[beta.paneId]).toBeUndefined();
  expect((await files(page))[alpha.paneId]).toContain("out-alpha");
  const removed = (await calls(page)).filter((c) => c.method === "deleteScrollback");
  expect(removed.map((c) => c.paneId).sort()).toEqual([beta.paneId, gamma.paneId].sort());

  // What was deleted stays deleted after the page is loaded again.
  await page.keyboard.press("Escape");
  await expect(library(page)).toBeHidden();
  // What is left: the archived alpha, the closed delta, and the tab that stayed open (the saves of
  // every minute wrote it while the clock moved).
  await expect
    .poll(() => files(page).then((f) => Object.keys(f).sort()))
    .toEqual([alpha.paneId, delta.paneId, keeper.paneId].sort());
  await page.reload();
  await waitForPrompt(page);
  await openLibrary(page);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("alpha");
  await section(page, "Closed").click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("delta");

  // A closed tab comes back from the library too, as it does from the shortcut.
  const shells = (await sessionStarts(page)).length;
  await library(page)
    .getByRole("button", { name: /^Restore delta / })
    .click();
  await expect(library(page)).toBeHidden();
  await expectRestored(page, delta, shells);
  expect(await labels(page)).toEqual(["keeper", "delta"]);
});

test("the library opens from the palette and from its shortcut (the browser preset here, the safe one in the other tests), and Escape gives the terminal back", async ({
  page,
}) => {
  await seedConfig(page, '{ "keybindings": { "preset": "browser" } }');
  await page.goto("/");
  await waitForPrompt(page);

  // The shortcut is the same in the browser preset.
  await openLibrary(page);
  await expect(library(page).getByRole("status")).toHaveText("Nothing in the archive yet.");
  await page.keyboard.press("Escape");
  await expect(library(page)).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Terminal input", exact: true })).toBeFocused();

  // And the palette lists it with the chord in force.
  await page.keyboard.press("Control+Shift+P");
  const palette = page.locator('[data-nr-part="palette"]');
  await expect(palette).toBeVisible();
  await palette
    .getByRole("combobox", { name: "Command palette", exact: true })
    .fill("Open library");
  const option = palette.getByRole("option", { name: /Open library/ });
  await expect(option).toBeVisible();
  await expect(option).toContainText("Ctrl+Alt+Shift+L");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(library(page)).toBeVisible();
  await expect(search(page)).toBeFocused();
  // Closed tabs have their own section even when none is there.
  await section(page, "Closed").click();
  await expect(library(page).getByRole("status")).toHaveText("No recently closed tabs.");
  await page.keyboard.press("Escape");
  await expect(library(page)).toBeHidden();
});

test("the arrows and Enter drive the list from the search box", async ({ page }) => {
  await seedConfig(page, ONE_HOUR);
  await page.goto("/");
  await waitForPrompt(page);
  await makeTab(page, "alpha", true);
  await makeTab(page, "beta");
  await makeTab(page, "keeper");
  await advance(page, 62 * MINUTE);
  await expect.poll(() => labels(page)).toEqual(["keeper"]);

  await openLibrary(page);
  await expect(rows(page)).toHaveCount(2);
  // The first row is selected; Down moves to the next, Up goes back, and they wrap.
  await expect(rows(page).first()).toHaveAttribute("data-nr-state", "selected");
  const first = (await rows(page).first().textContent()) ?? "";
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(1)).toHaveAttribute("data-nr-state", "selected");
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).first()).toHaveAttribute("data-nr-state", "selected");
  await page.keyboard.press("ArrowUp");
  await expect(rows(page).nth(1)).toHaveAttribute("data-nr-state", "selected");
  const second = (await rows(page).nth(1).textContent()) ?? "";
  expect(second).not.toBe(first);

  // Enter restores the selected one.
  const name = second.includes("alpha") ? "alpha" : "beta";
  await page.keyboard.press("Enter");
  await expect(library(page)).toBeHidden();
  await expect(tab(page, name)).toHaveAttribute("aria-current", "true");
});

test.describe("accessibility", () => {
  test("axe: the library with nothing in it has no violation", async ({ page }) => {
    await seedConfig(page, ONE_HOUR);
    await page.goto("/");
    await waitForPrompt(page);
    await openLibrary(page);
    await expect(rows(page)).toHaveCount(0);
    await expectNoAxeViolations(page, "library, empty");
  });

  test("axe: the library with an archived and a closed tab, a search without a match and the question to delete has no violation", async ({
    page,
  }) => {
    await seedConfig(page, ONE_HOUR);
    await page.goto("/");
    await waitForPrompt(page);
    await makeTab(page, "alpha", true);
    const beta = await makeTab(page, "beta");
    await makeTab(page, "keeper");
    await showTab(page, beta.name);
    await page.keyboard.press(CLOSE);
    await expect(tab(page, beta.name)).toHaveCount(0);
    await showTab(page, "keeper");
    await advance(page, 62 * MINUTE);
    await expect.poll(() => labels(page)).toEqual(["keeper"]);

    await openLibrary(page);
    await expect(rows(page)).toHaveCount(1);
    await expectNoAxeViolations(page, "library, archive");
    await section(page, "Closed").click();
    await expect(rows(page)).toHaveCount(1);
    await expectNoAxeViolations(page, "library, closed tabs");
    await search(page).fill("zzz");
    await expect(library(page).getByRole("status")).toHaveText("No matches");
    await expectNoAxeViolations(page, "library, no match");
    await search(page).fill("");
    await library(page).getByRole("button", { name: "Delete beta", exact: true }).click();
    await expect(
      page.getByRole("alertdialog", { name: "Delete from library", exact: true }),
    ).toBeVisible();
    await expectNoAxeViolations(page, "library, delete question");
  });
});
