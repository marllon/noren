import { expect, test } from "./test";
import type { Page } from "@playwright/test";
import { numberTheTabs } from "./numbered-tabs";

test.beforeEach(numberTheTabs);

const tabs = (page: Page) =>
  page.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem");

const tabLabels = (page: Page): Promise<string[]> => tabs(page).allInnerTexts();

const activeIndex = (page: Page): Promise<number> =>
  tabs(page).evaluateAll((buttons) =>
    buttons.findIndex((button) => button.getAttribute("aria-current") === "true"),
  );

test("opens with one space and one tab", async ({ page }) => {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  expect(await activeIndex(page)).toBe(0);
  await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Terminal", exact: true })).toBeVisible();
});

test("two new tabs, a reload and the same tabs come back in the same order", async ({ page }) => {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  const newTab = page.getByRole("button", { name: "New tab", exact: true });
  await newTab.click();
  await newTab.click();
  await expect(tabs(page)).toHaveCount(3);
  // The newest tab is the active one.
  expect(await activeIndex(page)).toBe(2);
  // Choosing another tab is part of what must survive.
  await tabs(page).nth(1).click();
  expect(await activeIndex(page)).toBe(1);
  const before = await tabLabels(page);
  expect(before).toEqual(["Tab 1", "Tab 2", "Tab 3"]);

  await page.reload();

  await expect(tabs(page)).toHaveCount(3);
  expect(await tabLabels(page)).toEqual(before);
  expect(await activeIndex(page)).toBe(1);
  // The restored tab shows a live terminal again.
  const panel = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(panel).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __norenTest?: { lines(): string[] } }).__norenTest?.lines() ?? [],
      ),
    )
    .toContainEqual(expect.stringMatching(/^fake\$/));
});

test("each tab keeps its own terminal while another one shows", async ({ page }) => {
  type Hook = { lines(): string[] };
  const lines = () =>
    page.evaluate(() => (window as Window & { __norenTest?: Hook }).__norenTest?.lines() ?? []);
  await page.goto("/");
  await expect.poll(async () => (await lines()).some((l) => l.startsWith("fake$"))).toBe(true);
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  await page.keyboard.type("echo first");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await lines()).includes("first")).toBe(true);

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect.poll(async () => (await lines()).some((l) => l.startsWith("fake$"))).toBe(true);
  expect(await lines()).not.toContain("first");

  await tabs(page).nth(0).click();
  await expect.poll(async () => (await lines()).includes("first")).toBe(true);
});
