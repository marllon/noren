import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { EXAMPLE, answersTo, plugin, seedPlugins, statuses } from "./plugins-fixture";

// Plugins in a Worker and their actions in the palette (NOR-F18-01c). The page is the web build with
// the fake backend, and the plugins are the example of examples/plugins and fixtures; each runs in a
// real Worker of the browser (jsdom has none), tied to the broker of its manifest.

const tree = (page: Page): Locator => page.getByRole("tree", { name: "Tabs", exact: true });
const tabs = (page: Page): Locator => tree(page).locator('[data-nr-part="item"]');
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const pluginEntries = (page: Page): Locator => palette(page).locator('[data-nr-kind="plugin"]');

/** Loads the app and waits until the terminal of the first tab is up and has the keyboard. */
async function start(page: Page): Promise<void> {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __norenTest?: { paneIds(): string[] } }).__norenTest?.paneIds()
            .length ?? 0,
      ),
    )
    .toBe(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
}

async function openPalette(page: Page, query = ""): Promise<void> {
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  if (query !== "") {
    await palette(page).getByRole("combobox", { name: "Command palette", exact: true }).fill(query);
  }
}

const register = (id: string, label: string, request: number | string = 1): string =>
  `globalThis.postMessage({ version: 1, id: ${JSON.stringify(request)}, method: "palette.register", params: { id: ${JSON.stringify(id)}, label: ${JSON.stringify(label)} } });`;

test("the example plugin puts its action in the palette and choosing it opens a tab", async ({
  page,
}) => {
  await start(page);

  await openPalette(page, "example plugin");
  await expect(pluginEntries(page)).toHaveCount(1);
  const entry = pluginEntries(page).first();
  await expect(entry).toContainText("Open a new tab (example plugin)");
  await expect(entry).toContainText("Plugin · New tab action");
  // The entry is listed under its own heading.
  await expect(palette(page).getByText("Plugins", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();

  // Opened again, the action is still there.
  await openPalette(page, "example plugin");
  await expect(pluginEntries(page)).toHaveCount(1);
  await expect(pluginEntries(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();

  await expect(tabs(page)).toHaveCount(2);
  // The plugin was told the action, asked for the tab and got a result for it.
  const answers = await answersTo(page, "new-tab-action");
  expect(answers[0]).toMatchObject({ version: 1, id: 1, result: { id: "open-tab" } });
  expect(answers).toContainEqual({ event: "action", id: "open-tab" });
  expect(answers.at(-1)).toMatchObject({ version: 1, id: 2 });
  expect(answers.at(-1)).toHaveProperty("result");

  // And again: one more tab each time the action is chosen.
  await openPalette(page, "example plugin");
  await expect(pluginEntries(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(tabs(page)).toHaveCount(3);
});

test("a plugin without tabs.create is refused and nothing changes", async ({ page }) => {
  await seedPlugins(page, [
    plugin(
      "no-tabs",
      ["palette.actions"],
      `${register("try", "Try a tab", "reg")}
globalThis.onmessage = (event) => {
  if (event.data && event.data.event === "action") {
    globalThis.postMessage({ version: 1, id: "tab", method: "tabs.create", params: {} });
    globalThis.postMessage({ version: 1, id: "read", method: "terminal.read", params: {} });
  }
};`,
    ),
  ]);
  await start(page);

  await openPalette(page, "try a tab");
  await expect(pluginEntries(page)).toHaveCount(1);
  await expect(pluginEntries(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();

  await expect
    .poll(async () => (await answersTo(page, "no-tabs")).filter((a) => "error" in a).length)
    .toBe(2);
  const errors = (await answersTo(page, "no-tabs")).filter((a) => "error" in a);
  expect(errors).toMatchObject([
    { id: "tab", error: { code: "permission_denied", permission: "tabs.create" } },
    { id: "read", error: { code: "permission_denied", permission: "terminal.read" } },
  ]);
  // Nothing was made: the same one tab.
  await expect(tabs(page)).toHaveCount(1);
  await page.waitForTimeout(200);
  await expect(tabs(page)).toHaveCount(1);
});

test("a plugin without palette.actions is refused and adds nothing to the palette", async ({
  page,
}) => {
  await seedPlugins(page, [
    plugin("no-palette", ["tabs.create"], register("sneak", "Sneaky action")),
  ]);
  await start(page);
  await expect.poll(async () => (await answersTo(page, "no-palette")).length).toBe(1);
  expect((await answersTo(page, "no-palette"))[0]).toMatchObject({
    id: 1,
    error: { code: "permission_denied", permission: "palette.actions" },
  });
  await openPalette(page, "sneaky");
  await expect(pluginEntries(page)).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
});

test("a plugin that fails, or is invalid, does not stop the app or the other plugins", async ({
  page,
}) => {
  await seedPlugins(page, [
    plugin("crashes", ["palette.actions"], `throw new Error("boom");`),
    plugin("syntax", [], `this is not javascript (`),
    { folder: "no-manifest", error: "plugin.json not found" },
    { folder: "wrong-id", manifest: "{}", main: "" },
    EXAMPLE,
  ]);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => dialogs.push(dialog.message()));
  await start(page);

  await expect
    .poll(async () => (await statuses(page)).map((s) => `${s.folder}:${s.state}`).sort())
    .toEqual([
      "crashes:failed",
      "new-tab-action:running",
      "no-manifest:invalid",
      "syntax:failed",
      "wrong-id:invalid",
    ]);
  const crashed = (await statuses(page)).find((s) => s.folder === "crashes");
  expect(crashed?.reason).toContain("boom");

  await openPalette(page, "example plugin");
  await expect(pluginEntries(page)).toHaveCount(1);
  await expect(pluginEntries(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(tabs(page)).toHaveCount(2);
  expect(dialogs).toEqual([]);
});

test("two plugins keep their actions apart", async ({ page }) => {
  await seedPlugins(page, [
    plugin("one", ["palette.actions"], register("go", "Same label")),
    plugin("two", ["palette.actions"], register("go", "Same label")),
  ]);
  await start(page);
  await openPalette(page, "same label");
  await expect(pluginEntries(page)).toHaveCount(2);
  await expect(pluginEntries(page).nth(0)).toContainText("Fixture one");
  await expect(pluginEntries(page).nth(1)).toContainText("Fixture two");
});
