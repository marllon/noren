import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { seedGitRepos } from "./sidebar-fixture";
import { runPaletteCommand } from "./palette-fixture";

// "New worktree" and "Remove worktree" in the palette, over the repository of the folder of the
// pane in use. In web mode the fake backend answers from the repositories seeded under
// `noren.web.git`; the real `git` is tried by the Rust tests (`worktree_real.rs`).

type TestHook = { setWorktreeDirty(path: string, dirty: boolean): void };
type HookWindow = Window & { __norenTest?: TestHook };

const REPO = "/work/repo";

const tabs = (page: Page): Locator =>
  page.getByRole("tree", { name: "Tabs", exact: true }).locator('[data-nr-part="item"]');
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

const newDialog = (page: Page): Locator =>
  page.getByRole("dialog", { name: "New worktree", exact: true });
const removeDialog = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Remove worktree", exact: true });
const confirm = (page: Page): Locator =>
  page.getByRole("alertdialog", { name: "Remove this worktree?", exact: true });

/** Makes a worktree on `branch` through the palette and the dialog; the new tab opens in it. */
async function createWorktree(page: Page, branch: string): Promise<void> {
  await runPaletteCommand(page, "New worktree");
  const dialog = newDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Branch", exact: true }).fill(branch);
  await dialog.getByRole("button", { name: "Create worktree", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("New worktree asks for the branch, makes it next to the repository and opens a tab in it", async ({
  page,
}) => {
  await startInRepo(page);
  await runPaletteCommand(page, "New worktree");

  const dialog = newDialog(page);
  await expect(dialog.getByRole("textbox", { name: "Branch", exact: true })).toBeFocused();
  // Nothing to create without a branch, and a dash is refused before git is asked.
  const create = dialog.getByRole("button", { name: "Create worktree", exact: true });
  await expect(create).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Branch", exact: true }).fill("-x");
  await expect(create).toBeDisabled();
  // The folder it would make is shown as the branch is typed.
  await dialog.getByRole("textbox", { name: "Branch", exact: true }).fill("feature/login");
  await expect(dialog.getByText(`Folder: /work/repo-feature-login`, { exact: true })).toBeVisible();
  await create.click();

  await expect(dialog).toBeHidden();
  await expect(tabs(page)).toHaveCount(2);
  // The new tab is the active one and its folder is the worktree, on its own branch.
  const added = tabs(page).nth(1);
  await expect(added).toHaveAttribute("aria-selected", "true");
  await expect(cwdOf(added)).toHaveText("/work/repo-feature-login");
  await expect(added.locator('[data-nr-part="item-branch"]')).toHaveText("feature/login");
  // The first tab is where it was.
  await expect(cwdOf(tabs(page).first())).toHaveText(REPO);
});

test("a branch that git refuses stays in the dialog with the reason, and nothing opens", async ({
  page,
}) => {
  await startInRepo(page);
  await runPaletteCommand(page, "New worktree");
  const dialog = newDialog(page);
  // `main` is checked out in the main worktree.
  await dialog.getByRole("textbox", { name: "Branch", exact: true }).fill("main");
  await dialog.getByRole("button", { name: "Create worktree", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("already used");
  await expect(dialog).toBeVisible();
  await expect(tabs(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("outside a repository the dialog says so and cannot create", async ({ page }) => {
  await seedGitRepos(page, {});
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await run(page, "cd /tmp");
  await expect(cwdOf(tabs(page).first())).toHaveText("/tmp");
  await runPaletteCommand(page, "New worktree");
  const dialog = newDialog(page);
  await expect(dialog.getByRole("alert")).toContainText("not inside a git repository");
  await dialog.getByRole("textbox", { name: "Branch", exact: true }).fill("x");
  await expect(dialog.getByRole("button", { name: "Create worktree", exact: true })).toBeDisabled();
});

test("Remove worktree asks first: Cancel keeps it, Remove deletes it and says so", async ({
  page,
}) => {
  await startInRepo(page);
  await createWorktree(page, "topic");
  await expect(tabs(page)).toHaveCount(2);

  await runPaletteCommand(page, "Remove worktree");
  const dialog = removeDialog(page);
  // Only the linked worktree is on the list, never the main one.
  const list = dialog.getByRole("list", { name: "Worktrees", exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("button", { name: /topic/ })).toBeFocused();
  await list.getByRole("button", { name: /topic/ }).click();

  // The question names the folder, and Cancel (the one with the focus) removes nothing.
  await expect(confirm(page)).toBeVisible();
  await expect(confirm(page).getByText("/work/repo-topic", { exact: true })).toBeVisible();
  await expect(confirm(page).getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await confirm(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm(page)).toBeHidden();
  await expect(list.getByRole("button", { name: /topic/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();

  // It is still there: the dialog lists it again.
  await runPaletteCommand(page, "Remove worktree");
  await expect(
    removeDialog(page).getByRole("list", { name: "Worktrees", exact: true }).getByRole("listitem"),
  ).toHaveCount(1);

  // Now confirm.
  await removeDialog(page).getByRole("button", { name: /topic/ }).click();
  await confirm(page).getByRole("button", { name: "Remove worktree", exact: true }).click();
  await expect(removeDialog(page)).toBeHidden();
  await expect(page.getByText("Worktree removed: /work/repo-topic", { exact: true })).toBeVisible();

  // Nothing is left to remove. The tab that was in the folder stays where it was (its folder is
  // gone), so the first tab, in the repository, is the one the question is asked from.
  await tabs(page).first().click();
  await expect(cwdOf(tabs(page).first())).toHaveText(REPO);
  await runPaletteCommand(page, "Remove worktree");
  await expect(
    removeDialog(page).getByText("This repository has no other worktree."),
  ).toBeVisible();
});

test("a worktree with changes is refused with the message of git and stays", async ({ page }) => {
  await startInRepo(page);
  await createWorktree(page, "dirty");
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setWorktreeDirty("/work/repo-dirty", true),
  );

  await runPaletteCommand(page, "Remove worktree");
  const dialog = removeDialog(page);
  await dialog.getByRole("button", { name: /dirty/ }).click();
  await confirm(page).getByRole("button", { name: "Remove worktree", exact: true }).click();

  // Back to the list with the reason; the worktree is still listed and no force is offered.
  await expect(dialog.getByRole("alert")).toContainText("contains modified or untracked files");
  await expect(dialog.getByRole("button", { name: /dirty/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /force/i })).toHaveCount(0);

  // Once the change is gone the same steps remove it.
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setWorktreeDirty("/work/repo-dirty", false),
  );
  await dialog.getByRole("button", { name: /dirty/ }).click();
  await confirm(page).getByRole("button", { name: "Remove worktree", exact: true }).click();
  await expect(dialog).toBeHidden();
});
