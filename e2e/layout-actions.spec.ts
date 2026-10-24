import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { changeSettings, configText, openShortcutsScreen, seedConfig } from "./settings-fixture";
import { afterNextFrame } from "./frames";
import { seedSidebarState } from "./sidebar-fixture";
import { openCommandPalette } from "./palette-fixture";

// The layout modes (side, width, density, compact mode, keeping the sidebar open, tabs on top)
// are actions of the registry, so the palette runs them, and the settings screen sets the same
// modes. Both write `config.jsonc` (the web build keeps that text under `noren.web.config`) with
// its comments in place, and the interface follows the file with no reload.

interface Hook {
  failConfigSaves(message: string | null): void;
  configSaves(): number;
}
type HookWindow = Window & { __norenTest?: Hook; __stillHere?: boolean };

const body = (page: Page) => page.locator(".app-body");
const handle = (page: Page) => page.getByRole("separator", { name: "Resize sidebar", exact: true });
const tabBar = (page: Page) => page.locator('[data-nr-part="tabbar"]');
const palette = (page: Page) => page.locator('[data-nr-part="palette"]');
const notice = (page: Page) => page.locator('[data-nr-part="pane-notice"]');
const tab = (page: Page, name: string) =>
  page
    .getByRole("tree", { name: "Tabs", exact: true })
    .getByRole("treeitem", { name, exact: true });
const radio = (screen: Locator, name: string) => screen.getByRole("radio", { name, exact: true });
const checkbox = (screen: Locator, name: string) =>
  screen.getByRole("switch", { name, exact: true });

/** A settings file with comments, as a person writes it. */
const COMMENTED = `// My Noren settings, keep this line.
{
  /* where things go */
  "appearance": {
    "sidebar": { "position": "left", "width": 240 }, // I like it on the left
    "density": "comfortable", /* rows */
  },
  // Quiet.
  "notifications": { "enabled": true },
}
`;

const KEPT_COMMENTS = [
  "// My Noren settings, keep this line.",
  "/* where things go */",
  "// I like it on the left",
  "/* rows */",
  "// Quiet.",
];

async function start(page: Page, file: string = COMMENTED): Promise<void> {
  await seedSidebarState(page);
  await seedConfig(page, file);
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest !== undefined))
    .toBe(true);
  // Marks this document: it is gone if the page reloads.
  await page.evaluate(() => {
    (window as HookWindow).__stillHere = true;
  });
}

const samePage = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(() => (window as HookWindow).__stillHere);

/** Runs a palette action by its title. */
async function runAction(page: Page, title: string): Promise<void> {
  // The settings screen (or an earlier palette) hands the keyboard back to the terminal a frame
  // after it closes; opening the palette before that would lose the focus to the terminal.
  await expect(page.locator("textarea.xterm-helper-textarea:focus")).toHaveCount(1);
  await afterNextFrame(page);
  await openCommandPalette(page);
  await expect(palette(page)).toBeVisible();
  const box = palette(page).getByRole("combobox", { name: "Command palette", exact: true });
  await expect(box).toBeFocused();
  await box.fill(`>${title}`);
  const first = palette(page).getByRole("option").first();
  await expect(first).toContainText(title);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  // The palette hands the keyboard back to the terminal a frame later; opening it again before
  // that would lose the focus to the terminal.
  await expect(page.locator("textarea.xterm-helper-textarea:focus")).toHaveCount(1);
}

/** Every comment is still in the file the app holds. */
async function expectCommentsKept(page: Page): Promise<string> {
  const text = (await configText(page)) ?? "";
  for (const comment of KEPT_COMMENTS) expect(text).toContain(comment);
  return text;
}

test.describe("from the palette", () => {
  test("Switch sidebar side moves the sidebar and rewrites only the side", async ({ page }) => {
    await start(page);
    await expect(body(page)).toHaveAttribute("data-nr-side", "left");
    await runAction(page, "Switch sidebar side");
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");
    const text = await expectCommentsKept(page);
    expect(text).toContain('"position": "right", "width": 240 }, // I like it on the left');
    expect(text).toContain('"density": "comfortable"');
    await runAction(page, "Switch sidebar side");
    await expect(body(page)).toHaveAttribute("data-nr-side", "left");
    expect(await samePage(page)).toBe(true);
  });

  test("Widen sidebar and Narrow sidebar step the width and stop at 180 and 480", async ({
    page,
  }) => {
    await start(page);
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "240");
    await runAction(page, "Widen sidebar");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "288");
    expect((await expectCommentsKept(page)).includes('"width": 288')).toBe(true);
    await runAction(page, "Narrow sidebar");
    await runAction(page, "Narrow sidebar");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "192");
    // A step past the end goes to the end, and the end itself is refused with a notice.
    await runAction(page, "Narrow sidebar");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "180");
    await runAction(page, "Narrow sidebar");
    await expect(notice(page)).toContainText("already as narrow as it goes (180 px)");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "180");
    for (let i = 0; i < 7; i++) await runAction(page, "Widen sidebar");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "480");
    await runAction(page, "Widen sidebar");
    await expect(notice(page)).toContainText("already as wide as it goes (480 px)");
    expect(await samePage(page)).toBe(true);
    await expectCommentsKept(page);
  });

  test("Switch density flips the rows between comfortable and compact", async ({ page }) => {
    await start(page);
    await expect(body(page)).toHaveAttribute("data-nr-density", "comfortable");
    await runAction(page, "Switch density");
    await expect(body(page)).toHaveAttribute("data-nr-density", "compact");
    const text = await expectCommentsKept(page);
    expect(text).toContain('"density": "compact", /* rows */');
    await runAction(page, "Switch density");
    await expect(body(page)).toHaveAttribute("data-nr-density", "comfortable");
    expect(await samePage(page)).toBe(true);
  });

  test("Toggle compact mode hides the sidebar, and Toggle keep sidebar open docks it again", async ({
    page,
  }) => {
    await start(page);
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "docked");
    // Keeping the sidebar open needs compact mode: refused with a notice and nothing written.
    await runAction(page, "Toggle keep sidebar open");
    await expect(notice(page)).toContainText("needs compact mode");
    expect(await configText(page)).toBe(COMMENTED);

    await runAction(page, "Toggle compact mode");
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "auto-hide");
    expect(await expectCommentsKept(page)).toContain('"compact": true');
    await runAction(page, "Toggle keep sidebar open");
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "docked");
    expect(await expectCommentsKept(page)).toContain('"keepOpen": true');
    await runAction(page, "Toggle keep sidebar open");
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "auto-hide");
    await runAction(page, "Toggle compact mode");
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "docked");
    expect(await samePage(page)).toBe(true);
  });

  test("Toggle tabs on top shows the tab bar, and compact mode is refused while it is on", async ({
    page,
  }) => {
    await start(page);
    await expect(tabBar(page)).toHaveCount(0);
    await runAction(page, "Toggle tabs on top");
    await expect(tabBar(page)).toBeVisible();
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "auto-hide");
    expect(await expectCommentsKept(page)).toContain('"tabs": "top"');

    await runAction(page, "Toggle compact mode");
    await expect(notice(page)).toContainText("top tabs");

    await runAction(page, "Toggle tabs on top");
    await expect(tabBar(page)).toHaveCount(0);
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "docked");
    expect(await samePage(page)).toBe(true);
  });

  test("a failed write shows a notice and leaves the file and the interface alone", async ({
    page,
  }) => {
    await start(page);
    await page.evaluate(() => (window as HookWindow).__norenTest?.failConfigSaves("disk full"));
    await runAction(page, "Switch sidebar side");
    await expect(notice(page)).toContainText("Could not write config.jsonc: disk full");
    await expect(body(page)).toHaveAttribute("data-nr-side", "left");
    expect(await configText(page)).toBe(COMMENTED);

    await page.evaluate(() => (window as HookWindow).__norenTest?.failConfigSaves(null));
    await runAction(page, "Switch sidebar side");
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");
  });

  test("a file with a problem is not edited, and the notice says so", async ({ page }) => {
    const broken = '{\n  "appearance": {\n    "sidebar": { "position": "middle" }\n  }\n}\n';
    await start(page, broken);
    await runAction(page, "Switch density");
    await expect(notice(page)).toContainText("The settings file has a problem");
    expect(await configText(page)).toBe(broken);
    await expect(body(page)).toHaveAttribute("data-nr-density", "comfortable");
  });

  test("with no settings file the first action creates it", async ({ page }) => {
    await seedSidebarState(page);
    await page.goto("/");
    await expect(tab(page, "api")).toBeVisible();
    expect(await configText(page)).toBeNull();
    await runAction(page, "Switch density");
    await expect(body(page)).toHaveAttribute("data-nr-density", "compact");
    expect(JSON.parse((await configText(page)) ?? "{}")).toEqual({
      appearance: { density: "compact" },
    });
  });
});

test.describe("from the settings screen", () => {
  test("each mode set in the screen shows without a reload and keeps the comments", async ({
    page,
  }) => {
    await start(page);

    await changeSettings(page, (screen) => radio(screen, "Right").check());
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");

    await changeSettings(page, async (screen) => {
      await screen.getByRole("textbox", { name: "Sidebar width (px)" }).fill("300");
    });
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "300");

    await changeSettings(page, (screen) => radio(screen, "Compact").check());
    await expect(body(page)).toHaveAttribute("data-nr-density", "compact");

    await changeSettings(page, (screen) => checkbox(screen, "Compact mode").check());
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "auto-hide");

    await changeSettings(page, (screen) => checkbox(screen, "Keep sidebar open").check());
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "docked");

    await changeSettings(page, (screen) => radio(screen, "On top").check());
    await expect(tabBar(page)).toBeVisible();

    const text = await expectCommentsKept(page);
    expect(JSON.parse(text.replace(/\/\/.*|\/\*[\s\S]*?\*\/|,(\s*[}\]])/g, "$1"))).toMatchObject({
      appearance: {
        sidebar: { position: "right", width: 300, compact: true, keepOpen: true },
        density: "compact",
        tabs: "top",
      },
    });
    expect(await samePage(page)).toBe(true);
  });

  test("a mode switched from the palette shows in the screen, and the other way round", async ({
    page,
  }) => {
    await start(page);
    await runAction(page, "Toggle tabs on top");
    await expect(tabBar(page)).toBeVisible();
    await changeSettings(page, async (screen) => {
      await expect(radio(screen, "On top")).toBeChecked();
      await radio(screen, "In the sidebar").check();
    });
    await expect(tabBar(page)).toHaveCount(0);
    await runAction(page, "Switch sidebar side");
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");
    await expectCommentsKept(page);
  });
});

test("the shortcuts screen lists the layout actions without a key", async ({ page }) => {
  await start(page);
  const shortcuts = await openShortcutsScreen(page);
  for (const title of [
    "Switch sidebar side",
    "Widen sidebar",
    "Narrow sidebar",
    "Switch density",
    "Toggle compact mode",
    "Toggle keep sidebar open",
    "Toggle tabs on top",
  ]) {
    await expect(shortcuts.getByLabel(`Shortcut for ${title}`, { exact: true })).toHaveText("None");
  }
});
