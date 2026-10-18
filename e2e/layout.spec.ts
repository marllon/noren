import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedSidebarState } from "./sidebar-fixture";

// The layout preferences (side, width, density, compact mode) are kept in the browser storage under
// `noren.ui.layout`; a new test context starts with none saved.

const sidebar = (page: Page) => page.locator('[data-nr-part="sidebar"]');
const content = (page: Page) => page.getByRole("region", { name: "Content", exact: true });
const handle = (page: Page) => page.getByRole("separator", { name: "Resize sidebar", exact: true });
const tab = (page: Page, name: string) =>
  page.getByRole("list", { name: "Tabs", exact: true }).getByRole("button", { name, exact: true });
const radio = (page: Page, name: string) => page.getByRole("radio", { name, exact: true });
const checkbox = (page: Page, name: string) => page.getByRole("checkbox", { name, exact: true });

/** Box of an element on screen; fails the test when it is not rendered. */
async function box(locator: ReturnType<typeof sidebar>) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("element not on screen");
  return found;
}

/** Opens the Layout panel of the title bar. */
async function openLayout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await expect(page.getByRole("group", { name: "Layout", exact: true })).toBeVisible();
}

/**
 * Closes the Layout panel (it stays open until Escape or a press outside) and waits for the sidebar
 * to stop moving, since a change of mode or side slides it.
 */
async function closeLayout(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Layout", exact: true })).toBeHidden();
  await expect
    .poll(async () => {
      const before = await box(sidebar(page));
      await page.waitForTimeout(80);
      const after = await box(sidebar(page));
      return before.x === after.x && before.width === after.width;
    })
    .toBe(true);
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
  await openLayout(page);
  await radio(page, "Right").check();
  await expect(radio(page, "Right")).toBeChecked();
  await closeLayout(page);

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
  await openLayout(page);
  await expect(radio(page, "Right")).toBeChecked();

  await radio(page, "Left").check();
  await closeLayout(page);
  expect((await box(sidebar(page))).x).toBe(0);
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
  await openLayout(page);
  await radio(page, "Right").check();
  await closeLayout(page);
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
  await openLayout(page);
  await radio(page, "Right").check();
  await closeLayout(page);
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
  await openLayout(page);
  await radio(page, "Compact").check();
  await closeLayout(page);
  const compact = (await box(tab(page, "api"))).height;
  expect(compact).toBeLessThan(comfortable);

  await page.reload();
  await expect(tab(page, "api")).toBeVisible();
  expect((await box(tab(page, "api"))).height).toBe(compact);
  await openLayout(page);
  await radio(page, "Comfortable").check();
  await closeLayout(page);
  expect((await box(tab(page, "api"))).height).toBe(comfortable);
});

test.describe("compact mode", () => {
  test("hides the sidebar, shows it after 150 ms on the edge and hides it when the pointer leaves", async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");
    await openLayout(page);
    await checkbox(page, "Compact mode").check();
    await closeLayout(page);

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
    await openLayout(page);
    await checkbox(page, "Compact mode").check();
    await closeLayout(page);
    await page.mouse.move(2, 400);
    await page.mouse.move(700, 400);
    // Longer than the wait, so a timer that was not cancelled would have shown it by now.
    await page.waitForTimeout(400);
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  });

  test("on the right, the right edge shows the sidebar", async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");
    await openLayout(page);
    await radio(page, "Right").check();
    await checkbox(page, "Compact mode").check();
    await closeLayout(page);
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
    await openLayout(page);
    await checkbox(page, "Compact mode").check();
    await expect(checkbox(page, "Keep sidebar open")).toBeEnabled();
    await checkbox(page, "Keep sidebar open").check();
    await closeLayout(page);

    await page.mouse.move(700, 400);
    await page.waitForTimeout(300);
    await expect(sidebar(page)).not.toHaveAttribute("data-nr-state", /.*/);
    const side = await box(sidebar(page));
    expect(side.x).toBe(0);
    expect(side.width).toBe(200);
    expect((await box(content(page))).x).toBe(200);
    await expect(tab(page, "api")).toBeInViewport();

    // Without compact mode there is nothing to keep open.
    await openLayout(page);
    await checkbox(page, "Compact mode").uncheck();
    await expect(checkbox(page, "Keep sidebar open")).toBeDisabled();
  });

  test("stays after a reload, and the keyboard reaches the hidden sidebar", async ({ page }) => {
    await openLayout(page);
    await checkbox(page, "Compact mode").check();
    await closeLayout(page);
    await page.reload();
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");

    // Tab-focus on a hidden row shows the sidebar; focus leaving hides it.
    await page.keyboard.press("Tab");
    await tab(page, "api").focus();
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "revealed");
    await page.getByRole("button", { name: "Layout", exact: true }).focus();
    await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  });

  test("a menu opened in the revealed sidebar keeps it shown", async ({ page }) => {
    await openLayout(page);
    await checkbox(page, "Compact mode").check();
    await closeLayout(page);
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
