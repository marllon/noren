import { expect, test } from "./test";
import type { Page } from "@playwright/test";

// Values of the Noren Dusk and Noren Paper themes (apps/desktop/src/theme.ts).
const DUSK = { bg: "#14161b", surface: "#1b1e25", text: "#e6e6e6", accent: "#e07a5f" };
const PAPER = { bg: "#f6f3ec", surface: "#ece8dd", text: "#23262d", accent: "#b8472c" };

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test.describe("dark scheme", () => {
  test.use({ colorScheme: "dark" });

  test("Noren Dusk sets the --nr-* tokens and the data-nr-* hooks", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.locator('[data-nr-part="sidebar"]');
    await expect(sidebar).toBeVisible();
    const active = page.locator('[data-nr-part="item"][data-nr-state="active"]');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveAttribute("aria-current", "true");
    await expect(page.locator('[data-nr-part="pane"]:visible')).toHaveCount(1);

    expect(await rootVar(page, "--nr-bg")).toBe(DUSK.bg);
    expect(await rootVar(page, "--nr-surface")).toBe(DUSK.surface);
    expect(await rootVar(page, "--nr-text")).toBe(DUSK.text);
    expect(await rootVar(page, "--nr-accent")).toBe(DUSK.accent);
    // The active space's own color (the default space is blue), no longer the theme accent.
    await expect.poll(() => rootVar(page, "--nr-space-color")).toBe("#6b8afd");
    expect(await rootVar(page, "--nr-radius")).toBe("10px");
    // The page really paints with the token.
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      "rgb(20, 22, 27)",
    );
  });
});

test.describe("light scheme", () => {
  test.use({ colorScheme: "light" });

  test("Noren Paper sets different --nr-* tokens", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-nr-part="sidebar"]')).toBeVisible();
    expect(await rootVar(page, "--nr-bg")).toBe(PAPER.bg);
    expect(await rootVar(page, "--nr-surface")).toBe(PAPER.surface);
    expect(await rootVar(page, "--nr-text")).toBe(PAPER.text);
    expect(await rootVar(page, "--nr-accent")).toBe(PAPER.accent);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      "rgb(246, 243, 236)",
    );
  });
});

test("the theme follows prefers-color-scheme live", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(DUSK.bg);
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(PAPER.bg);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(DUSK.bg);
});

test("the active tab follows the selection through data-nr-state", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  const items = page.locator('[data-nr-part="item"]');
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toHaveAttribute("data-nr-state", "active");
  await expect(items.nth(0)).not.toHaveAttribute("data-nr-state", /.*/);
  await items.nth(0).click();
  await expect(items.nth(0)).toHaveAttribute("data-nr-state", "active");
  await expect(items.nth(1)).not.toHaveAttribute("data-nr-state", /.*/);
});

test("the title bar has the window buttons, which do nothing in web mode", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));

  await page.goto("/");
  await expect(page.locator("[data-tauri-drag-region]").first()).toBeVisible();
  for (const name of ["Minimize", "Maximize", "Close"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    await button.click();
  }
  // Still alive: the Close button of the web page does not close anything.
  await expect(page.locator('[data-nr-part="sidebar"]')).toBeVisible();
  expect(problems).toEqual([]);
});
