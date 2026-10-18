import { expect, test } from "@playwright/test";

test("opens in web mode and shows Noren", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Noren", { exact: true })).toBeVisible();
});
