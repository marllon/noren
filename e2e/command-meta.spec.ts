import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { numberTheTabs } from "./numbered-tabs";

// The shell of a pane reports each command (OSC 633;E for the line, 133;C when it starts, 133;D with
// the exit code when it ends). The sidebar shows the command that runs now and the last one that
// ended, and a tab nobody named takes its title from the running program, else from its folder.
// The fake shell of web mode runs on a clock the page moves (`advanceClock`), so `sleep N` ends
// when the test says and the duration is exactly what the test moved.

interface Hook {
  advanceClock(ms: number): void;
  split(dir: "row" | "column", paneId?: string): string | undefined;
}
type HookWindow = Window & { __norenTest?: Hook };

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
/** The one tab of the page: its title changes with the shell, so it cannot be found by name. */
const tab = (page: Page): Locator => list(page).locator('[data-nr-part="item"]');
const title = (page: Page): Locator => tab(page).locator('[data-nr-part="item-title"]');
const command = (page: Page): Locator => tab(page).locator('[data-nr-part="item-command"]');
const part = (page: Page, name: string): Locator =>
  command(page).locator(`[data-nr-part="item-command-${name}"]`);

async function run(page: Page, line: string): Promise<void> {
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

function advance(page: Page, ms: number): Promise<void> {
  return page.evaluate((by) => (window as HookWindow).__norenTest?.advanceClock(by), ms);
}

test("a command shows as running, then as the last command with its exit code and duration", async ({
  page,
}) => {
  await page.goto("/");
  await expect(title(page)).toHaveText("~");
  // Nothing ran yet: there is no command line.
  await expect(command(page)).toHaveCount(0);

  await run(page, "sleep 3");
  await expect(command(page)).toHaveAttribute("data-nr-state", "running");
  await expect(part(page, "text")).toHaveText("sleep 3");
  await expect(part(page, "code")).toHaveText("running");
  await expect(tab(page).locator('[data-nr-indicator="running"]')).toHaveCount(1);

  await advance(page, 3000);
  await expect(command(page)).toHaveAttribute("data-nr-state", "done");
  await expect(part(page, "text")).toHaveText("sleep 3");
  await expect(part(page, "code")).toHaveText("exit 0");
  await expect(part(page, "time")).toHaveText("3.0s");
  await expect(tab(page).locator('[data-nr-indicator="running"]')).toHaveCount(0);
});

test("a command that fails shows its non-zero exit code, and the next command replaces it", async ({
  page,
}) => {
  await page.goto("/");
  await run(page, "false");
  await expect(command(page)).toHaveAttribute("data-nr-state", "failed");
  await expect(part(page, "text")).toHaveText("false");
  await expect(part(page, "code")).toHaveText("exit 1");
  await expect(part(page, "time")).toHaveText("<1s");

  await run(page, "nosuchthing --flag");
  await expect(part(page, "text")).toHaveText("nosuchthing --flag");
  await expect(part(page, "code")).toHaveText("exit 127");

  await run(page, "true");
  await expect(command(page)).toHaveAttribute("data-nr-state", "done");
  await expect(part(page, "text")).toHaveText("true");
  await expect(part(page, "code")).toHaveText("exit 0");
});

test("the words read by assistive technology follow the command", async ({ page }) => {
  await page.goto("/");
  await run(page, "sleep 5");
  const describe = async () => {
    const id = await tab(page).getAttribute("aria-describedby");
    expect(id).not.toBeNull();
    return page.locator(`#${id ?? ""}`);
  };
  await expect(await describe()).toContainText("Running sleep 5");
  await advance(page, 5000);
  await expect(await describe()).toContainText("Last command sleep 5, exit 0, 5.0s");
});

test("the tab is named after the folder from the first one the shell reports, and the command after it", async ({
  page,
}) => {
  await page.goto("/");
  // The first folder is the one the shell started in (the home folder of the fake one): the tab is
  // named after it at once, though the pane does not keep it as its own folder.
  await expect(title(page)).toHaveText("~");

  await run(page, "sleep 2");
  await expect(title(page)).toHaveText("~ · sleep");
  await advance(page, 2000);
  await expect(title(page)).toHaveText("~");

  await run(page, "cd /srv/api");
  await expect(title(page)).toHaveText("api");
  await run(page, "sleep 1");
  await expect(title(page)).toHaveText("api · sleep");
  await advance(page, 1000);
  await expect(title(page)).toHaveText("api");

  await run(page, "cd ~");
  await expect(title(page)).toHaveText("~");
});

test("a tab of a shell that tells no folder keeps its number, and its command is the name while it runs", async ({
  page,
}) => {
  await numberTheTabs({ page });
  await page.goto("/");
  await expect(title(page)).toHaveText("Tab 1");

  await run(page, "sleep 2");
  await expect(title(page)).toHaveText("sleep");
  await advance(page, 2000);
  await expect(title(page)).toHaveText("Tab 1");
});

test("a title the user chose does not change, though the command still shows", async ({ page }) => {
  await page.goto("/");
  await tab(page).dblclick();
  const field = page.getByRole("textbox", { name: "Tab name", exact: true });
  await field.fill("mine");
  await field.press("Enter");
  await expect(title(page)).toHaveText("mine");
  // Enter gives the keyboard back to the row a frame later; typing into the terminal before that
  // would lose the focus to the row halfway through the line.
  await expect(tab(page)).toBeFocused();

  await run(page, "cd /srv/api");
  await expect(part(page, "text")).toHaveText("cd /srv/api");
  await run(page, "sleep 2");
  await expect(part(page, "text")).toHaveText("sleep 2");
  await expect(command(page)).toHaveAttribute("data-nr-state", "running");
  await expect(title(page)).toHaveText("mine");
  await advance(page, 2000);
  await expect(command(page)).toHaveAttribute("data-nr-state", "done");
  await expect(title(page)).toHaveText("mine");

  // Clearing the name hands the title back to the shell.
  await tab(page).dblclick();
  await field.fill("");
  await field.press("Enter");
  await expect(title(page)).toHaveText("api");
});

test("each pane of a split tab shows its own command", async ({ page }) => {
  await page.goto("/");
  await run(page, "echo first");
  await expect(part(page, "text")).toHaveText("echo first");

  const second = await page.evaluate(() => (window as HookWindow).__norenTest?.split("row"));
  expect(second).toBeDefined();
  const panes = list(page).locator('[data-nr-part="item-pane"]');
  await expect(panes).toHaveCount(2);
  // The new pane has the keyboard and has run nothing.
  await page.keyboard.type("false");
  await page.keyboard.press("Enter");
  const lines = panes.locator('[data-nr-part="item-pane-command"]');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText("echo first");
  await expect(lines.nth(0)).toContainText("exit 0");
  await expect(lines.nth(1)).toContainText("false");
  await expect(lines.nth(1)).toContainText("exit 1");
  await expect(lines.nth(1)).toHaveAttribute("data-nr-state", "failed");
});

test("the last command is saved with the tab and is back after a reload", async ({ page }) => {
  await page.goto("/");
  await run(page, "false");
  await expect(part(page, "code")).toHaveText("exit 1");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const text = window.localStorage.getItem("noren.web.state") ?? "";
        return text.includes('"lastCommand"') && text.includes('"exitCode":1');
      }),
    )
    .toBe(true);

  await page.reload();
  await expect(title(page)).toBeVisible();
  await expect(part(page, "text")).toHaveText("false");
  await expect(part(page, "code")).toHaveText("exit 1");
  // The shell that ran it is gone, so nothing shows as running.
  await expect(tab(page).locator('[data-nr-indicator="running"]')).toHaveCount(0);
});
