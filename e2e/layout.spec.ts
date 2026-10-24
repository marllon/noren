import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { afterAnimations } from "./frames";
import { seedSidebarState } from "./sidebar-fixture";
import {
  DENSE_CONFIG,
  changeSettings,
  configText,
  openSettings,
  closeSettings,
  seedConfig,
  settingsScreen,
} from "./settings-fixture";

// The layout preferences (side, width, density, compact mode) are settings of `config.jsonc`,
// chosen in the settings screen; a new test context starts with no file, which is every default. They are
// about the sidebar flush with the edges of the window, so they start from the dense style: the glass
// style keeps a gap around its cards (glass-surfaces.spec.ts measures that one).

const sidebar = (page: Page) => page.locator('[data-nr-part="sidebar"]');
const content = (page: Page) => page.getByRole("region", { name: "Content", exact: true });
const handle = (page: Page) => page.getByRole("separator", { name: "Resize sidebar", exact: true });
const tab = (page: Page, name: string) =>
  page
    .getByRole("tree", { name: "Tabs", exact: true })
    .getByRole("treeitem", { name, exact: true });
const radio = (screen: Locator, name: string) => screen.getByRole("radio", { name, exact: true });
const checkbox = (screen: Locator, name: string) =>
  screen.getByRole("switch", { name, exact: true });

/** Box of an element on screen; fails the test when it is not rendered. */
async function box(locator: ReturnType<typeof sidebar>) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("element not on screen");
  return found;
}

/** Waits for the sidebar to stop moving, since a change of mode or side slides it. */
async function settled(page: Page): Promise<void> {
  await afterAnimations(page);
}

/** Changes settings in the screen, saves them and waits for the sidebar to settle. */
async function change(page: Page, edit: (screen: Locator) => Promise<void>): Promise<void> {
  await changeSettings(page, edit);
  await settled(page);
}

/** Drags the resize handle by `dx` pixels with the mouse. */
async function dragHandle(page: Page, dx: number): Promise<void> {
  const at = await box(handle(page));
  const x = at.x + at.width / 2;
  const y = at.y + at.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 5 });
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await seedConfig(page, DENSE_CONFIG);
  await seedSidebarState(page);
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
});

test("the sidebar starts on the left, 200 px wide, and the handle describes it", async ({
  page,
}) => {
  const side = await box(sidebar(page));
  const main = await box(content(page));
  expect(side.x).toBe(0);
  expect(side.width).toBe(200);
  expect(main.x).toBeGreaterThanOrEqual(side.x + side.width);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "200");
  await expect(handle(page)).toHaveAttribute("aria-valuemin", "180");
  await expect(handle(page)).toHaveAttribute("aria-valuemax", "480");
  await expect(handle(page)).toHaveAttribute("aria-orientation", "vertical");
});

test("moving the sidebar to the right puts it right of the terminal, and it stays after a reload", async ({
  page,
}) => {
  await change(page, async (screen) => {
    await radio(screen, "Right").check();
    await expect(radio(screen, "Right")).toBeChecked();
  });

  const check = async () => {
    const side = await box(sidebar(page));
    const main = await box(content(page));
    expect(side.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
    expect(side.x + side.width).toBeCloseTo(page.viewportSize()?.width ?? 0, 0);
  };
  await check();

  await page.reload();
  await expect(tab(page, "api")).toBeVisible();
  await check();
  const screen = await openSettings(page);
  await expect(radio(screen, "Right")).toBeChecked();

  await radio(screen, "Left").check();
  await closeSettings(page);
  await settled(page);
  expect((await box(sidebar(page))).x).toBe(0);
});

test("a change in the settings screen shows in the window and is written at once, and it stays when the screen closes", async ({
  page,
}) => {
  const screen = await openSettings(page);
  await radio(screen, "Right").check();
  // The sidebar moves and the file has the side, with no Save to press.
  await expect.poll(async () => (await box(sidebar(page))).x).toBeGreaterThan(500);
  await expect.poll(async () => (await configText(page)) ?? "").toContain('"position": "right"');
  await closeSettings(page);
  await expect(settingsScreen(page)).toHaveCount(0);
  expect((await box(sidebar(page))).x).toBeGreaterThan(500);

  const again = await openSettings(page);
  await expect(radio(again, "Right")).toBeChecked();
  await expect(again.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(again.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
});

test("dragging the handle changes the width within 180 to 480 and it stays after a reload", async ({
  page,
}) => {
  await dragHandle(page, 100);
  expect((await box(sidebar(page))).width).toBe(300);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "300");

  // Past the limits the width stops there.
  await dragHandle(page, 600);
  expect((await box(sidebar(page))).width).toBe(480);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "480");
  await dragHandle(page, -900);
  expect((await box(sidebar(page))).width).toBe(180);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "180");

  await dragHandle(page, 120);
  expect((await box(sidebar(page))).width).toBe(300);
  await page.reload();
  await expect(tab(page, "api")).toBeVisible();
  expect((await box(sidebar(page))).width).toBe(300);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "300");
});

test("dragging the handle of a right sidebar to the left widens it", async ({ page }) => {
  await change(page, (screen) => radio(screen, "Right").check());
  await dragHandle(page, -80);
  expect((await box(sidebar(page))).width).toBe(280);
});

test("the arrows on the handle change the width", async ({ page }) => {
  await handle(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "216");
  expect((await box(sidebar(page))).width).toBe(216);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "184");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "232");
  await page.keyboard.press("End");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "480");
  await page.keyboard.press("ArrowRight");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "480");
  await page.keyboard.press("Home");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "180");
  await page.keyboard.press("ArrowLeft");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "180");
  expect((await box(sidebar(page))).width).toBe(180);
});

test("on a right sidebar the arrow pointing away from it widens it", async ({ page }) => {
  await change(page, (screen) => radio(screen, "Right").check());
  await handle(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "216");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "184");
});

test("compact density makes the tab rows shorter, and it stays after a reload", async ({
  page,
}) => {
  const comfortable = (await box(tab(page, "api"))).height;
  await change(page, (screen) => radio(screen, "Compact").check());
  const compact = (await box(tab(page, "api"))).height;
  expect(compact).toBeLessThan(comfortable);

  await page.reload();
  await expect(tab(page, "api")).toBeVisible();
  expect((await box(tab(page, "api"))).height).toBe(compact);
  await change(page, (screen) => radio(screen, "Comfortable").check());
  expect((await box(tab(page, "api"))).height).toBe(comfortable);
});

test.describe("compact mode", () => {
  test("hides the sidebar, shows it after 150 ms on the edge and hides it when the pointer leaves", async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");
    await change(page, (screen) => checkbox(screen, "Compact mode").check());

    // Out of the layout: the terminal takes the whole width.
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
    const hidden = await box(sidebar(page));
    expect(hidden.x + hidden.width).toBeLessThanOrEqual(0.5);
    const main = await box(content(page));
    expect(main.x).toBe(0);
    expect(main.width).toBe(viewport.width);

    // Time from the pointer touching the edge to the sidebar showing.
    await page.evaluate(() => {
      const probe: { entered?: number; shown?: number } = {};
      (window as unknown as { __probe: typeof probe }).__probe = probe;
      const edge = document.querySelector('[data-nr-part="sidebar-edge"]');
      const side = document.querySelector('[data-nr-part="sidebar"]');
      if (!edge || !side) throw new Error("edge or sidebar missing");
      edge.addEventListener("mouseenter", () => {
        probe.entered = performance.now();
      });
      new MutationObserver(() => {
        if (side.getAttribute("data-nr-state") === "revealed") probe.shown ??= performance.now();
      }).observe(side, { attributes: true, attributeFilter: ["data-nr-state"] });
    });
    await page.mouse.move(2, 400);
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "revealed");
    const timing = await page.evaluate(
      () => (window as unknown as { __probe: { entered?: number; shown?: number } }).__probe,
    );
    expect(timing.entered).toBeDefined();
    expect(timing.shown).toBeDefined();
    expect((timing.shown ?? 0) - (timing.entered ?? 0)).toBeGreaterThanOrEqual(145);

    // Shown over the terminal, which does not move.
    await expect.poll(async () => (await box(sidebar(page))).x).toBe(0);
    expect((await box(content(page))).x).toBe(0);

    await page.mouse.move(700, 400);
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
    await expect.poll(async () => (await box(sidebar(page))).x).toBeLessThanOrEqual(-199);
  });

  test("a brush of the edge shorter than 150 ms does not show the sidebar", async ({ page }) => {
    await change(page, (screen) => checkbox(screen, "Compact mode").check());
    await page.mouse.move(2, 400);
    await page.mouse.move(700, 400);
    // Longer than the wait, so a timer that was not cancelled would have shown it by now.
    await page.waitForTimeout(400);
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  });

  test("on the right, the right edge shows the sidebar", async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");
    await change(page, async (screen) => {
      await radio(screen, "Right").check();
      await checkbox(screen, "Compact mode").check();
    });
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");

    // The left edge does nothing.
    await page.mouse.move(2, 400);
    await page.waitForTimeout(300);
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");

    await page.mouse.move(viewport.width - 2, 400);
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "revealed");
    await expect
      .poll(async () => {
        const at = await box(sidebar(page));
        return at.x + at.width;
      })
      .toBe(viewport.width);
    await page.mouse.move(400, 400);
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  });

  test("keeping it open docks the sidebar again", async ({ page }) => {
    await change(page, async (screen) => {
      await checkbox(screen, "Compact mode").check();
      await expect(checkbox(screen, "Keep sidebar open")).toBeEnabled();
      await checkbox(screen, "Keep sidebar open").check();
    });

    await page.mouse.move(700, 400);
    await expect(sidebar(page)).not.toHaveAttribute("data-nr-state", /.*/);
    // The sidebar slides back into the layout (and the content with it): measure it where it stops.
    await afterAnimations(page);
    const side = await box(sidebar(page));
    expect(side.x).toBe(0);
    expect(side.width).toBe(200);
    expect((await box(content(page))).x).toBe(200);
    await expect(tab(page, "api")).toBeInViewport();

    // Without compact mode there is nothing to keep open.
    const screen = await openSettings(page);
    await expect(checkbox(screen, "Keep sidebar open")).toBeEnabled();
    await checkbox(screen, "Compact mode").uncheck();
    await expect(checkbox(screen, "Keep sidebar open")).toBeDisabled();
  });

  test("stays after a reload, and the keyboard reaches the hidden sidebar", async ({ page }) => {
    await change(page, (screen) => checkbox(screen, "Compact mode").check());
    await page.reload();
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
    // The terminal takes the focus once its shell is up, and a focus the test gave before that would be
    // taken away from the sidebar (which then hides): wait for the terminal to have it first.
    await expect(
      page.getByRole("textbox", { name: "Terminal input", exact: true }).first(),
    ).toBeFocused();

    // Tab-focus on a hidden row shows the sidebar; focus leaving hides it.
    await page.keyboard.press("Tab");
    await tab(page, "api").focus();
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "revealed");
    await page.getByRole("button", { name: "Settings", exact: true }).focus();
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  });

  test("a menu opened in the revealed sidebar keeps it shown", async ({ page }) => {
    await change(page, (screen) => checkbox(screen, "Compact mode").check());
    await page.mouse.move(2, 400);
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "revealed");
    await tab(page, "api").click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await page.mouse.move(700, 300);
    await page.waitForTimeout(300);
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "revealed");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
  });
});
