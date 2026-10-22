import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";
import { ACTIONS_CWD, ACTIONS_TEXT, seedActionsFile, seedSidebarState } from "./sidebar-fixture";

// Baselines are per operating system (Windows only, D7): `pnpm e2e:visual`. The favorites bar at the
// top of the window (`appearance.favorites` "top"), with the three kinds of tile: next to a docked
// sidebar, and under the tab bar with the tabs on top (the sidebar hidden).

const WEB_STATE_KEY = "noren.web.state";

async function start(page: Page, appearance: Record<string, unknown>): Promise<void> {
  await seedSidebarState(page, { cwd: ACTIONS_CWD });
  await seedActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
  await seedConfig(page, JSON.stringify({ appearance: { favorites: "top", ...appearance } }));
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      "noren.web.profiles",
      JSON.stringify([{ id: "pwsh", name: "PowerShell", default: true }]),
    );
    const state = JSON.parse(window.localStorage.getItem(key) ?? "{}") as {
      favorites?: string[];
      favoriteLinks?: object[];
    };
    state.favorites = ["i6", "i5"];
    state.favoriteLinks = [
      { kind: "profile", profileId: "pwsh", label: "PowerShell" },
      { kind: "action", spaceId: "s1", actionId: "dev", label: "Dev server" },
    ];
    window.localStorage.setItem(key, JSON.stringify(state));
  }, WEB_STATE_KEY);
  await page.goto("/");
  const bar = page.locator('[data-nr-part="favorites"]');
  await expect(bar).toHaveAttribute("data-nr-placement", "top");
  await expect(bar.locator('[data-nr-part="favorite"]')).toHaveCount(4);
  // The action tile is drawn as available once the file of its space has been read.
  await expect(bar.locator('[data-nr-kind="action"]')).not.toHaveAttribute(
    "data-nr-state",
    "unavailable",
  );
}

for (const scheme of ["dark", "light"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test(`@visual favorites bar on top of the window next to the sidebar (${scheme})`, async ({
      page,
    }) => {
      await start(page, {});
      // The terminal is never part of a screenshot: its layers are hidden and the area stays empty.
      await page.addStyleTag({ content: ".space-layer { visibility: hidden; }" });
      await expect(page.locator(".app-body")).toHaveScreenshot(`favorites-top-${scheme}.png`, {
        animations: "disabled",
        caret: "hide",
      });
    });

    test(`@visual favorites bar on top under the tab bar (${scheme})`, async ({ page }) => {
      await start(page, { tabs: "top" });
      await expect(page.locator('[data-nr-part="sidebar"]')).toHaveAttribute(
        "data-nr-state",
        "hidden",
      );
      await page.addStyleTag({ content: ".space-layer { visibility: hidden; }" });
      await expect(page.locator(".app-body")).toHaveScreenshot(
        `favorites-top-tab-bar-${scheme}.png`,
        { animations: "disabled", caret: "hide" },
      );
    });
  });
}
