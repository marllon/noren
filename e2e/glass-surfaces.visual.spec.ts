import { expect, test } from "./test";
import { seedConfig } from "./settings-fixture";
import { SPLIT_FIXTURE, seedSidebarState } from "./sidebar-fixture";

// Baselines are per operating system (Windows only, D7): `pnpm e2e:visual`.
// The glass window (NOR-F20-18a): the illustrated backdrop behind the cards, the sidebar and the panes as
// cards of glass with the gap between them, in the dark theme and in the light one, and a tab split into
// two panes. The terminal is never part of a screenshot (its layers are hidden: what it draws is a font and
// a cursor, not a surface), so the glass over the backdrop is what the picture holds.

for (const scheme of ["dark", "light"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test(`@visual the glass window: backdrop, sidebar and panes (${scheme})`, async ({ page }) => {
      await seedSidebarState(page);
      await seedConfig(
        page,
        JSON.stringify({ appearance: { theme: `noren-${scheme === "dark" ? "dusk" : "paper"}` } }),
      );
      await page.goto("/");
      await expect(page.getByRole("tree", { name: "Tabs", exact: true })).toBeVisible();
      await page.addStyleTag({ content: ".space-layer .terminal-view { visibility: hidden; }" });
      await expect(page).toHaveScreenshot(`glass-window-${scheme}.png`, {
        animations: "disabled",
        caret: "hide",
      });
    });
  });
}

test.describe("dark scheme", () => {
  test.use({ colorScheme: "dark" });

  test("@visual the glass window with a tab split into two panes (dark)", async ({ page }) => {
    await seedSidebarState(page, { split: true });
    await seedConfig(page, JSON.stringify({ appearance: { theme: "noren-dusk" } }));
    await page.goto("/");
    await page
      .getByRole("tree", { name: "Tabs", exact: true })
      .getByRole("treeitem", { name: SPLIT_FIXTURE.title, exact: true })
      .click();
    await expect(page.locator(`[data-pane-id="${SPLIT_FIXTURE.second}"]`)).toBeVisible();
    // The rows of the glass sidebar are taller (NOR-F20-18b), so the list of tabs overflows in this
    // window, and where the click on a tab leaves it scrolled depends on the frame the pane list
    // opened in; the picture is of the glass and the split panes, so the list is put at its top.
    await page
      .getByRole("tree", { name: "Tabs", exact: true })
      .evaluate((list) => void (list.scrollTop = 0));
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
    await page.addStyleTag({ content: ".space-layer .terminal-view { visibility: hidden; }" });
    await expect(page).toHaveScreenshot("glass-split-dark.png", {
      animations: "disabled",
      caret: "hide",
    });
  });
});
