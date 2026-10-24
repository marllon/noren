import { expect, test } from "./test";
import type { Page } from "@playwright/test";

// Links in the terminal. A program writes the text, so a click does not open anything: it asks first
// ("Open link"), shows the address, and only a confirmed `http(s)` address reaches the backend
// (`openedLinks`; the web build records it and never opens a tab). Addresses of any other kind are
// never offered. The same goes for the links a program declares itself (OSC 8).

interface Hook {
  paneIds(): string[];
  sendOutput(paneId: string, text: string): boolean;
  openedLinks(): string[];
  viewport(): { top: number; rows: number };
}
type HookWindow = Window & { __norenTest?: Hook };

const CLEAR = "\x1b[2J\x1b[H";
const dialog = (page: Page) => page.getByRole("alertdialog", { name: "Open link" });
const opened = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.openedLinks() ?? []);

async function start(page: Page): Promise<string> {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  const id = await page.evaluate(() => (window as HookWindow).__norenTest?.paneIds()[0] ?? "");
  expect(id).not.toBe("");
  return id;
}

async function print(page: Page, paneId: string, text: string): Promise<void> {
  const sent = await page.evaluate(
    ({ id, bytes }) => (window as HookWindow).__norenTest?.sendOutput(id, bytes) ?? false,
    { id: paneId, bytes: CLEAR + text },
  );
  expect(sent).toBe(true);
}

/** Clicks the first row of the terminal on screen, `x` pixels from its left edge. */
async function clickFirstRow(page: Page, x: number): Promise<void> {
  const screen = page.locator(".xterm-screen:visible").first();
  const box = await screen.boundingBox();
  const rows = await page.evaluate(() => (window as HookWindow).__norenTest?.viewport().rows ?? 24);
  if (box === null) throw new Error("the terminal is not on screen");
  const y = box.y + box.height / rows / 2;
  await page.mouse.move(box.x + x - 10, y);
  await page.mouse.move(box.x + x, y);
  await page.mouse.click(box.x + x, y);
}

test("an address in the output asks first, shows where it goes and opens only after Open", async ({
  page,
}) => {
  const id = await start(page);
  await print(page, id, "docs: https://example.com/docs?a=1 end");
  // 8 pixels is inside the first characters of the word before the address, so go past "docs: ".
  await clickFirstRow(page, 90);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText("https://example.com/docs?a=1");
  expect(await opened(page)).toEqual([]);

  await dialog(page).getByRole("button", { name: "Open", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await opened(page)).toEqual(["https://example.com/docs?a=1"]);
});

test("Cancel and Esc open nothing", async ({ page }) => {
  const id = await start(page);
  await print(page, id, "docs: https://example.com/docs end");
  await clickFirstRow(page, 90);
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);

  await clickFirstRow(page, 90);
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(await opened(page)).toEqual([]);
});

test("a link a program declares (OSC 8) asks too, with the real address and not the label", async ({
  page,
}) => {
  const id = await start(page);
  await print(page, id, "\x1b]8;;https://example.org/real\x07click me please\x1b]8;;\x07");
  await clickFirstRow(page, 40);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText("https://example.org/real");
  await dialog(page).getByRole("button", { name: "Open", exact: true }).click();
  expect(await opened(page)).toEqual(["https://example.org/real"]);
});

test("an OSC 8 link to a file, a script or another program is never offered", async ({ page }) => {
  const id = await start(page);
  for (const target of [
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "noren://open?path=/tmp",
    "ms-msdt:/id",
  ]) {
    await print(page, id, `\x1b]8;;${target}\x07click me please\x1b]8;;\x07`);
    await clickFirstRow(page, 40);
    await expect(dialog(page)).toHaveCount(0);
  }
  expect(await opened(page)).toEqual([]);
});

test("the web build never opens a window of its own", async ({ page }) => {
  const popups: string[] = [];
  page.on("popup", (popup) => popups.push(popup.url()));
  const id = await start(page);
  await print(page, id, "docs: https://example.com/docs end");
  await clickFirstRow(page, 90);
  await dialog(page).getByRole("button", { name: "Open", exact: true }).click();
  await page.waitForTimeout(200);
  expect(popups).toEqual([]);
});
