import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

type Start = { profileId?: string; cwd?: string; env?: Record<string, string> };
type TestHook = { lines(): string[]; writeCalls(): number; sessionStarts(): Start[] };
type TestWindow = Window & { __norenTest?: TestHook };

const sessionStarts = (page: Page): Promise<Start[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.sessionStarts() ?? []);
const startCount = async (page: Page): Promise<number> => (await sessionStarts(page)).length;
const writeCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.writeCalls() ?? 0);
const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.lines() ?? []);

const switcher = (page: Page) => page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string) =>
  switcher(page).getByRole("button", { name, exact: true });
const tabs = (page: Page) =>
  page.getByRole("list", { name: "Tabs", exact: true }).getByRole("button");
const spaceColor = (page: Page): Promise<string> =>
  page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--nr-space-color").trim().toLowerCase(),
  );

interface NewSpace {
  name: string;
  color?: string;
  icon?: string;
  cwd?: string;
  env?: string;
}

async function createSpace(page: Page, space: NewSpace): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(space.name);
  if (space.color) await dialog.getByRole("radio", { name: space.color, exact: true }).check();
  if (space.icon) await dialog.getByRole("radio", { name: space.icon, exact: true }).check();
  if (space.cwd) {
    await dialog.getByRole("textbox", { name: "Start folder", exact: true }).fill(space.cwd);
  }
  if (space.env) {
    await dialog
      .getByRole("textbox", { name: "Environment variables", exact: true })
      .fill(space.env);
  }
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("starts with one space, marked active, in the switcher at the foot of the sidebar", async ({
  page,
}) => {
  await page.goto("/");
  await expect(switcher(page)).toHaveAttribute("data-nr-part", "space-switcher");
  const buttons = switcher(page).locator("button[data-nr-state='active']");
  await expect(buttons).toHaveCount(1);
  await expect(buttons).toHaveAttribute("aria-current", "true");
});

test("creates three spaces and switches by Ctrl+Alt+1..3: the active space and the tabs change", async ({
  page,
}) => {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await createSpace(page, { name: "Alpha", color: "Coral", icon: "Rocket" });
  await createSpace(page, { name: "Beta", color: "Green", icon: "Server" });
  await createSpace(page, { name: "Gamma", color: "Violet" });
  // The newest space is the active one and starts with one tab.
  await expect(spaceButton(page, "Gamma")).toHaveAttribute("data-nr-state", "active");
  await expect(tabs(page)).toHaveCount(1);
  expect(await spaceColor(page)).toBe("#a77bdc");

  // Beta gets a second tab so the spaces can be told apart by their tabs.
  await page.keyboard.press("Control+Alt+3");
  await expect(spaceButton(page, "Beta")).toHaveAttribute("data-nr-state", "active");
  expect(await spaceColor(page)).toBe("#4caf7d");
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);

  await page.keyboard.press("Control+Alt+2");
  await expect(spaceButton(page, "Alpha")).toHaveAttribute("data-nr-state", "active");
  await expect(spaceButton(page, "Beta")).not.toHaveAttribute("data-nr-state", "active");
  await expect(tabs(page)).toHaveCount(1);
  expect(await spaceColor(page)).toBe("#e07a5f");

  await page.keyboard.press("Control+Alt+3");
  await expect(spaceButton(page, "Beta")).toHaveAttribute("data-nr-state", "active");
  await expect(tabs(page)).toHaveCount(2);

  // The first space is the one the app opened with.
  await page.keyboard.press("Control+Alt+1");
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await expect(spaceButton(page, "Beta")).not.toHaveAttribute("data-nr-state", "active");
  await expect(tabs(page)).toHaveCount(1);

  // Clicking works too, and a key with no space behind it does nothing.
  await spaceButton(page, "Gamma").click();
  await expect(spaceButton(page, "Gamma")).toHaveAttribute("data-nr-state", "active");
  await page.keyboard.press("Control+Alt+9");
  await expect(spaceButton(page, "Gamma")).toHaveAttribute("data-nr-state", "active");
});

test("the shortcut does not reach the terminal", async ({ page }) => {
  await page.goto("/");
  await createSpace(page, { name: "Alpha" });
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  const before = await writeCalls(page);
  await page.keyboard.press("Control+Alt+1");
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  expect(await writeCalls(page)).toBe(before);
});

test("a new tab in space B starts in B's folder with B's environment", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => startCount(page)).toBe(1);
  await createSpace(page, {
    name: "Beta",
    cwd: "/work/beta",
    env: "STAGE=beta\nTOKEN=a=b",
  });

  // The first tab of the new space already took the defaults.
  await expect.poll(() => startCount(page)).toBe(2);
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect.poll(() => startCount(page)).toBe(3);
  const starts = await sessionStarts(page);
  expect(starts[1]).toEqual({ cwd: "/work/beta", env: { STAGE: "beta", TOKEN: "a=b" } });
  expect(starts[2]).toEqual(starts[1]);
  // The terminal is really there.
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await expect.poll(() => lines(page)).toContain("/work/beta");

  // Space A keeps no folder and no environment.
  await page.keyboard.press("Control+Alt+1");
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect.poll(() => startCount(page)).toBe(4);
  expect((await sessionStarts(page))[3]).toEqual({});
});

test("the dialog needs a name, rejects a bad environment line and cancels cleanly", async ({
  page,
}) => {
  await page.goto("/");
  const open = () => page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await open();
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give the space a name.");

  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Oops");
  await dialog.getByRole("textbox", { name: "Environment variables", exact: true }).fill("NOVALUE");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Line 1: expected NAME=value.");
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(switcher(page).getByRole("button")).toHaveCount(2); // the first space and "New space"
});
