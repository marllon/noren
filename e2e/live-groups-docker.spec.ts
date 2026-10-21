import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";

// The live group of running containers (NOR-F17-04d): "New group of running containers" in the
// palette makes a group whose entries are the containers `docker ps` lists. In web mode the fake
// backend answers with its fixture containers (web-app, postgres-db, redis_cache) or what a test
// says through the test hook; `docker` is never run.

type Hook = { setDockerContainers(containers: string[], error?: string): void };
type HookWindow = Window & { __norenTest?: Hook };

const tree = (page: Page): Locator => page.getByRole("tree", { name: "Tabs", exact: true });
const tabs = (page: Page): Locator => tree(page).locator('[data-nr-part="item"]');
const entries = (page: Page): Locator => tree(page).locator('[data-nr-part="live-entry"]');
const groups = (page: Page): Locator => tree(page).locator('[data-nr-part="group"]');
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');

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

test("the command makes a live group whose entries are the running containers", async ({
  page,
}) => {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await expect(groups(page)).toHaveCount(0);
  await runFromPalette(page, "New group of running containers");

  await expect(groups(page).first()).toContainText("Running containers");
  await expect(entries(page)).toHaveCount(3);
  await expect(entries(page).locator('[data-nr-part="live-entry-label"]')).toHaveText([
    "web-app",
    "postgres-db",
    "redis_cache",
  ]);
  // The entries are not tabs.
  await expect(tabs(page)).toHaveCount(1);
});

test("clicking a container opens one tab of the group and types docker exec -it <name> sh in it", async ({
  page,
}) => {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await runFromPalette(page, "New group of running containers");
  await expect(entries(page)).toHaveCount(3);

  await tree(page).getByRole("treeitem", { name: "postgres-db", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(groups(page).first().locator('[data-nr-part="group-count"]')).toHaveText("1");
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  // The command was typed into the shell of the new tab (the fake shell echoes what it is given).
  await expect(
    page
      .locator('[data-nr-part="item-command"]')
      .filter({ hasText: "docker exec -it postgres-db sh" }),
  ).toHaveCount(1);

  // A second click shows the tab again and makes no other.
  await tabs(page).first().click();
  await tree(page).getByRole("treeitem", { name: "postgres-db", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
});

test("with Docker missing the group is empty and says why", async ({ page }) => {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setDockerContainers([], "docker not found"),
  );
  await runFromPalette(page, "New group of running containers");
  await expect(groups(page).first()).toContainText("Running containers");
  await expect(entries(page)).toHaveCount(0);
  await expect(tree(page).locator('[data-nr-part="live-error"]')).toContainText(
    "Could not update: docker not found",
  );
  await expect(tabs(page)).toHaveCount(1);
});

test("axe: a group of containers has no violation", async ({ page }) => {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeAttached();
  await runFromPalette(page, "New group of running containers");
  await expect(entries(page)).toHaveCount(3);
  await expectNoAxeViolations(page, "live group of containers");
});

test("axe: a group that says why it is empty has no violation", async ({ page }) => {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeAttached();
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setDockerContainers([], "docker not found"),
  );
  await runFromPalette(page, "New group of running containers");
  await expect(tree(page).locator('[data-nr-part="live-error"]')).toContainText(
    "Could not update: docker not found",
  );
  await expectNoAxeViolations(page, "live group of containers, with an error");
});
