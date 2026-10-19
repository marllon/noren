import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedSidebarState } from "./sidebar-fixture";
import { seedConfig } from "./settings-fixture";

// The window with a picture behind the terminals: first with a solid interface (the picture shows
// in the area of the terminal, which has no background of its own while a picture is on), then
// with a see-through interface and a blurred picture (the sidebar lets it through). The fixture
// picture is a small gradient. Baselines are per operating system (Windows only, D7):
// `pnpm e2e:visual`.

const PICTURE = "fixtures/background.png";
const FIXTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));

const tab = (page: Page, name: string) =>
  page
    .getByRole("tree", { name: "Tabs", exact: true })
    .getByRole("treeitem", { name, exact: true });

test.use({ colorScheme: "dark" });

async function shoot(page: Page, config: string, name: string): Promise<void> {
  await seedSidebarState(page);
  await seedConfig(page, config);
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: "noren.web.images", value: JSON.stringify({ [PICTURE]: FIXTURE.toString("base64") }) },
  );
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
  await expect(page.locator('[data-nr-part="background"]')).toHaveCount(1);

  // A fixed state: nothing hovered or focused.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(900, 500);

  // The terminal is never part of a screenshot: its layers are hidden and the area stays empty,
  // which is also what a terminal with no background of its own looks like over the picture.
  await page.addStyleTag({ content: ".space-layer { visibility: hidden; }" });
  await expect(page.locator(".app")).toHaveScreenshot(name, {
    animations: "disabled",
    caret: "hide",
  });
}

test("@visual window with a picture behind the terminals", async ({ page }) => {
  await shoot(
    page,
    `{ "appearance": { "background": { "image": "${PICTURE}", "opacity": 0.7, "blur": 0 } } }`,
    "window-picture.png",
  );
});

test("@visual window with a see-through interface over a blurred picture", async ({ page }) => {
  await shoot(
    page,
    `{ "appearance": { "window": { "opacity": 0.6 }, "background": { "image": "${PICTURE}", "opacity": 0.9, "blur": 8 } } }`,
    "window-picture-glass.png",
  );
});
