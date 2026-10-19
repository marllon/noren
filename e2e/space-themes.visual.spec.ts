import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedSidebarState } from "./sidebar-fixture";

// The window with the theme of a space, in three themes: Noren Dusk, Noren Paper and one of the
// ports (Noren Fjord). The theme is given to the active space in its menu, so this also holds the
// path from the menu to the colors. Baselines are per operating system (Windows only, D7):
// `pnpm e2e:visual`.

const THEMES = [
  { id: "dusk", name: "Noren Dusk" },
  { id: "paper", name: "Noren Paper" },
  { id: "fjord", name: "Noren Fjord" },
] as const;

const tab = (page: Page, name: string) =>
  page.getByRole("list", { name: "Tabs", exact: true }).getByRole("button", { name, exact: true });

test.use({ colorScheme: "dark" });

for (const theme of THEMES) {
  test(`@visual window with the theme of the space: ${theme.name}`, async ({ page }) => {
    await seedSidebarState(page);
    await page.goto("/");
    await expect(tab(page, "api")).toBeVisible();

    await page
      .getByRole("navigation", { name: "Spaces", exact: true })
      .getByRole("button", { name: "Main", exact: true })
      .click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Main options", exact: true });
    await menu.getByRole("menuitemradio", { name: theme.name, exact: true }).click();
    await expect(menu).toBeHidden();

    // A fixed state: nothing hovered or focused.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.mouse.move(900, 500);

    // The terminal is never part of a screenshot: its layers are hidden and the area stays empty.
    await page.addStyleTag({ content: ".space-layer { visibility: hidden; }" });
    await expect(page.locator(".app-body")).toHaveScreenshot(`space-theme-${theme.id}.png`, {
      animations: "disabled",
      caret: "hide",
    });
  });
}
