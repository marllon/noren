import { expect, test } from "@playwright/test";
import { seedConfig } from "./settings-fixture";
import { seedSidebarState } from "./sidebar-fixture";

// Baselines are per operating system (Windows only, D7): `pnpm e2e:visual`.

for (const scheme of ["dark", "light"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test(`@visual compact mode with the sidebar revealed over the terminal (${scheme})`, async ({
      page,
    }) => {
      await seedSidebarState(page);
      await seedConfig(
        page,
        JSON.stringify({
          appearance: {
            sidebar: { compact: true, width: 240, position: "left" },
            density: "comfortable",
          },
        }),
      );
      await page.goto("/");

      const sidebar = page.locator('[data-nr-part="sidebar"]');
      await expect(sidebar).toHaveAttribute("data-nr-state", "hidden");
      // Low in the sidebar, where no row is under the pointer.
      await page.mouse.move(2, 560);
      await expect(sidebar).toHaveAttribute("data-nr-state", "revealed");
      await expect(page.getByRole("tree", { name: "Tabs", exact: true })).toBeVisible();

      // The terminal is never part of a screenshot: its layers are hidden (the area stays empty,
      // since the terminal takes the whole width) and the sidebar shows over it.
      await page.addStyleTag({ content: ".space-layer { visibility: hidden; }" });
      await expect(page.locator(".app-body")).toHaveScreenshot(`compact-revealed-${scheme}.png`, {
        animations: "disabled",
        caret: "hide",
      });
    });
  });
}
