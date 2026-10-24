import { expect, test } from "./test";
import { seedConfig } from "./settings-fixture";
import { seedSidebarState } from "./sidebar-fixture";

// Baselines are per operating system (Windows only, D7): `pnpm e2e:visual`.

for (const scheme of ["dark", "light"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test(`@visual top tabs: the bar with a group island above the terminal (${scheme})`, async ({
      page,
    }) => {
      await seedSidebarState(page);
      await seedConfig(page, JSON.stringify({ appearance: { tabs: "top" } }));
      await page.goto("/");

      const bar = page.locator('[data-nr-part="tabbar"]');
      await expect(bar).toBeVisible();
      await expect(page.locator('[data-nr-part="sidebar"]')).toHaveAttribute(
        "data-nr-state",
        "hidden",
      );
      await expect(bar.getByRole("tab", { name: "api", exact: true })).toHaveAttribute(
        "aria-current",
        "true",
      );

      // The terminal is never part of a screenshot: its layers are hidden and the area stays empty.
      await page.addStyleTag({ content: ".space-layer { visibility: hidden; }" });
      await expect(page.locator(".app-body")).toHaveScreenshot(`top-tabs-${scheme}.png`, {
        animations: "disabled",
        caret: "hide",
      });
    });
  });
}
