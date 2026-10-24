import { expect, test } from "./test";
import type { Page } from "@playwright/test";
import { start } from "./glass-sidebar-fixture";
import type { StartOptions } from "./glass-sidebar-fixture";
import { SPLIT_FIXTURE } from "./sidebar-fixture";

// Baselines are per operating system (Windows only, D7): `pnpm e2e:visual`.
// The main window of the dense style (NOR-F20-21a): the whole page with the title bar, the bar of the
// favorites and the actions, the sidebar with its spaces, tabs, agents and settings, the split tab with a
// command that runs and an agent that waits, and the status bar; in the dark theme, the light one in
// Portuguese, with the tabs on top, in a narrow window, and the sidebar alone with names far too long. The
// time an agent has waited is masked: it is the one thing on the page that is not the same twice.

const REPOS = { "/srv/api": "main", "/srv/web": "feat/login-form" };

type HookWindow = Window & {
  __norenTest?: { sendOutput(paneId: string, text: string): boolean };
};

/** Opens the split tab with a command running on the left and the agent waiting on the right. */
async function open(page: Page, options: StartOptions): Promise<void> {
  await start(page, {
    style: "dense",
    repos: REPOS,
    bar: true,
    agents: [[SPLIT_FIXTURE.second, "shall i continue"]],
    ...options,
  });
  await page
    .getByRole("treeitem", { name: SPLIT_FIXTURE.title, exact: true })
    .or(page.getByRole("tab", { name: SPLIT_FIXTURE.title, exact: true }))
    .first()
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
  ).toContainText("pnpm dev");
  await expect(page.locator('[data-nr-part="pane-agent-badge"]')).toHaveCount(1);
  // Nothing hovered or focused, the list of tabs at its top and every animation at its end, and the
  // pointer away: the capture is of the window, not of the mouse.
  await page.evaluate(async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const list = document.querySelector(".tab-list");
    if (list !== null) list.scrollTop = 0;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.mouse.move(2, 2);
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

const options = (page: Page) => ({
  animations: "disabled" as const,
  caret: "hide" as const,
  mask: [page.locator(".sidebar-agent-state")],
});

for (const scheme of ["dark", "light"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test(`@visual the dense window: the bars, the sidebar, the panes with their headers, the status bar (${scheme})`, async ({
      page,
    }) => {
      await open(page, { mode: scheme });
      await expect(page).toHaveScreenshot(`dense-window-${scheme}.png`, options(page));
    });
  });
}

test.describe("light scheme in Portuguese", () => {
  test.use({ colorScheme: "light" });

  test("@visual the dense window in Portuguese (light)", async ({ page }) => {
    await open(page, { mode: "light", lang: "pt-BR" });
    await expect(page).toHaveScreenshot("dense-window-ptbr-light.png", options(page));
  });
});

test.describe("the other ways of laying it out", () => {
  test.use({ colorScheme: "dark" });

  test("@visual the dense window with the tabs on top (dark)", async ({ page }) => {
    await open(page, { mode: "dark", appearance: '"tabs": "top"' });
    await expect(page).toHaveScreenshot("dense-window-top-tabs-dark.png", options(page));
  });

  test("@visual the dense window in a narrow window: the bars wrap, the panes give way (dark)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 760, height: 560 });
    await open(page, { mode: "dark" });
    await expect(page).toHaveScreenshot("dense-window-narrow-dark.png", options(page));
  });

  test("@visual the dense sidebar of 200 px with names far too long: every one is cut inside its row (dark)", async ({
    page,
  }) => {
    await open(page, { mode: "dark", longNames: true });
    await expect(page.locator('[data-nr-part="sidebar"]')).toHaveScreenshot(
      "dense-sidebar-long-names-dark.png",
      options(page),
    );
  });
});
