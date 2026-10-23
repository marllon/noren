import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { start } from "./glass-sidebar-fixture";
import type { StartOptions } from "./glass-sidebar-fixture";
import { SPLIT_FIXTURE } from "./sidebar-fixture";

// Baselines are per operating system (Windows only, D7): `pnpm e2e:visual`.
// The pane of the glass style (NOR-F20-18c): the split tab of the fixture, the pane on the left in focus
// (the ring in the color of the space) with its folder, its branch and a command that runs, and the pane
// on the right with its own folder and branch and an agent that waits for you (the amber ring and the
// badge). The capture is of the area of the tab over the backdrop, in the dark theme, the light one and in
// Portuguese.

const REPOS = { "/srv/api": "main", "/srv/web": "feat/login-form" };

type HookWindow = Window & {
  __norenTest?: { sendOutput(paneId: string, text: string): boolean };
};

/** Opens the split tab with a command running on the left and the agent waiting on the right. */
async function open(page: Page, options: StartOptions): Promise<void> {
  await start(page, {
    repos: REPOS,
    agents: [[SPLIT_FIXTURE.second, "shall i continue"]],
    ...options,
  });
  await page
    .getByRole("tree", { name: /^(Tabs|Abas)$/ })
    .getByRole("treeitem", { name: SPLIT_FIXTURE.title, exact: true })
    .click();
  await page.evaluate(
    (id) =>
      (window as HookWindow).__norenTest?.sendOutput(
        id,
        "\x1b]633;E;pnpm dev\x07\x1b]133;C\x07> site-api dev\r\n",
      ),
    SPLIT_FIXTURE.first,
  );
  await expect(
    page.locator(`[data-pane-id="${SPLIT_FIXTURE.first}"] [data-nr-part="pane-command"]`),
  ).toHaveText(/pnpm dev/);
  await expect(page.locator('[data-nr-part="pane-agent-badge"]')).toHaveCount(1);
  // Nothing hovered or focused, and the pointer away: the capture is of the panes, not of the mouse.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(2, 2);
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

const area = (page: Page) => page.locator('[data-nr-part="item-view"]:visible');

for (const scheme of ["dark", "light"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test(`@visual the glass panes: the header with folder, branch and command, the ring, the badge (${scheme})`, async ({
      page,
    }) => {
      await open(page, { mode: scheme });
      await expect(area(page)).toHaveScreenshot(`glass-panes-${scheme}.png`, {
        animations: "disabled",
        caret: "hide",
      });
    });
  });
}

test.describe("light scheme in Portuguese", () => {
  test.use({ colorScheme: "light" });

  test("@visual the glass panes in Portuguese (light)", async ({ page }) => {
    await open(page, { mode: "light", lang: "pt-BR" });
    await expect(area(page)).toHaveScreenshot("glass-panes-ptbr-light.png", {
      animations: "disabled",
      caret: "hide",
    });
  });
});

test.describe("a narrow pane", () => {
  test.use({ colorScheme: "dark" });

  test("@visual a split of three where one pane is 190 px wide: the chips give way, the badge keeps its icon (dark)", async ({
    page,
  }) => {
    await open(page, { mode: "dark", appearance: '"sidebar": { "width": 480 }' });
    await page
      .locator(`[data-pane-id="${SPLIT_FIXTURE.second}"]`)
      .getByRole("button", { name: "Split right", exact: true })
      .click();
    await expect(page.locator('[data-nr-part="pane-bar"]:visible')).toHaveCount(3);
    await page.mouse.move(2, 2);
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await expect(area(page)).toHaveScreenshot("glass-panes-narrow-dark.png", {
      animations: "disabled",
      caret: "hide",
    });
  });
});
