import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// The shortcuts screen: search the registry, record a chord for an action, refuse a chord another
// action holds. The overrides live in the browser storage under `noren.ui.keybindings`.

type TestHook = { paneIds(): string[] };
type TestWindow = Window & { __norenTest?: TestHook };

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.paneIds() ?? []);
const saved = (page: Page): Promise<string | null> =>
  page.evaluate(() => window.localStorage.getItem("noren.ui.keybindings"));

const tabs = (page: Page) =>
  page.getByRole("list", { name: "Tabs", exact: true }).getByRole("button");

/** Opens the first tab and clicks its terminal so it holds the keyboard, as a user typing would. */
async function openTerminal(page: Page): Promise<void> {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await expect(tabs(page)).toHaveCount(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
}

const screen = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });

/** The chord text shown for an action. */
const chordOf = (page: Page, title: string): Locator =>
  screen(page).getByLabel(`Shortcut for ${title}`, { exact: true });

async function openScreen(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await expect(screen(page)).toBeVisible();
}

async function closeScreen(page: Page): Promise<void> {
  await screen(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(screen(page)).toBeHidden();
}

async function record(page: Page, title: string, keys: string): Promise<void> {
  await screen(page)
    .getByRole("button", { name: `Record shortcut for ${title}` })
    .click();
  await page.keyboard.press(keys);
}

test("search, record a chord for New tab, and it works at once while the old chord is free", async ({
  page,
}) => {
  await openTerminal(page);
  await openScreen(page);
  await expect(
    screen(page).getByRole("list", { name: "Shortcuts" }).getByRole("listitem"),
  ).toHaveCount(34);

  await screen(page).getByRole("textbox", { name: "Search shortcuts" }).fill("new tab");
  await expect(
    screen(page).getByRole("list", { name: "Shortcuts" }).getByRole("listitem"),
  ).toHaveCount(1);
  await expect(chordOf(page, "New tab")).toHaveText("Ctrl+Shift+T");

  await record(page, "New tab", "Control+Alt+K");
  await expect(chordOf(page, "New tab")).toHaveText("Ctrl+Alt+K");
  await expect(screen(page).getByRole("status")).toHaveText('"New tab" is now Ctrl+Alt+K.');
  expect(await saved(page)).toContain('"tab.new":"Ctrl+Alt+KeyK"');

  await closeScreen(page);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await page.keyboard.press("Control+Alt+K");
  await expect(tabs(page)).toHaveCount(2);

  // The old chord no longer opens a tab and is not swallowed: it is nobody's now, so it goes on
  // to the terminal. A listener added after the app's tells whether the app took the press.
  await page.evaluate(() => {
    const taken: string[] = [];
    (window as Window & { __taken?: string[] }).__taken = taken;
    window.addEventListener(
      "keydown",
      (event) => taken.push(`${event.code}:${event.defaultPrevented ? "taken" : "free"}`),
      true,
    );
  });
  await page.keyboard.press("Control+Shift+T");
  const seen = await page.evaluate(() => (window as Window & { __taken?: string[] }).__taken);
  expect(seen?.at(-1)).toBe("KeyT:free");
  await expect(tabs(page)).toHaveCount(2);

  // The new chord survives a reload.
  await page.reload();
  await expect(tabs(page)).toHaveCount(2);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await page.keyboard.press("Control+Alt+K");
  await expect(tabs(page)).toHaveCount(3);
});

test("a chord another action holds is refused with a warning and nothing changes", async ({
  page,
}) => {
  await openTerminal(page);
  await openScreen(page);
  expect(await saved(page)).toBeNull();

  // Ctrl+Shift+D is Split right's: recording it must not split, and New tab must not take it.
  await record(page, "New tab", "Control+Shift+D");
  const alert = screen(page).getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Ctrl+Shift+D is already used by");
  await expect(alert).toContainText('"Split right"');
  await expect(alert).toContainText("nothing changed");
  expect(await paneIds(page)).toHaveLength(1);
  await expect(chordOf(page, "New tab")).toHaveText("Ctrl+Shift+T");
  await expect(chordOf(page, "Split right")).toHaveText("Ctrl+Shift+D");
  expect(await saved(page)).toBeNull();

  // Back in the app both actions still have their own chord.
  await closeScreen(page);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await page.keyboard.press("Control+Shift+T");
  await expect(tabs(page)).toHaveCount(2);
  await page.keyboard.press("Control+Shift+D");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(2);
});

test("a chord an action gave up is free for another, and the first cannot take it back", async ({
  page,
}) => {
  await openTerminal(page);
  await openScreen(page);
  await record(page, "Split right", "Control+Alt+J");
  await expect(chordOf(page, "Split right")).toHaveText("Ctrl+Alt+J");
  // Split right gave up Ctrl+Shift+D, so Zoom pane can take it.
  await record(page, "Zoom pane", "Control+Shift+D");
  await expect(chordOf(page, "Zoom pane")).toHaveText("Ctrl+Shift+D");
  // And Split right cannot go back to it now.
  await screen(page).getByRole("button", { name: "Reset shortcut for Split right" }).click();
  await expect(screen(page).getByRole("alert")).toContainText('"Zoom pane"');
  await expect(chordOf(page, "Split right")).toHaveText("Ctrl+Alt+J");
});

test("a press with no Ctrl or Alt gets a hint, and Escape cancels the recording", async ({
  page,
}) => {
  await openTerminal(page);
  await openScreen(page);
  await screen(page).getByRole("button", { name: "Record shortcut for Zoom pane" }).click();
  await page.keyboard.press("K");
  await expect(screen(page).getByRole("status")).toHaveText(
    "Hold Ctrl or Alt together with a key.",
  );
  await expect(chordOf(page, "Zoom pane")).toHaveText("Ctrl+Shift+Z");

  // Still recording: Escape cancels it and the screen stays open.
  await page.keyboard.press("Escape");
  await expect(screen(page).getByRole("status")).toHaveText("Recording cancelled.");
  await expect(screen(page)).toBeVisible();
  expect(await saved(page)).toBeNull();

  // Recording is over, so the next Escape closes the screen.
  await page.keyboard.press("Escape");
  await expect(screen(page)).toBeHidden();
});

test("Remove leaves an action without a key and Reset brings the preset chord back", async ({
  page,
}) => {
  await openTerminal(page);
  await openScreen(page);
  await expect(
    screen(page).getByRole("button", { name: "Reset shortcut for New tab" }),
  ).toBeDisabled();
  await screen(page).getByRole("button", { name: "Remove shortcut for New tab" }).click();
  await expect(chordOf(page, "New tab")).toHaveText("None");
  expect(await saved(page)).toContain('"tab.new":null');
  await closeScreen(page);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await page.keyboard.press("Control+Shift+T");
  await expect(tabs(page)).toHaveCount(1);

  await openScreen(page);
  await screen(page).getByRole("button", { name: "Reset shortcut for New tab" }).click();
  await expect(chordOf(page, "New tab")).toHaveText("Ctrl+Shift+T");
  await closeScreen(page);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await page.keyboard.press("Control+Shift+T");
  await expect(tabs(page)).toHaveCount(2);
});

test("the screen lists the shell keys the browser preset stops delivering", async ({ page }) => {
  await openTerminal(page);
  await openScreen(page);
  await expect(screen(page)).toContainText(
    "The browser preset would take Ctrl+T, Ctrl+W, Ctrl+1..9 away from the terminal",
  );
  await closeScreen(page);

  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("radio", { name: "Browser", exact: true }).check();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await expect(screen(page)).toContainText(
    "The browser preset is on: Ctrl+T, Ctrl+W, Ctrl+1..9 no longer reach the terminal",
  );
  await expect(chordOf(page, "New tab")).toHaveText("Ctrl+T");
});
