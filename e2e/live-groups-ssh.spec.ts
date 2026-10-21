import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// The live group of SSH hosts (NOR-F17-04c): "New group of SSH hosts" in the palette makes a group
// whose entries are the hosts of the ~/.ssh/config. In web mode the fake backend answers with its
// fixture hosts (web-1, db.internal, build_box); the config of the machine is never read.

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

test("the command makes a live group whose entries are the SSH hosts", async ({ page }) => {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await expect(groups(page)).toHaveCount(0);
  await runFromPalette(page, "New group of SSH hosts");

  await expect(groups(page).first()).toContainText("SSH hosts");
  await expect(entries(page)).toHaveCount(3);
  await expect(entries(page).locator('[data-nr-part="live-entry-label"]')).toHaveText([
    "web-1",
    "db.internal",
    "build_box",
  ]);
  // The entries are not tabs.
  await expect(tabs(page)).toHaveCount(1);
});

test("clicking a host opens one tab of the group and types ssh <host> in it", async ({ page }) => {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await runFromPalette(page, "New group of SSH hosts");
  await expect(entries(page)).toHaveCount(3);

  await tree(page).getByRole("treeitem", { name: "db.internal", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(groups(page).first().locator('[data-nr-part="group-count"]')).toHaveText("1");
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  // The command was typed into the shell of the new tab (the fake shell echoes what it is given).
  await expect(
    page.locator('[data-nr-part="item-command"]').filter({ hasText: "ssh db.internal" }),
  ).toHaveCount(1);

  // A second click shows the tab again and makes no other.
  await tabs(page).first().click();
  await tree(page).getByRole("treeitem", { name: "db.internal", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
});
