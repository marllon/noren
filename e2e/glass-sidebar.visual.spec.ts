import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { AGENT_STATES, start } from "./glass-sidebar-fixture";
import type { StartOptions } from "./glass-sidebar-fixture";

// Baselines are per operating system (Windows only, D7): `pnpm e2e:visual`.
// The content of the glass sidebar (NOR-F20-18b): the brand and the button that folds it, the search with
// the keycap, the favorites as a grid of four with a dot on the tiles that wait and work, the card of the
// project actions, the tabs with their dots and the second line (folder and branch), New tab and the foot
// with the spaces and the settings. The capture is of the sidebar card over the backdrop, with the agents
// of the fixture working (api, scratch) and waiting (deploy), in the dark theme and the light one.

const sidebar = (page: Page) => page.locator('[data-nr-part="sidebar"]');

/** Starts the page, waits for the dots of the agents, and puts the pointer and the focus away. */
async function open(page: Page, options: StartOptions): Promise<void> {
  await start(page, { bar: true, agents: AGENT_STATES, ...options });
  await expect(
    sidebar(page).locator('[data-nr-part="item-dot"][data-nr-dot="waiting"]'),
  ).toHaveCount(1);
  await expect(page.locator('[data-nr-part="favorite-dot"]')).toHaveCount(2);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(900, 500);
}

for (const scheme of ["dark", "light"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test(`@visual the glass sidebar with the bar, the dots, the card of the actions and the tabs (${scheme})`, async ({
      page,
    }) => {
      await open(page, { mode: scheme });
      await expect(sidebar(page)).toHaveScreenshot(`glass-sidebar-${scheme}.png`, {
        animations: "disabled",
        caret: "hide",
      });
    });
  });
}

test.describe("wide sidebar and Portuguese", () => {
  test.use({ colorScheme: "dark" });

  test("@visual the glass sidebar 320 px wide: the sentence of the search, the actions side by side (dark)", async ({
    page,
  }) => {
    await open(page, { mode: "dark", appearance: '"sidebar": { "width": 320 }' });
    await expect(sidebar(page)).toHaveScreenshot("glass-sidebar-wide-dark.png", {
      animations: "disabled",
      caret: "hide",
    });
  });
});

test.describe("light scheme in Portuguese", () => {
  test.use({ colorScheme: "light" });

  test("@visual the glass sidebar in Portuguese (light)", async ({ page }) => {
    await open(page, { mode: "light", lang: "pt-BR" });
    await expect(sidebar(page)).toHaveScreenshot("glass-sidebar-ptbr-light.png", {
      animations: "disabled",
      caret: "hide",
    });
  });
});
