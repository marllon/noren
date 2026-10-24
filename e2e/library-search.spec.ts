import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";
import { numberTheTabs } from "./numbered-tabs";

test.beforeEach(numberTheTabs);

// The library looks in the saved output of the archived and closed tabs, and the start of the app
// removes the snapshot files that no pane claims. The fake shell of web mode keeps the files in the
// browser storage (a reload finds them) and its clock is moved by the page (`advanceClock`).

interface Hook {
  lines(): string[];
  paneIds(): string[];
  scrollbackFiles(): Record<string, string>;
  scrollbackCalls(): {
    method: "loadScrollback" | "saveScrollback" | "deleteScrollback";
    paneId: string;
  }[];
  scrollbackListCalls(): number;
  setScrollbackFile(paneId: string, text: string | null): void;
  advanceClock(ms: number): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const MINUTE = 60_000;
const CLOSE = "Control+Shift+W";
const LIBRARY = "Control+Alt+Shift+L";
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
const files = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.scrollbackFiles() ?? {});
const calls = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.scrollbackCalls() ?? []);
const listCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.scrollbackListCalls() ?? 0);
const advance = (page: Page, ms: number): Promise<void> =>
  page.evaluate((by) => (window as HookWindow).__norenTest?.advanceClock(by), ms);
const placeFile = (page: Page, paneId: string, text: string | null): Promise<void> =>
  page.evaluate(
    ([id, content]) =>
      (window as HookWindow).__norenTest?.setScrollbackFile(id ?? "", content ?? null),
    [paneId, text],
  );

async function waitForPrompt(page: Page): Promise<void> {
  await expect.poll(async () => (await lines(page)).some((l) => l.startsWith("fake$"))).toBe(true);
}

async function run(page: Page, line: string): Promise<void> {
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function renameCurrent(page: Page, from: string, to: string): Promise<void> {
  await tab(page, from).dblclick();
  const field = page.getByRole("textbox", { name: "Tab name", exact: true });
  await field.fill(to);
  await page.keyboard.press("Enter");
  await expect(field).toBeHidden();
  await expect(tab(page, to)).toBeFocused();
}

/**
 * Opens a tab named `name` (the first one already exists) and prints `word` in it: a word that is
 * not in the title and not in the folder, so only the saved output has it.
 */
async function makeTab(page: Page, name: string, word: string, first = false): Promise<string> {
  const before = (await labels(page)).length;
  if (!first) await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect.poll(async () => (await labels(page)).length).toBe(before + (first ? 0 : 1));
  await renameCurrent(page, first ? "Tab 1" : `Tab ${before + 1}`, name);
  await waitForPrompt(page);
  await run(page, `echo ${word}`);
  await expect.poll(async () => (await lines(page)).includes(word)).toBe(true);
  const [paneId = ""] = await paneIds(page);
  return paneId;
}

const library = (page: Page): Locator => page.getByRole("dialog", { name: "Library", exact: true });
const rows = (page: Page): Locator => library(page).locator('[data-nr-part="library-row"]');
const snippet = (row: Locator): Locator => row.locator('[data-nr-part="library-snippet"]');
const section = (page: Page, name: "Archive" | "Closed"): Locator =>
  library(page).getByRole("tab", { name, exact: true });
const search = (page: Page): Locator =>
  library(page).getByRole("textbox", { name: "Search the library", exact: true });

async function openLibrary(page: Page): Promise<void> {
  await page.keyboard.press(LIBRARY);
  await expect(library(page)).toBeVisible();
  await expect(search(page)).toBeFocused();
}

test("the library finds an archived tab and a closed tab by a word only their saved output has, and shows the line", async ({
  page,
}) => {
  await seedConfig(page, ONE_HOUR);
  await page.goto("/");
  await waitForPrompt(page);
  await makeTab(page, "alpha", "quartzword-first", true);
  await makeTab(page, "beta", "emberword-second");
  await makeTab(page, "gamma", "jasperword-third");
  await makeTab(page, "keeper", "plainword-fourth");

  // gamma closes; alpha and beta go quiet and are archived.
  await tab(page, "gamma").click();
  await expect(tab(page, "gamma")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press(CLOSE);
  await expect(tab(page, "gamma")).toHaveCount(0);
  await tab(page, "keeper").click();
  await advance(page, 62 * MINUTE);
  await expect.poll(() => labels(page)).toEqual(["keeper"]);

  await openLibrary(page);
  await expect(rows(page)).toHaveCount(2);
  // No row has a line of output while nothing is typed.
  await expect(library(page).locator('[data-nr-part="library-snippet"]')).toHaveCount(0);

  // A word only the output has: the title and the folder do not.
  await search(page).fill("quartzword");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("alpha");
  await expect(snippet(rows(page).first())).toContainText("quartzword-first");
  await search(page).fill("EMBERWORD");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("beta");
  // Every word has to be found, in the title or the output.
  await search(page).fill("beta ember");
  await expect(rows(page)).toHaveCount(1);
  await expect(snippet(rows(page).first())).toContainText("emberword-second");
  await search(page).fill("alpha emberword");
  await expect(rows(page)).toHaveCount(0);
  await expect(library(page).getByRole("status")).toHaveText("No matches");
  // The title still works, with no line of output under the row.
  await search(page).fill("alpha");
  await expect(rows(page)).toHaveCount(1);
  await expect(snippet(rows(page).first())).toHaveCount(0);

  // The closed tab has its own section, searched the same way; the other section's output is not.
  await section(page, "Closed").click();
  await search(page).fill("jasperword");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("gamma");
  await expect(snippet(rows(page).first())).toContainText("jasperword-third");
  await search(page).fill("quartzword");
  await expect(rows(page)).toHaveCount(0);

  // The result can be restored like any row.
  await search(page).fill("jasperword");
  await page.keyboard.press("Enter");
  await expect(library(page)).toBeHidden();
  await expect(tab(page, "gamma")).toHaveAttribute("aria-current", "true");
});

test("hostile text in a saved output is searched and shown as text, never as markup or as a command", async ({
  page,
}) => {
  await seedConfig(page, ONE_HOUR);
  await page.goto("/");
  await waitForPrompt(page);
  const alpha = await makeTab(page, "alpha", "plainword", true);
  await makeTab(page, "keeper", "keeperword");
  await advance(page, 62 * MINUTE);
  await expect.poll(() => labels(page)).toEqual(["keeper"]);
  await expect.poll(async () => (await files(page))[alpha] ?? "").toContain("plainword");

  // Somebody changes the file on disk.
  await placeFile(
    page,
    alpha,
    '<img src=x onerror="document.title=1">hostile \x1b]52;c;ZWNobyBoaQ==\x07\x1b]0;stolen\x07\x1b[6n\x1b[?1049hmarker\x1b[31m<b>bold</b>',
  );
  await openLibrary(page);
  await search(page).fill("hostile");
  await expect(rows(page)).toHaveCount(1);
  const shown = snippet(rows(page).first());
  // The text is there as text: the tags are characters, the escapes are gone.
  await expect(shown).toContainText('onerror="document.title=1">hostile marker');
  await expect(shown).toContainText("<b>bold</b>");
  expect(await shown.textContent()).not.toContain("\x1b");
  expect(await shown.textContent()).not.toContain("ZWNobyBoaQ==");
  expect(await shown.textContent()).not.toContain("stolen");
  // And none of it became an element.
  await expect(library(page).locator("img, b, script")).toHaveCount(0);
  expect(await page.title()).not.toBe("1");
  expect(await page.title()).not.toContain("stolen");
  // What cleans to nothing, like a title, is not searchable.
  await search(page).fill("stolen");
  await expect(rows(page)).toHaveCount(0);
});

test("the start of the app removes the snapshot files no pane claims and keeps the ones of open, closed and archived tabs", async ({
  page,
}) => {
  await seedConfig(page, ONE_HOUR);
  await page.goto("/");
  await waitForPrompt(page);
  const alpha = await makeTab(page, "alpha", "alphaword", true);
  const beta = await makeTab(page, "beta", "betaword");
  const gamma = await makeTab(page, "gamma", "gammaword");
  const keeper = await makeTab(page, "keeper", "keeperword");

  // gamma closes; alpha and beta are archived; keeper stays open.
  await tab(page, "gamma").click();
  await expect(tab(page, "gamma")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press(CLOSE);
  await expect(tab(page, "gamma")).toHaveCount(0);
  await tab(page, "keeper").click();
  await advance(page, 62 * MINUTE);
  await expect.poll(() => labels(page)).toEqual(["keeper"]);
  await expect
    .poll(() => files(page).then((f) => Object.keys(f).sort()))
    .toEqual([alpha, beta, gamma, keeper].sort());

  // Files left by a crash, an older build or a pane that is gone: no pane has them.
  const orphans = ["orphan-one", "11111111-2222-4333-8444-555555555555"];
  for (const id of orphans) await placeFile(page, id, `stale ${id}`);
  // A file with a name that is not a pane id is not a snapshot and is never listed.
  expect(Object.keys(await files(page))).toHaveLength(6);

  await page.reload();
  await waitForPrompt(page);
  await expect.poll(() => listCalls(page)).toBe(1);
  await expect
    .poll(() => files(page).then((f) => Object.keys(f).sort()))
    .toEqual([alpha, beta, gamma, keeper].sort());
  // Only the orphans were removed; no file of a pane was asked to go.
  const removed = (await calls(page))
    .filter((call) => call.method === "deleteScrollback")
    .map((call) => call.paneId)
    .sort();
  expect(removed).toEqual([...orphans].sort());

  // The tabs that left still have their output: the archive, the closed stack and the search.
  await openLibrary(page);
  await expect(rows(page)).toHaveCount(2);
  await search(page).fill("betaword");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("beta");
  await section(page, "Closed").click();
  await search(page).fill("gammaword");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("gamma");
});
