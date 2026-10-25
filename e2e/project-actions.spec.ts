import { expect, test } from "./test";
import type { Page } from "@playwright/test";
import {
  ACTIONS_CWD,
  ACTIONS_TEXT,
  changeActionsFile,
  seedActionsFile,
  seedSidebarState,
} from "./sidebar-fixture";
import { expectNoAxeViolations } from "./axe-fixture";

interface Hook {
  lines(): string[];
  commandRuns(): { cwd: string; command: string }[];
  failCommands(code: number): void;
  actionsReads(): number;
  killedSessions(): number[];
}
type HookWindow = Window & { __norenTest?: Hook };

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const header = (page: Page) => page.getByRole("region", { name: "Projects", exact: true });
/** The state dot of the one-line block of each space (the rows of an open block have their own). */
const runningDots = (page: Page) =>
  header(page).locator('.project-line [data-nr-indicator="running"]');
/** Opens the block of "Main", which then lists its other actions (here "Dev server"). */
const openMain = (page: Page) =>
  header(page).getByRole("button", { name: "Main", exact: true }).click();
const button = (page: Page, name: string) =>
  header(page).getByRole("button", { name, exact: true });
const confirm = (page: Page) =>
  page.getByRole("alertdialog", { name: "Run project action", exact: true });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });

/** The space "Main" has a folder, so its `.noren/actions.json` is read. Ends with the header shown. */
async function openWithActions(page: Page, text: string = ACTIONS_TEXT): Promise<void> {
  await seedSidebarState(page, { cwd: ACTIONS_CWD });
  await seedActionsFile(page, ACTIONS_CWD, text);
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
}

const commandRuns = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.commandRuns() ?? []);

test("a space with a folder and a valid file shows a line with its main action, and the block opens to the others", async ({
  page,
}) => {
  await openWithActions(page);
  await expect(header(page)).toBeVisible();
  await expect(header(page).getByRole("button", { name: "Main", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(button(page, "Start Loop in Main")).toBeVisible();
  await expect(button(page, "Start Dev server in Main")).toHaveCount(0);
  await expect(runningDots(page)).toHaveCount(0);
  await openMain(page);
  await expect(button(page, "Start Dev server in Main")).toBeVisible();
  await expect(button(page, "Start Loop in Main")).toBeVisible();
  // Nothing ran just because the file was read.
  await expect(tab(page, "loop")).toHaveCount(0);
});

test("without a folder the file is never looked up and there is no header", async ({ page }) => {
  // No folder: the file is never looked up.
  await seedSidebarState(page);
  await seedActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
  await expect(header(page)).toHaveCount(0);
});

test("the block stays when another space is on screen, and the space on screen is marked", async ({
  page,
}) => {
  await seedSidebarState(page, { cwd: ACTIONS_CWD, secondSpace: true });
  await seedActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
  await page.goto("/");
  await expect(button(page, "Start Loop in Main")).toBeVisible();

  const mainBlock = header(page).locator('[data-nr-part="project"]');
  await expect(mainBlock).toHaveAttribute("aria-current", "true");

  await page.getByRole("button", { name: "Other", exact: true }).click();
  await expect(tab(page, "elsewhere")).toBeVisible();
  // "Other" has no folder, so no block of its own; the one of "Main" is still there, no longer marked.
  await expect(header(page).locator('[data-nr-part="project"]')).toHaveCount(1);
  await expect(button(page, "Start Loop in Main")).toBeVisible();
  await expect(mainBlock).not.toHaveAttribute("aria-current", "true");

  await page.getByRole("button", { name: "Main", exact: true }).click();
  await expect(mainBlock).toHaveAttribute("aria-current", "true");
});

test("an invalid file shows no header and no error, and the header appears when the file is fixed", async ({
  page,
}) => {
  await openWithActions(page, '{ "actions": [ { "id": "a" } ] }');
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.actionsReads() ?? 0))
    .toBeGreaterThan(0);
  await expect(header(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(tab(page, "api")).toBeVisible();

  await changeActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
  await expect(button(page, "Start Loop in Main")).toBeVisible({ timeout: 8000 });
});

test("a folder with no file shows no header", async ({ page }) => {
  await seedSidebarState(page, { cwd: ACTIONS_CWD });
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
  await expect(header(page)).toHaveCount(0);
});

test("Start asks once: the dialog shows the label and the exact command, confirming opens the named tab and the button turns Stop", async ({
  page,
}) => {
  await openWithActions(page);
  await openMain(page);
  await button(page, "Start Dev server in Main").click();

  const dialog = confirm(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Dev server");
  await expect(dialog.locator("pre")).toHaveText("pnpm dev");
  await expect(tab(page, "dev")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(tab(page, "dev")).toBeVisible();
  await expect(tab(page, "dev")).toHaveAttribute("aria-current", "true");
  await expect(button(page, "Stop Dev server in Main")).toBeVisible();
  await expect(runningDots(page)).toHaveCount(1);
  // The command was typed into the new tab.
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.lines().join("\n") ?? ""))
    .toContain("pnpm dev");
});

test("Cancel runs nothing and the next Start asks again", async ({ page }) => {
  await openWithActions(page);
  await button(page, "Start Loop in Main").click();
  await confirm(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm(page)).toBeHidden();
  await expect(tab(page, "loop")).toHaveCount(0);
  await expect(button(page, "Start Loop in Main")).toBeVisible();

  await button(page, "Start Loop in Main").click();
  await expect(confirm(page)).toBeVisible();
  // Esc cancels too.
  await page.keyboard.press("Escape");
  await expect(confirm(page)).toBeHidden();
  await expect(tab(page, "loop")).toHaveCount(0);
});

test("Stop with a stop command runs it and the button returns to Start; a second Start does not ask again", async ({
  page,
}) => {
  await openWithActions(page);
  await button(page, "Start Loop in Main").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(button(page, "Stop Loop in Main")).toBeVisible();
  await expect(tab(page, "loop")).toBeVisible();

  await button(page, "Stop Loop in Main").click();
  await expect(button(page, "Start Loop in Main")).toBeVisible();
  await expect(runningDots(page)).toHaveCount(0);
  expect(await commandRuns(page)).toEqual([{ cwd: ACTIONS_CWD, command: "loop parar" }]);

  // The shell of the tab ended with the stop, so the next Start opens the tab again, no question.
  await button(page, "Start Loop in Main").click();
  await expect(confirm(page)).toHaveCount(0);
  await expect(button(page, "Stop Loop in Main")).toBeVisible();
  await expect(tab(page, "loop")).toHaveCount(1);
});

test("Stop without a stop command ends the tab's shell and the button returns to Start", async ({
  page,
}) => {
  await openWithActions(page);
  await openMain(page);
  await button(page, "Start Dev server in Main").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(button(page, "Stop Dev server in Main")).toBeVisible();
  // A running action lights the dot of the line, though the main one is not the one running.
  await expect(runningDots(page)).toHaveCount(1);

  await button(page, "Stop Dev server in Main").click();
  await expect(button(page, "Start Dev server in Main")).toBeVisible();
  expect(await commandRuns(page)).toEqual([]);
  expect(
    await page.evaluate(() => (window as HookWindow).__norenTest?.killedSessions().length ?? 0),
  ).toBe(1);
});

test("the context menu of the action tab offers Stop while it runs and Run after it", async ({
  page,
}) => {
  await openWithActions(page);
  // Not an action tab yet: no entry.
  await tab(page, "api").click({ button: "right" });
  await expect(menuItem(page, "Rename")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^(Run|Stop) / })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await button(page, "Start Loop in Main").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(button(page, "Stop Loop in Main")).toBeVisible();

  await tab(page, "loop").click({ button: "right" });
  await menuItem(page, "Stop Loop").click();
  await expect(button(page, "Start Loop in Main")).toBeVisible();

  // Confirmed before, so the menu runs it without asking.
  await tab(page, "loop").click({ button: "right" });
  await menuItem(page, "Run Loop").click();
  await expect(confirm(page)).toHaveCount(0);
  await expect(button(page, "Stop Loop in Main")).toBeVisible();
});

test("the menu entry asks too when the command changed since it was confirmed", async ({
  page,
}) => {
  await openWithActions(page);
  await button(page, "Start Loop in Main").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await button(page, "Stop Loop in Main").click();
  await expect(button(page, "Start Loop in Main")).toBeVisible();

  await changeActionsFile(
    page,
    ACTIONS_CWD,
    JSON.stringify({
      actions: [{ id: "loop", label: "Loop fast", command: "loop --fast", tab: "loop" }],
    }),
  );
  // The new label shows once the file was read again (about 2 seconds).
  await expect(button(page, "Start Loop fast in Main")).toBeVisible({ timeout: 8000 });

  await tab(page, "loop").click({ button: "right" });
  await menuItem(page, "Run Loop fast").click();
  await expect(confirm(page).locator("pre")).toHaveText("loop --fast");
});

test("a changed command asks again", async ({ page }) => {
  await openWithActions(page);
  await button(page, "Start Loop in Main").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await button(page, "Stop Loop in Main").click();
  await expect(button(page, "Start Loop in Main")).toBeVisible();

  await openMain(page);
  await expect(button(page, "Start Dev server in Main")).toBeVisible();
  // The file changes on disk; it is read again within about 2 seconds.
  await changeActionsFile(
    page,
    ACTIONS_CWD,
    JSON.stringify({
      actions: [
        { id: "loop", label: "Loop", command: "loop --fast", stop: "loop parar", tab: "loop" },
      ],
    }),
  );
  await expect(button(page, "Start Dev server in Main")).toHaveCount(0, { timeout: 8000 });
  await expect(header(page)).toContainText("No other actions");
  await button(page, "Start Loop in Main").click();
  await expect(confirm(page).locator("pre")).toHaveText("loop --fast\nloop parar");
});

test("a failing stop command keeps the action running and says why", async ({ page }) => {
  await openWithActions(page);
  await button(page, "Start Loop in Main").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(button(page, "Stop Loop in Main")).toBeVisible();

  await page.evaluate(() => (window as HookWindow).__norenTest?.failCommands(7));
  await button(page, "Stop Loop in Main").click();
  await expect(page.locator('[data-nr-part="pane-notice"]')).toContainText("ended with code 7");
  await expect(button(page, "Stop Loop in Main")).toBeVisible();
});

test("axe: the header of the actions, idle, running and with a failure showing, has no violation", async ({
  page,
}) => {
  await openWithActions(page);
  await expect(button(page, "Start Loop in Main")).toBeVisible();
  await expectNoAxeViolations(page, "project actions header, idle");
  await button(page, "Start Loop in Main").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(button(page, "Stop Loop in Main")).toBeVisible();
  await expect(runningDots(page)).toHaveCount(1);
  await expectNoAxeViolations(page, "project actions header, running");
  await page.evaluate(() => (window as HookWindow).__norenTest?.failCommands(7));
  await button(page, "Stop Loop in Main").click();
  await expect(page.locator('[data-nr-part="pane-notice"]')).toContainText("ended with code 7");
  await expectNoAxeViolations(page, "project actions header, with a notice");
});
