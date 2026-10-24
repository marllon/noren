import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { JSON_PROFILES_FILE } from "../packages/model/src/import-fixtures";
import { expectNoAxeViolations } from "./axe-fixture";
import { openSettings, seedConfig } from "./settings-fixture";
import { ACTIONS_CWD, ACTIONS_TEXT, seedActionsFile, seedSidebarState } from "./sidebar-fixture";
import { runPaletteCommand, openCommandPalette } from "./palette-fixture";

// axe-core on the menus, dialogs and overlays of the window (NOR-F20-01b): the context menus of the
// tab, the group, the space and the pane, the confirmation, space, picture, paste, "ask for a
// command", profile import, worktree and link dialogs, the search over the tabs, the Ctrl+Tab
// switcher, the space switcher, the peek of a tab and the quick terminal panel. Each test opens the
// surface the way a user does (shortcut, palette, click or menu) and a violation of any impact
// fails it.

interface Hook {
  paneIds(): string[];
  lines(): string[];
  sendOutput(paneId: string, text: string): boolean;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_AI_OLLAMA_KEY = "noren.web.ai-ollama";
const WEB_GIT_KEY = "noren.web.git";

const AI_ON = `{
  "ai": {
    "enabled": true,
    "defaults": { "command": { "provider": "ollama", "model": "mistral" } }
  }
}
`;

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);

const tree = (page: Page): Locator => page.getByRole("tree", { name: "Tabs", exact: true });
const tab = (page: Page, name: string): Locator =>
  tree(page).getByRole("treeitem", { name, exact: true });
const switcher = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string): Locator =>
  switcher(page).getByRole("button", { name, exact: true });
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const paletteBox = (page: Page): Locator =>
  palette(page).getByRole("combobox", { name: "Command palette", exact: true });

/** The window with the sidebar workspace (pinned tab, group, split tab, a second space) on screen. */
async function open(page: Page, tabsOnTop = false): Promise<void> {
  await seedSidebarState(page, { split: true, secondSpace: true });
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBeGreaterThan(0);
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeAttached();
  if (!tabsOnTop) await expect(tab(page, "api")).toBeVisible();
}

test.describe("menus", () => {
  test("axe: the context menu of a tab has no axe violation", async ({ page }) => {
    await open(page);
    await tab(page, "api").click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await expectNoAxeViolations(page, "tab menu");
  });

  test("axe: the context menu of a group has no axe violation", async ({ page }) => {
    await open(page);
    await tree(page).locator('[data-nr-part="group"]').first().click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await expectNoAxeViolations(page, "group menu");
  });

  test("axe: the menu of a space has no axe violation", async ({ page }) => {
    await open(page);
    await spaceButton(page, "Main").click({ button: "right" });
    await expect(page.getByRole("menu", { name: "Main options", exact: true })).toBeVisible();
    await expectNoAxeViolations(page, "space menu");
  });

  test("axe: the menu of a pane has no axe violation", async ({ page }) => {
    await seedConfig(page, JSON.stringify({ appearance: { paneHeaders: true } }));
    await open(page);
    await tab(page, "servers").click();
    await page.getByRole("button", { name: "Pane menu", exact: true }).first().click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expectNoAxeViolations(page, "pane menu");
  });
});

test.describe("dialogs", () => {
  test("axe: the New space dialog has no axe violation", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "New space", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New space", exact: true })).toBeVisible();
    await expectNoAxeViolations(page, "new space dialog");
  });

  test("axe: the Edit space dialog has no axe violation", async ({ page }) => {
    await open(page);
    await spaceButton(page, "Main").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Edit space…", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoAxeViolations(page, "edit space dialog");
  });

  test("axe: the background image dialog has no axe violation", async ({ page }) => {
    await open(page);
    await spaceButton(page, "Main").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Background image…", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Background image", exact: true })).toBeVisible();
    await expectNoAxeViolations(page, "background image dialog");
  });

  test("axe: the confirmation to delete a space has no axe violation", async ({ page }) => {
    await open(page);
    await spaceButton(page, "Main").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete space…", exact: true }).click();
    await expect(
      page.getByRole("alertdialog", { name: "Delete space", exact: true }),
    ).toBeVisible();
    await expectNoAxeViolations(page, "delete space confirmation");
  });

  test("axe: the paste dialog has no axe violation", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page);
    await page.evaluate(() => navigator.clipboard.writeText("echo one\necho two\necho three"));
    await page.locator('[data-nr-part="pane"]:visible').first().click();
    await page.keyboard.press("Control+Shift+V");
    await expect(page.getByRole("dialog", { name: "Paste 3 lines?", exact: true })).toBeVisible();
    await expectNoAxeViolations(page, "paste dialog");
  });

  test("axe: the link prompt has no axe violation", async ({ page }) => {
    await open(page);
    const id = (await paneIds(page))[0] ?? "";
    expect(
      await page.evaluate(
        ({ pane, bytes }) => (window as HookWindow).__norenTest?.sendOutput(pane, bytes) ?? false,
        { pane: id, bytes: "\x1b[2J\x1b[Hdocs: https://example.com/docs?a=1 end" },
      ),
    ).toBe(true);
    const screen = page.locator(".xterm-screen:visible").first();
    const box = await screen.boundingBox();
    if (box === null) throw new Error("the terminal is not on screen");
    const y = box.y + 8;
    await page.mouse.move(box.x + 80, y);
    await page.mouse.move(box.x + 90, y);
    await page.mouse.click(box.x + 90, y);
    await expect(page.getByRole("alertdialog", { name: "Open link" })).toBeVisible();
    await expectNoAxeViolations(page, "link prompt");
  });

  test("axe: the dialog that asks the AI for a command has no axe violation", async ({ page }) => {
    await seedConfig(page, AI_ON);
    await page.addInitScript(
      ({ key, value }) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      { key: WEB_AI_OLLAMA_KEY, value: JSON.stringify(["llama3", "mistral"]) },
    );
    await open(page);
    await page.locator('[data-nr-part="pane"]:visible').first().click();
    await openCommandPalette(page);
    await expect(palette(page)).toBeVisible();
    await paletteBox(page).fill("? list the files");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Ask for a command", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-nr-part="command-preview"]')).toBeVisible();
    await expectNoAxeViolations(page, "ask for a command dialog");
  });

  test("axe: the preview of the profiles to import has no axe violation", async ({ page }) => {
    await open(page);
    const screen = await openSettings(page);
    const chooser = page.waitForEvent("filechooser");
    await screen.getByRole("button", { name: "Import profiles...", exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: "settings.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON_PROFILES_FILE, "utf8"),
    });
    await expect(page.getByRole("dialog", { name: "Import profiles", exact: true })).toBeVisible();
    await expectNoAxeViolations(page, "profile import dialog");
  });

  test("axe: the New worktree dialog has no axe violation", async ({ page }) => {
    await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
      key: WEB_GIT_KEY,
      value: JSON.stringify({ "/work/repo": "main" }),
    });
    await page.goto("/");
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
    await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
    await page.keyboard.type("cd /work/repo");
    await page.keyboard.press("Enter");
    await expect(
      tree(page).locator('[data-nr-part="item-cwd"]').filter({ hasText: "/work/repo" }),
    ).toHaveCount(1);
    await runPaletteCommand(page, "New worktree");
    await expect(page.getByRole("dialog", { name: "New worktree", exact: true })).toBeVisible();
    await expectNoAxeViolations(page, "new worktree dialog");
  });
});

test.describe("more dialogs", () => {
  test("axe: the confirmation to run a project action has no axe violation", async ({ page }) => {
    await seedSidebarState(page, { cwd: ACTIONS_CWD });
    await seedActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
    await page.goto("/");
    await expect(tab(page, "api")).toBeVisible();
    await page
      .getByRole("region", { name: "Project actions", exact: true })
      .getByRole("button", { name: "Start Loop", exact: true })
      .click();
    await expect(
      page.getByRole("alertdialog", { name: "Run project action", exact: true }),
    ).toBeVisible();
    await expectNoAxeViolations(page, "run project action confirmation");
  });

  test("axe: the dialog to remove a worktree and its confirmation have no axe violation", async ({
    page,
  }) => {
    await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
      key: WEB_GIT_KEY,
      value: JSON.stringify({ "/work/repo": "main" }),
    });
    await page.goto("/");
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
    await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
    await page.keyboard.type("cd /work/repo");
    await page.keyboard.press("Enter");
    await expect(
      tree(page).locator('[data-nr-part="item-cwd"]').filter({ hasText: "/work/repo" }),
    ).toHaveCount(1);
    await runPaletteCommand(page, "New worktree");
    const make = page.getByRole("dialog", { name: "New worktree", exact: true });
    await make.getByRole("textbox", { name: "Branch", exact: true }).fill("feature/axe");
    await make.getByRole("button", { name: "Create worktree", exact: true }).click();
    await expect(make).toBeHidden();

    await runPaletteCommand(page, "Remove worktree");
    const remove = page.getByRole("dialog", { name: "Remove worktree", exact: true });
    await expect(remove.getByRole("list", { name: "Worktrees", exact: true })).toBeVisible();
    await expectNoAxeViolations(page, "remove worktree dialog");

    await remove.getByRole("list", { name: "Worktrees", exact: true }).getByRole("button").click();
    await expect(
      page.getByRole("alertdialog", { name: "Remove this worktree?", exact: true }),
    ).toBeVisible();
    await expectNoAxeViolations(page, "remove worktree confirmation");
  });
});

test.describe("tabs on top", () => {
  test("axe: the menu of a tab in the top bar has no axe violation", async ({ page }) => {
    await seedConfig(page, JSON.stringify({ appearance: { tabs: "top" } }));
    await open(page, true);
    await expect(page.getByRole("tablist", { name: "Tabs", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "api", exact: true }).click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await expectNoAxeViolations(page, "tab menu in the top bar");
  });
});

test.describe("notices", () => {
  test("axe: the window with the notice of a broken settings file has no axe violation", async ({
    page,
  }) => {
    await seedConfig(page, "{ this is not json");
    await open(page);
    await expect(page.locator('[data-nr-part="config-notice"]')).toBeVisible();
    await expectNoAxeViolations(page, "config error notice");
  });
});

test.describe("overlays", () => {
  test("axe: the command palette in the mode that asks the AI has no axe violation", async ({
    page,
  }) => {
    await open(page);
    await openCommandPalette(page);
    await paletteBox(page).fill("new");
    await expect(palette(page).getByRole("option").first()).toBeVisible();
    await expectNoAxeViolations(page, "palette with a query");
  });

  test("axe: the search over the tabs has no axe violation", async ({ page }) => {
    await open(page);
    await page.locator('[data-nr-part="pane"]:visible').first().click();
    await page.keyboard.press("Control+Shift+Alt+F");
    const panel = page.locator('[data-nr-part="tab-search"]');
    await expect(panel).toBeVisible();
    const box = panel.getByRole("textbox", { name: "Search text in all tabs", exact: true });
    await box.fill("fake");
    await expect(panel.getByRole("option").first()).toBeVisible();
    await expectNoAxeViolations(page, "tab search with results");
  });

  test("axe: the Ctrl+Tab switcher has no axe violation", async ({ page }) => {
    await open(page);
    await page.locator('[data-nr-part="pane"]:visible').first().click();
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-nr-part="mru"]')).toBeVisible();
    await expectNoAxeViolations(page, "tab switcher");
    await page.keyboard.up("Control");
  });

  test("axe: the space switcher has no axe violation", async ({ page }) => {
    await open(page);
    await expect(switcher(page)).toBeVisible();
    await expect(switcher(page).locator("button[data-nr-state='active']")).toHaveCount(1);
    await expectNoAxeViolations(page, "space switcher");
  });

  test("axe: the peek of a tab has no axe violation", async ({ page }) => {
    await open(page);
    const id = (await paneIds(page))[1] ?? "";
    await page.evaluate(
      ({ pane, bytes }) => (window as HookWindow).__norenTest?.sendOutput(pane, bytes),
      { pane: id, bytes: "one\r\ntwo\r\nthree\r\n" },
    );
    await tab(page, "api").hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await expectNoAxeViolations(page, "peek");
  });

  test("axe: the quick terminal panel has no axe violation", async ({ page }) => {
    await page.goto("/?quick-preview");
    await page.waitForFunction(
      () => (window as unknown as { __norenQuick?: unknown }).__norenQuick !== undefined,
    );
    await expect
      .poll(async () => (await lines(page)).some((l) => l.startsWith("fake$")))
      .toBe(true);
    await page.evaluate(() =>
      (window as unknown as { __norenQuick: { show(): Promise<void> } }).__norenQuick.show(),
    );
    await expect(page.locator('[data-nr-part="quick-preview"]')).toHaveAttribute(
      "data-nr-shown",
      "true",
    );
    await expectNoAxeViolations(page, "quick terminal panel");
  });
});
