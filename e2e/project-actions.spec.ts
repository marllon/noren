import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  ACTIONS_CWD,
  ACTIONS_TEXT,
  changeActionsFile,
  seedActionsFile,
  seedSidebarState,
} from "./sidebar-fixture";

interface Hook {
  lines(): string[];
  commandRuns(): { cwd: string; command: string }[];
  failCommands(code: number): void;
  actionsReads(): number;
  killedSessions(): number[];
}
type HookWindow = Window & { __norenTest?: Hook };

const list = (page: Page) => page.getByRole("list", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => list(page).getByRole("button", { name, exact: true });
const header = (page: Page) => page.getByRole("region", { name: "Project actions", exact: true });
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

test("a space with a folder and a valid file shows its actions, each with Start and an idle indicator", async ({
  page,
}) => {
  await openWithActions(page);
  await expect(header(page)).toBeVisible();
  await expect(header(page).getByRole("heading", { name: "Main", exact: true })).toBeVisible();
  await expect(button(page, "Start Loop")).toBeVisible();
  await expect(button(page, "Start Dev server")).toBeVisible();
  await expect(header(page).locator('[data-nr-indicator="running"]')).toHaveCount(0);
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

test("the header belongs to the active space only", async ({ page }) => {
  await seedSidebarState(page, { cwd: ACTIONS_CWD, secondSpace: true });
  await seedActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
  await page.goto("/");
  await expect(button(page, "Start Loop")).toBeVisible();

  await page.getByRole("button", { name: "Other", exact: true }).click();
  await expect(tab(page, "elsewhere")).toBeVisible();
  await expect(header(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Main", exact: true }).click();
  await expect(button(page, "Start Loop")).toBeVisible();
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
  await expect(button(page, "Start Loop")).toBeVisible({ timeout: 8000 });
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
  await button(page, "Start Dev server").click();

  const dialog = confirm(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Dev server");
  await expect(dialog.locator("pre")).toHaveText("pnpm dev");
  await expect(tab(page, "dev")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(tab(page, "dev")).toBeVisible();
  await expect(tab(page, "dev")).toHaveAttribute("aria-current", "true");
  await expect(button(page, "Stop Dev server")).toBeVisible();
  await expect(header(page).locator('[data-nr-indicator="running"]')).toHaveCount(1);
  // The command was typed into the new tab.
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.lines().join("\n") ?? ""))
    .toContain("pnpm dev");
});

test("Cancel runs nothing and the next Start asks again", async ({ page }) => {
  await openWithActions(page);
  await button(page, "Start Loop").click();
  await confirm(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm(page)).toBeHidden();
  await expect(tab(page, "loop")).toHaveCount(0);
  await expect(button(page, "Start Loop")).toBeVisible();

  await button(page, "Start Loop").click();
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
  await button(page, "Start Loop").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(button(page, "Stop Loop")).toBeVisible();
  await expect(tab(page, "loop")).toBeVisible();

  await button(page, "Stop Loop").click();
  await expect(button(page, "Start Loop")).toBeVisible();
  await expect(header(page).locator('[data-nr-indicator="running"]')).toHaveCount(0);
  expect(await commandRuns(page)).toEqual([{ cwd: ACTIONS_CWD, command: "loop parar" }]);

  // The shell of the tab ended with the stop, so the next Start opens the tab again, no question.
  await button(page, "Start Loop").click();
  await expect(confirm(page)).toHaveCount(0);
  await expect(button(page, "Stop Loop")).toBeVisible();
  await expect(tab(page, "loop")).toHaveCount(1);
});

test("Stop without a stop command ends the tab's shell and the button returns to Start", async ({
  page,
}) => {
  await openWithActions(page);
  await button(page, "Start Dev server").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(button(page, "Stop Dev server")).toBeVisible();

  await button(page, "Stop Dev server").click();
  await expect(button(page, "Start Dev server")).toBeVisible();
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

  await button(page, "Start Loop").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(button(page, "Stop Loop")).toBeVisible();

  await tab(page, "loop").click({ button: "right" });
  await menuItem(page, "Stop Loop").click();
  await expect(button(page, "Start Loop")).toBeVisible();

  // Confirmed before, so the menu runs it without asking.
  await tab(page, "loop").click({ button: "right" });
  await menuItem(page, "Run Loop").click();
  await expect(confirm(page)).toHaveCount(0);
  await expect(button(page, "Stop Loop")).toBeVisible();
});

test("the menu entry asks too when the command changed since it was confirmed", async ({
  page,
}) => {
  await openWithActions(page);
  await button(page, "Start Loop").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await button(page, "Stop Loop").click();
  await expect(button(page, "Start Loop")).toBeVisible();

  await changeActionsFile(
    page,
    ACTIONS_CWD,
    JSON.stringify({
      actions: [{ id: "loop", label: "Loop fast", command: "loop --fast", tab: "loop" }],
    }),
  );
  // The new label shows once the file was read again (about 2 seconds).
  await expect(button(page, "Start Loop fast")).toBeVisible({ timeout: 8000 });

  await tab(page, "loop").click({ button: "right" });
  await menuItem(page, "Run Loop fast").click();
  await expect(confirm(page).locator("pre")).toHaveText("loop --fast");
});

test("a changed command asks again", async ({ page }) => {
  await openWithActions(page);
  await button(page, "Start Loop").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await button(page, "Stop Loop").click();
  await expect(button(page, "Start Loop")).toBeVisible();

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
  await expect(button(page, "Start Dev server")).toHaveCount(0, { timeout: 8000 });
  await button(page, "Start Loop").click();
  await expect(confirm(page).locator("pre")).toHaveText("loop --fast\nloop parar");
});

test("a failing stop command keeps the action running and says why", async ({ page }) => {
  await openWithActions(page);
  await button(page, "Start Loop").click();
  await confirm(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(button(page, "Stop Loop")).toBeVisible();

  await page.evaluate(() => (window as HookWindow).__norenTest?.failCommands(7));
  await button(page, "Stop Loop").click();
  await expect(page.locator('[data-nr-part="pane-notice"]')).toContainText("ended with code 7");
  await expect(button(page, "Stop Loop")).toBeVisible();
});
