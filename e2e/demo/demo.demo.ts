import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// The web demo (NOR-F12-02), tested on the build in `dist-demo/` (`pnpm e2e:demo`): it opens on its
// script (three spaces with a theme each, a group, a pinned tab and a tab split in two panes), says
// the shell is simulated, and the simulated shell answers what is typed. Nothing here reaches the
// network.

interface Hook {
  paneIds(): string[];
  paneLines(paneId: string): string[];
}
type HookWindow = Window & { __norenTest?: Hook };

const switcher = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string): Locator =>
  switcher(page).getByRole("button", { name, exact: true });
const tabs = (page: Page): Locator => page.getByRole("tree", { name: "Tabs", exact: true });
const panes = (page: Page): Locator => page.locator('[data-nr-part="pane"]:visible');
const banner = (page: Page): Locator => page.locator('[data-nr-part="demo-banner"]');

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const paneLines = (page: Page, paneId: string): Promise<string[]> =>
  page.evaluate(
    (id) => (window as HookWindow).__norenTest?.paneLines(id) ?? ["no test hook"],
    paneId,
  );

test("opens on the script and says the shell is simulated", async ({ page }) => {
  await page.goto("/");

  await expect(banner(page)).toContainText("Simulated shell");
  await expect(banner(page)).toContainText("Download the app:");
  // The address is text, not a link: the page code opens none (security-config.test.ts).
  await expect(banner(page).locator('[data-nr-part="demo-download-address"]')).toHaveText(
    /^https:\/\//,
  );
  await expect(banner(page).locator("a")).toHaveCount(0);

  for (const name of ["Code", "Docs", "Lab"]) {
    await expect(spaceButton(page, name)).toBeVisible();
  }
  await expect(spaceButton(page, "Code")).toHaveAttribute("data-nr-state", "active");
  // A group, a pinned tab and the loose tabs of the first space.
  await expect(tabs(page).getByRole("treeitem", { name: /Work/ }).first()).toBeVisible();
  await expect(tabs(page).getByRole("treeitem", { name: /welcome/ })).toBeVisible();
  await expect(tabs(page).getByRole("treeitem", { name: /scratch/ })).toBeVisible();
});

test("the banner speaks Brazilian Portuguese when the browser does", async ({ browser }) => {
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  await page.goto("/");
  await expect(banner(page)).toContainText("Shell simulado");
  await expect(banner(page)).toContainText("Baixe o app:");
  await context.close();
});

test("navigates between the example spaces, each with its own theme", async ({ page }) => {
  await page.goto("/");
  await expect(spaceButton(page, "Code")).toHaveAttribute("data-nr-state", "active");
  const dusk = await rootVar(page, "--nr-bg");
  expect(dusk).toBe("#14161b");

  await spaceButton(page, "Docs").click();
  await expect(spaceButton(page, "Docs")).toHaveAttribute("data-nr-state", "active");
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe("#f6f3ec");
  await expect(tabs(page).getByRole("treeitem", { name: /guide/ })).toBeVisible();
  await expect(tabs(page).getByRole("treeitem", { name: /welcome/ })).toHaveCount(0);

  await spaceButton(page, "Lab").click();
  await expect(spaceButton(page, "Lab")).toHaveAttribute("data-nr-state", "active");
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe("#2e3440");
  await expect(tabs(page).getByRole("treeitem", { name: /experiments/ })).toBeVisible();

  await spaceButton(page, "Code").click();
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(dusk);
});

test("shows the split of the first space with two panes", async ({ page }) => {
  await page.goto("/");
  // The tab that opens is the split one.
  await expect(panes(page)).toHaveCount(2);
  await expect(page.locator('[data-nr-part="item-view"]:visible [role="separator"]')).toHaveCount(
    1,
  );

  // Another tab shows one pane; the split comes back with its two.
  await tabs(page)
    .getByRole("treeitem", { name: /scratch/ })
    .click();
  await expect(panes(page)).toHaveCount(1);
  await tabs(page)
    .getByRole("treeitem", { name: /servers/ })
    .click();
  await expect(panes(page)).toHaveCount(2);
});

test("answers what is typed in the simulated terminal", async ({ page }) => {
  await page.goto("/");
  await tabs(page)
    .getByRole("treeitem", { name: /welcome/ })
    .click();
  await expect(panes(page)).toHaveCount(1);
  const [paneId] = await page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
  if (paneId === undefined) throw new Error("no pane");
  await expect
    .poll(async () => (await paneLines(page, paneId)).some((line) => line.startsWith("fake$")))
    .toBe(true);

  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  await page.keyboard.type("echo hello from the demo");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await paneLines(page, paneId)).includes("hello from the demo"))
    .toBe(true);

  await page.keyboard.type("nonsense");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () =>
      (await paneLines(page, paneId)).some((line) => line.includes("command not found")),
    )
    .toBe(true);
});

test("a visit that comes back finds its own workspace, not the script", async ({ page }) => {
  await page.goto("/");
  await expect(spaceButton(page, "Code")).toBeVisible();
  await spaceButton(page, "Lab").click();
  await expect(spaceButton(page, "Lab")).toHaveAttribute("data-nr-state", "active");
  // The state is saved a moment after the change.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            JSON.parse(window.localStorage.getItem("noren.web.state") ?? "{}") as {
              activeSpaceId?: string;
            }
          ).activeSpaceId,
      ),
    )
    .toBe("demo-lab");
  await page.reload();
  await expect(spaceButton(page, "Lab")).toHaveAttribute("data-nr-state", "active");
});

test("makes no request outside the page", async ({ page }) => {
  const outside: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      !url.startsWith("http://127.0.0.1:") &&
      !url.startsWith("data:") &&
      !url.startsWith("blob:")
    ) {
      outside.push(url);
    }
  });
  await page.goto("/");
  await expect(panes(page)).toHaveCount(2);
  expect(outside).toEqual([]);
});
