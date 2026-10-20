import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The terminal draws on a canvas (WebGL) or in the DOM renderer, so the tests read xterm's buffer
// through the hook the app publishes with the in-memory backend, never pixels.
interface NorenTestHook {
  lines(): string[];
  renderer(): "webgl" | "dom";
  writeCalls(): number;
}
type HookWindow = Window & { __norenTest?: NorenTestHook };

const readLines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);

const writeCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.writeCalls() ?? -1);

const setClipboard = (page: Page, text: string): Promise<void> =>
  page.evaluate((value) => navigator.clipboard.writeText(value), text);

async function openTerminal(page: Page) {
  await page.goto("/");
  await expect
    .poll(async () => (await readLines(page)).some((line) => line.startsWith("fake$")))
    .toBe(true);
  const input = page.getByRole("textbox", { name: "Terminal input", exact: true });
  await input.focus();
  return input;
}

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("opens in web mode and shows Noren", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Noren", { exact: true })).toBeVisible();
});

test("starts one terminal and reports the renderer in use", async ({ page }, testInfo) => {
  await openTerminal(page);
  await expect(page.getByRole("region", { name: "Terminal", exact: true })).toBeVisible();
  const renderer = await page.evaluate(() => (window as HookWindow).__norenTest?.renderer());
  expect(["webgl", "dom"]).toContain(renderer);
  testInfo.annotations.push({ type: "renderer", description: String(renderer) });
  console.log(`terminal renderer: ${String(renderer)}`);
});

test("typing echo hi and Enter shows hi on its own line", async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.type("echo hi");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await readLines(page)).includes("hi")).toBe(true);
  const lines = await readLines(page);
  expect(lines).toContain("fake$ echo hi");
  expect(lines.filter((line) => line !== "").at(-1)).toBe("fake$ ");
});

test("pasting 3 lines asks first and Cancel writes nothing", async ({ page }) => {
  await openTerminal(page);
  await setClipboard(page, "echo one\necho two\necho three");
  const writesBefore = await writeCalls(page);
  const linesBefore = await readLines(page);

  await page.keyboard.press("Control+Shift+V");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Paste 3 lines?", exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await writeCalls(page)).toBe(writesBefore);
  expect(await readLines(page)).toEqual(linesBefore);
});

test("pasting 3 lines and choosing Paste writes them", async ({ page }) => {
  await openTerminal(page);
  await setClipboard(page, "echo one\necho two\necho three");

  await page.keyboard.press("Control+Shift+V");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Paste", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(async () => {
      const lines = await readLines(page);
      return lines.includes("one") && lines.includes("two");
    })
    .toBe(true);
  // The last line has no line break, so it waits at the prompt for Enter.
  expect(await readLines(page)).toContain("fake$ echo three");
});

test("Escape closes the paste dialog like Cancel", async ({ page }) => {
  await openTerminal(page);
  await setClipboard(page, "a\nb");
  const writesBefore = await writeCalls(page);
  await page.keyboard.press("Control+Shift+V");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The dialog takes the keyboard in an effect after it shows; Escape sent before that goes to the
  // terminal and not to the dialog.
  await expect(dialog.getByRole("button", { name: "Paste", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await writeCalls(page)).toBe(writesBefore);
});

test("a native Shift+Insert paste of several lines also asks first", async ({ page }) => {
  await openTerminal(page);
  await setClipboard(page, "echo one\necho two");
  await page.keyboard.press("Shift+Insert");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("a single line pastes without asking", async ({ page }) => {
  await openTerminal(page);
  await setClipboard(page, "echo solo");
  await page.keyboard.press("Control+Shift+V");
  await expect.poll(async () => (await readLines(page)).includes("fake$ echo solo")).toBe(true);
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("right click pastes when nothing is selected", async ({ page }) => {
  await openTerminal(page);
  await setClipboard(page, "echo right");
  await page.getByRole("region", { name: "Terminal", exact: true }).click({ button: "right" });
  await expect.poll(async () => (await readLines(page)).includes("fake$ echo right")).toBe(true);
});
