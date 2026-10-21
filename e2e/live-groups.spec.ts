import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { seedGitRepos } from "./sidebar-fixture";

// Live groups in the sidebar (NOR-F17-04b): "New group of worktrees" in the palette makes a group
// whose entries are the worktrees of the repository of the folder in use; clicking an entry opens
// it (a tab in the group, and only that tab shown on the next click), and a worktree the app makes
// shows up without waiting. In web mode the fake backend answers from the repositories seeded under
// `noren.web.git`; the ten-second round is on the manual clock of the fake backend, so only the
// start and the immediate question after a change of the app ask.

const REPO = "/work/repo";

const tree = (page: Page): Locator => page.getByRole("tree", { name: "Tabs", exact: true });
const tabs = (page: Page): Locator => tree(page).locator('[data-nr-part="item"]');
const entries = (page: Page): Locator => tree(page).locator('[data-nr-part="live-entry"]');
const groups = (page: Page): Locator => tree(page).locator('[data-nr-part="group"]');
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const cwdOf = (tab: Locator): Locator => tab.locator('[data-nr-part="item-cwd"]');

/** Types a line into the terminal in use. */
async function run(page: Page, line: string): Promise<void> {
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/** Opens the app with a repository seeded and the shell of the first tab inside it. */
async function startInRepo(page: Page): Promise<void> {
  await seedGitRepos(page, { [REPO]: "main" });
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await run(page, `cd ${REPO}`);
  await expect(cwdOf(tabs(page).first())).toHaveText(REPO);
}

/** Runs a command of the palette by typing its name. */
async function runFromPalette(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  const box = palette(page).getByRole("combobox", { name: "Command palette", exact: true });
  await box.fill(name);
  await expect(palette(page).getByRole("option").first()).toContainText(name);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
}

/** Makes a worktree on `branch` through the palette and the dialog; the new tab opens in it. */
async function createWorktree(page: Page, branch: string): Promise<void> {
  await runFromPalette(page, "New worktree");
  const dialog = page.getByRole("dialog", { name: "New worktree", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Branch", exact: true }).fill(branch);
  await dialog.getByRole("button", { name: "Create worktree", exact: true }).click();
  await expect(dialog).toBeHidden();
}

const labels = (page: Page): Promise<string[]> =>
  entries(page).locator('[data-nr-part="live-entry-label"]').allTextContents();

test("the command makes a live group whose entries are the worktrees of the folder in use", async ({
  page,
}) => {
  await startInRepo(page);
  await expect(groups(page)).toHaveCount(0);
  await runFromPalette(page, "New group of worktrees");

  const group = groups(page).first();
  await expect(group).toBeVisible();
  await expect(group).toContainText("Worktrees of repo");
  // The entry shows at once, without waiting for the round of ten seconds, and is not a tab.
  await expect(entries(page)).toHaveCount(1);
  expect(await labels(page)).toEqual(["main"]);
  await expect(tabs(page)).toHaveCount(1);
  await expect(group.locator('[data-nr-part="group-count"]')).toHaveText("0");
  // Under the group, named by its label, reachable by the keyboard like the other rows.
  const entry = tree(page).getByRole("treeitem", { name: "main", exact: true });
  await expect(entry).toHaveCount(1);
  await expect(entry).toHaveAttribute("title", REPO);
  await expect(entry).toHaveAttribute("aria-level", "2");
});

test("clicking an entry makes a tab in the group once, and later only shows it", async ({
  page,
}) => {
  await startInRepo(page);
  await runFromPalette(page, "New group of worktrees");
  await expect(entries(page)).toHaveCount(1);

  await entries(page).first().click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(groups(page).first().locator('[data-nr-part="group-count"]')).toHaveText("1");
  const opened = tabs(page).nth(1);
  await expect(opened).toHaveAttribute("aria-selected", "true");
  await expect(cwdOf(opened)).toHaveText(REPO);

  // Another tab takes the screen; the entry shows the tab again and makes no second one.
  await tabs(page).first().click();
  await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
  await entries(page).first().click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(opened).toHaveAttribute("aria-selected", "true");

  // By the keyboard: the entry is a row of the tree and Enter opens it.
  await tabs(page).first().click();
  await entries(page).first().focus();
  await page.keyboard.press("Enter");
  await expect(opened).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page)).toHaveCount(2);
});

test("a worktree the app makes shows up under the group", async ({ page }) => {
  await startInRepo(page);
  await runFromPalette(page, "New group of worktrees");
  await expect(entries(page)).toHaveCount(1);

  await createWorktree(page, "feature/login");
  await expect(entries(page)).toHaveCount(2);
  expect(await labels(page)).toEqual(["main", "feature/login"]);

  // The new entry opens a tab of the group in the folder of the worktree.
  await entries(page).nth(1).click();
  const inGroup = groups(page).first().locator('[data-nr-part="group-count"]');
  await expect(inGroup).toHaveText("1");
  await expect(cwdOf(tabs(page).last())).toHaveText("/work/repo-feature-login");
});

test("the arrows walk from the group into its entries and Delete leaves them alone", async ({
  page,
}) => {
  await startInRepo(page);
  await runFromPalette(page, "New group of worktrees");
  await expect(entries(page)).toHaveCount(1);

  // The terminal takes the keyboard back after the palette closes; the tree is reached after that.
  await expect(
    page.getByRole("textbox", { name: "Terminal input", exact: true }).first(),
  ).toBeFocused();
  await groups(page).first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(entries(page).first()).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(entries(page)).toHaveCount(1);
  await expect(tabs(page)).toHaveCount(1);
  await page.keyboard.press("ArrowLeft");
  await expect(groups(page).first()).toBeFocused();
});

test("axe: a sidebar with a live group has no violation", async ({ page }) => {
  await startInRepo(page);
  await runFromPalette(page, "New group of worktrees");
  await expect(entries(page)).toHaveCount(1);
  await expectNoAxeViolations(page, "sidebar with a live group");
});

test("a folder with no repository makes a group that says why it lists nothing", async ({
  page,
}) => {
  await seedGitRepos(page, { [REPO]: "main" });
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await run(page, "cd /elsewhere");
  await expect(cwdOf(tabs(page).first())).toHaveText("/elsewhere");
  await runFromPalette(page, "New group of worktrees");
  await expect(groups(page).first()).toContainText("Worktrees of elsewhere");
  await expect(entries(page)).toHaveCount(0);
  await expect(tree(page).locator('[data-nr-part="live-error"]')).toContainText(
    "Could not update:",
  );
});

test("with no known folder the command only says so and makes no group", async ({ page }) => {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await runFromPalette(page, "New group of worktrees");
  await expect(
    page
      .locator('[data-nr-part="pane-notice"], [role="status"]')
      .filter({ hasText: "no known folder" }),
  ).toBeVisible();
  await expect(groups(page)).toHaveCount(0);
});

test("axe: a group that says why it lists nothing has no violation", async ({ page }) => {
  await seedGitRepos(page, { [REPO]: "main" });
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await run(page, "cd /elsewhere");
  await expect(cwdOf(tabs(page).first())).toHaveText("/elsewhere");
  await runFromPalette(page, "New group of worktrees");
  await expect(tree(page).locator('[data-nr-part="live-error"]')).toContainText(
    "Could not update:",
  );
  await expectNoAxeViolations(page, "live group with an error");
});
