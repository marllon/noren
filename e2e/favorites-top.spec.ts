import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { GLASS_GAP, configText, seedConfig } from "./settings-fixture";
import {
  ACTIONS_CWD,
  ACTIONS_TEXT,
  clicksReachThePage,
  seedActionsFile,
  seedSidebarState,
} from "./sidebar-fixture";
import { openCommandPalette } from "./palette-fixture";

// The Favorites bar at the top of the window (NOR-F20-11c): `appearance.favorites` is "sidebar" (the
// bar is the top of the sidebar, as in 11a and 11b) or "top" (the bar leaves the sidebar and takes a
// bar of its own above the terminal, under the tab bar when the tabs are on top too). It is chosen
// in the Appearance section of the settings screen or from the palette, kept in `config.jsonc`, and
// the bar is the same bar there: the three kinds of tile, the line that teaches, the drag, the right
// click and axe. The seeded sidebar: Main (folder `/srv/proj`, with the actions "Loop" and "Dev
// server") with pinned "notes", the group "Work" (api, build, logs), "deploy" and "scratch"; the
// space "Other" with the tab "elsewhere"; the profiles of the machine are "Fake shell" and
// "PowerShell".

const WEB_STATE_KEY = "noren.web.state";

interface Hook {
  paneIds(): string[];
  lines(): string[];
  sessionStarts(): { profileId?: string }[];
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

interface Words {
  lang: "en" | "pt-BR";
  region: string;
  hint: string;
  add: string;
  remove: string;
  settings: string;
  close: string;
  /** The row of the settings screen and its two choices. */
  row: string;
  inSidebar: string;
  onTop: string;
  command: string;
  profile: string;
  run: string;
  runButton: string;
}

const WORDS: Record<Words["lang"], Words> = {
  en: {
    lang: "en",
    region: "Favorites",
    hint: "Drag a tab here, or right-click a tab, an action, or a profile in the palette, and choose Add to favorites.",
    add: "Add to favorites",
    remove: "Remove from favorites",
    settings: "Settings",
    close: "Close",
    row: "Favorites bar",
    inSidebar: "Sidebar",
    onTop: "Top of window",
    command: "Toggle favorites bar on top",
    profile: "New PowerShell tab",
    run: "Run Dev server",
    runButton: "Run",
  },
  "pt-BR": {
    lang: "pt-BR",
    region: "Favoritos",
    hint: "Arraste uma aba até aqui, ou clique com o botão direito numa aba, numa ação ou num perfil da paleta e escolha Adicionar aos favoritos.",
    add: "Adicionar aos favoritos",
    remove: "Remover dos favoritos",
    settings: "Configurações",
    close: "Fechar",
    row: "Barra de favoritos",
    inSidebar: "Barra lateral",
    onTop: "Topo da janela",
    command: "Alternar a barra de favoritos no topo",
    profile: "Nova aba PowerShell",
    run: "Executar Dev server",
    runButton: "Executar",
  },
};

type Mode = "dark" | "light";
const THEME: Record<Mode, string> = { dark: "noren-dusk", light: "noren-paper" };

const PROFILES = [
  { id: "fake", name: "Fake shell", default: true },
  { id: "pwsh", name: "PowerShell", default: false },
];

const DEV_LINK = { kind: "action", spaceId: "s1", actionId: "dev", label: "Dev server" };
const PWSH_LINK = { kind: "profile", profileId: "pwsh", label: "PowerShell" };

const bar = (page: Page) => page.locator('[data-nr-part="favorites"]');
const hint = (page: Page) => page.locator('[data-nr-part="favorites-hint"]');
const tiles = (page: Page) => bar(page).locator('[data-nr-part="favorite"]');
const tile = (page: Page, name: string) => bar(page).getByRole("button", { name, exact: true });
const sidebar = (page: Page) => page.locator('[data-nr-part="sidebar"]');
const tabBar = (page: Page) => page.locator('[data-nr-part="tabbar"]');
// The whole bar of tabs, edge to edge (the part above is the row of tabs inside it).
const tabBarFrame = (page: Page) => page.locator("nav.tab-bar");
// The terminal area and the tree have a name in each language; these do not depend on it.
const content = (page: Page) => page.locator("section.content");
const tree = (page: Page) => sidebar(page).getByRole("tree");
const treeRow = (page: Page, name: string) =>
  tree(page).getByRole("treeitem", { name, exact: true });
const barTab = (page: Page, name: string) => tabBar(page).getByRole("tab", { name, exact: true });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const dialog = (page: Page) => page.getByRole("alertdialog");
const spaceButton = (page: Page, name: string) =>
  page.locator('[data-nr-part="space-switcher"]').getByRole("button", { name, exact: true });

/** What `state.json` holds, as the web backend keeps it. */
async function saved(page: Page): Promise<{
  favorites: string[];
  favoriteLinks?: { kind: string }[];
}> {
  const text = await page.evaluate((key) => window.localStorage.getItem(key), WEB_STATE_KEY);
  return JSON.parse(text ?? "{}");
}

const sessionStarts = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts() ?? []);
const typed = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines().join("\n") ?? "");

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("element not on screen");
  return found;
}

interface StartOptions {
  mode?: Mode;
  /** `appearance.favorites` in the file; left out when `undefined` (the default, the sidebar). */
  place?: "sidebar" | "top";
  /** `appearance.tabs` "top": the tab bar above the terminal. */
  tabsTop?: boolean;
  /** `appearance.sidebar.compact`. */
  compact?: boolean;
  /** `appearance.density` "compact". */
  denseRows?: boolean;
  /** Ids of favorite tabs and the favorite profiles and actions the state already holds. */
  favorites?: string[];
  links?: object[];
}

/** Starts the page in a language and a theme with the seeded sidebar and the file the options say. */
async function start(page: Page, lang: Words["lang"], options: StartOptions = {}): Promise<Words> {
  const appearance: Record<string, unknown> = { theme: THEME[options.mode ?? "dark"] };
  if (options.place !== undefined) appearance["favorites"] = options.place;
  if (options.tabsTop === true) appearance["tabs"] = "top";
  if (options.denseRows === true) appearance["density"] = "compact";
  if (options.compact === true) appearance["sidebar"] = { compact: true };
  await seedConfig(
    page,
    JSON.stringify({ ...(lang === "pt-BR" ? { language: "pt-BR" } : {}), appearance }),
  );
  await page.addInitScript((profiles) => {
    window.localStorage.setItem("noren.web.profiles", JSON.stringify(profiles));
  }, PROFILES);
  await seedSidebarState(page, { cwd: ACTIONS_CWD, secondSpace: true });
  await seedActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
  if (options.favorites !== undefined || options.links !== undefined) {
    // Patches the state the first time only: a reload in a test must find what the page saved.
    await page.addInitScript(
      ({ key, favorites, links }) => {
        if (window.localStorage.getItem("seed-patched") !== null) return;
        window.localStorage.setItem("seed-patched", "yes");
        const state = JSON.parse(window.localStorage.getItem(key) ?? "{}") as {
          favorites?: string[];
          favoriteLinks?: object[];
        };
        if (favorites !== undefined) state.favorites = favorites;
        if (links !== undefined) state.favoriteLinks = links;
        window.localStorage.setItem(key, JSON.stringify(state));
      },
      { key: WEB_STATE_KEY, favorites: options.favorites, links: options.links },
    );
  }
  await page.goto("/");
  await expect(options.tabsTop === true ? barTab(page, "api") : treeRow(page, "api")).toBeVisible();
  return WORDS[lang];
}

/** Presses on `source` and drags it over the middle of `over`; the caller drops with the mouse. */
async function dragTo(page: Page, source: Locator, over: Locator): Promise<void> {
  const from = await box(source);
  const to = await box(over);
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 10, { steps: 3 });
  await page.mouse.move(end.x, end.y, { steps: 20 });
}

/** Opens the settings screen of a language. */
async function openSettings(page: Page, words: Words): Promise<Locator> {
  await page.getByRole("button", { name: words.settings, exact: true }).click();
  const screen = page.getByRole("dialog", { name: words.settings, exact: true });
  await expect(screen).toBeVisible();
  return screen;
}

async function closeSettings(page: Page, words: Words): Promise<void> {
  const screen = page.getByRole("dialog", { name: words.settings, exact: true });
  await screen.getByRole("button", { name: words.close, exact: true }).click();
  await expect(screen).toHaveCount(0);
}

/** Right click on a tab of the tree, then the item that makes it a favorite. */
async function addFavorite(page: Page, name: string, words: Words): Promise<void> {
  await treeRow(page, name).click({ button: "right" });
  await menuItem(page, words.add).click();
  await expect(tile(page, name)).toBeVisible();
}

/** The bar is the one at the top of the window: out of the sidebar, above the terminal. */
async function expectOnTop(page: Page): Promise<void> {
  await expect(bar(page)).toHaveCount(1);
  await expect(bar(page)).toHaveAttribute("data-nr-placement", "top");
  await expect(sidebar(page).locator('[data-nr-part="favorites"]')).toHaveCount(0);
  const above = await box(bar(page));
  const under = await box(content(page));
  expect(above.y + above.height).toBeLessThanOrEqual(under.y + 1);
  // The same width as the terminal below it: edge to edge of the column.
  expect(above.x).toBeCloseTo(under.x, 0);
  expect(above.width).toBeCloseTo(under.width, 0);
}

/** The bar is the one at the top of the sidebar, and there is no other. */
async function expectInSidebar(page: Page): Promise<void> {
  await expect(bar(page)).toHaveCount(1);
  await expect(bar(page)).toHaveAttribute("data-nr-placement", "sidebar");
  await expect(sidebar(page).locator('[data-nr-part="favorites"]')).toHaveCount(1);
}

for (const lang of ["en", "pt-BR"] as const) {
  test(`choosing the top of the window in the settings takes the bar out of the sidebar, writes only that setting and stays after a reload (${lang})`, async ({
    page,
  }) => {
    const words = await start(page, lang);
    await expectInSidebar(page);
    await expect(hint(page)).toBeVisible();

    const screen = await openSettings(page, words);
    const group = screen.getByRole("group", { name: words.row, exact: true });
    await group.scrollIntoViewIfNeeded();
    // The sidebar is the choice in force until another is made.
    await expect(group.getByRole("radio", { name: words.inSidebar, exact: true })).toBeChecked();
    await expect(group.getByRole("radio", { name: words.onTop, exact: true })).not.toBeChecked();
    const before = (await configText(page)) ?? "";
    await group.getByRole("radio", { name: words.onTop, exact: true }).check();
    await expect.poll(() => configText(page)).toContain('"favorites": "top"');
    // Only that setting went into the file: the rest of it is what it was.
    const written = (await configText(page)) ?? "";
    expect(written.replace(/,?\s*"favorites": "top",?/, "")).toEqual(
      before.replace(/,?\s*"favorites": "top",?/, ""),
    );
    await closeSettings(page, words);

    await expectOnTop(page);
    await expect(hint(page)).toBeVisible();
    await expect(hint(page)).toHaveText(words.hint);
    await expect(page.getByRole("region", { name: words.region, exact: true })).toBeVisible();

    // The same after a reload, and the screen shows the choice that is in force.
    await page.reload();
    await expect(treeRow(page, "api")).toBeVisible();
    await expectOnTop(page);
    const again = await openSettings(page, words);
    const row = again.getByRole("group", { name: words.row, exact: true });
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByRole("radio", { name: words.onTop, exact: true })).toBeChecked();

    // And back: the bar returns to the top of the sidebar, and the file says so.
    await row.getByRole("radio", { name: words.inSidebar, exact: true }).check();
    await expect.poll(() => configText(page)).toContain('"favorites": "sidebar"');
    await closeSettings(page, words);
    await expectInSidebar(page);
    await page.reload();
    await expect(treeRow(page, "api")).toBeVisible();
    await expectInSidebar(page);
  });
}

for (const place of [undefined, "sidebar"] as const) {
  test(`the bar is in the sidebar when the file says ${place === undefined ? "nothing" : '"sidebar"'}, inside its edges and above the actions`, async ({
    page,
  }) => {
    await start(page, "en", place === undefined ? {} : { place });
    await expectInSidebar(page);
    const side = await box(sidebar(page));
    const at = await box(bar(page));
    expect(at.x).toBeGreaterThanOrEqual(side.x);
    expect(at.x + at.width).toBeLessThanOrEqual(side.x + side.width);
    const header = await box(sidebar(page).locator('[data-nr-part="projects"]'));
    expect(at.y + at.height).toBeLessThanOrEqual(header.y);
    // The terminal is the whole column beside the sidebar, with no bar over it.
    const terminal = await box(content(page));
    expect(terminal.y).toBeLessThanOrEqual(side.y + 40);
  });
}

test("the bar on top is above the terminal, edge to edge, with its line on one row and nothing cut", async ({
  page,
}) => {
  await start(page, "en", { place: "top" });
  await expectOnTop(page);
  const overflow = await hint(page).evaluate((node) => ({
    wide: node.scrollWidth > node.clientWidth,
    tall: node.scrollHeight > node.clientHeight,
    height: node.getBoundingClientRect().height,
  }));
  expect(overflow.wide).toBe(false);
  expect(overflow.tall).toBe(false);
  // A wide bar holds the line on one row: the bar is about as tall as one with tiles.
  expect(overflow.height).toBeLessThan(40);
  const bounds = await box(bar(page));
  expect(bounds.height).toBeLessThan(56);
  // The sidebar is the sidebar of always: the tree, the actions, the switcher, no favorites.
  await expect(tree(page)).toBeVisible();
  await expect(sidebar(page).locator('[data-nr-part="projects"]')).toBeVisible();
  // It is the bar of every space, not of one.
  await spaceButton(page, "Other").click();
  await expect(treeRow(page, "elsewhere")).toBeVisible();
  await expect(hint(page)).toBeVisible();
  await expectOnTop(page);
});

test("the bar on top holds the three kinds of tile, in the order of the sidebar's, and each one works", async ({
  page,
}) => {
  const words = await start(page, "en", {
    place: "top",
    favorites: ["i6", "i5"],
    links: [PWSH_LINK, DEV_LINK],
  });
  await expectOnTop(page);
  await expect(hint(page)).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(4);
  // The favorite tabs first, then the profiles and actions as they were added.
  await expect(tiles(page).nth(0)).toHaveAttribute("data-nr-kind", "tab");
  await expect(tiles(page).nth(1)).toHaveAttribute("data-nr-kind", "tab");
  await expect(tiles(page).nth(2)).toHaveAttribute("data-nr-kind", "profile");
  await expect(tiles(page).nth(3)).toHaveAttribute("data-nr-kind", "action");
  // One row of tiles on a wide bar.
  const first = await box(tiles(page).first());
  const last = await box(tiles(page).last());
  expect(last.y).toBe(first.y);
  expect(last.x).toBeGreaterThan(first.x);

  // A tab: a click shows it.
  await tile(page, "deploy").click();
  await expect(tile(page, "deploy")).toHaveAttribute("aria-current", "true");
  await expect(treeRow(page, "deploy")).toHaveAttribute("aria-current", "true");

  // A profile: a click opens a new tab that starts it.
  const count = await tree(page).getByRole("treeitem").count();
  await tile(page, words.profile).click();
  await expect(tree(page).getByRole("treeitem")).toHaveCount(count + 1);
  await expect
    .poll(async () => (await sessionStarts(page)).map((start) => start.profileId))
    .toContain("pwsh");

  // An action: the first run asks, and then the command is typed once in the tab it names.
  await tile(page, words.run).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator("pre")).toHaveText("pnpm dev");
  await dialog(page).getByRole("button", { name: words.runButton, exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(treeRow(page, "dev")).toBeVisible();
  await expect.poll(() => typed(page)).toContain("pnpm dev");
  await expect(tile(page, "Show Dev server")).toHaveAttribute("data-nr-state", "running");

  // The right click of any tile takes it out, whatever its kind.
  for (const kind of ["profile", "action", "tab", "tab"]) {
    const before = await tiles(page).count();
    await bar(page)
      .locator(`[data-nr-part="favorite"][data-nr-kind="${kind}"]`)
      .first()
      .click({ button: "right" });
    await menuItem(page, words.remove).click();
    await expect(tiles(page)).toHaveCount(before - 1);
  }
  await expect(hint(page)).toBeVisible();
  await expect.poll(async () => (await saved(page)).favorites).toEqual([]);
  await expect.poll(async () => (await saved(page)).favoriteLinks).toEqual([]);
});

for (const lang of ["en", "pt-BR"] as const) {
  test(`the right click of a tab adds it to the bar on top and the right click of a tile removes it, across reloads (${lang})`, async ({
    page,
  }) => {
    const words = await start(page, lang, { place: "top" });
    await expect(hint(page)).toBeVisible();

    await addFavorite(page, "scratch", words);
    await addFavorite(page, "deploy", words);
    await expect(hint(page)).toHaveCount(0);
    await expect(tiles(page)).toHaveCount(2);
    await expect.poll(async () => (await saved(page)).favorites).toEqual(["i6", "i5"]);
    // The menu of a tab that is one already offers to remove it, and no tile is added twice.
    await treeRow(page, "scratch").click({ button: "right" });
    await expect(menuItem(page, words.remove)).toBeVisible();
    await expect(menuItem(page, words.add)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(tiles(page)).toHaveCount(2);

    await page.reload();
    await expectOnTop(page);
    await expect(tile(page, "scratch")).toBeVisible();
    await expect(tile(page, "deploy")).toBeVisible();

    // A tile removes: only that one goes, the tab stays, and the last one brings the line back.
    await tile(page, "scratch").click({ button: "right" });
    await expect(menuItem(page, words.remove)).toBeVisible();
    // The menu opens next to the pointer, on screen, over the tile's bar and not behind it.
    const menu = await box(page.getByRole("menu"));
    const target = await box(tile(page, "scratch"));
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.y).toBeGreaterThanOrEqual(target.y);
    await menuItem(page, words.remove).click();
    await expect(tile(page, "scratch")).toHaveCount(0);
    await expect(treeRow(page, "scratch")).toBeVisible();
    await expect.poll(async () => (await saved(page)).favorites).toEqual(["i5"]);
    await tile(page, "deploy").click({ button: "right" });
    await menuItem(page, words.remove).click();
    await expect(tiles(page)).toHaveCount(0);
    await expect(hint(page)).toHaveText(words.hint);
    await expect.poll(async () => (await saved(page)).favorites).toEqual([]);

    await page.reload();
    await expectOnTop(page);
    await expect(hint(page)).toBeVisible();
    await expect(tiles(page)).toHaveCount(0);
  });
}

test("a tab dragged onto the bar on top becomes a favorite, and the bar takes no room when the drag starts", async ({
  page,
}) => {
  await start(page, "en", { place: "top" });
  const barBox = await box(bar(page));
  const contentBox = await box(content(page));
  const before = await box(treeRow(page, "scratch"));

  await dragTo(page, treeRow(page, "deploy"), bar(page));
  await expect(bar(page)).toHaveAttribute("data-nr-state", "over");
  // Nothing moved under the pointer: the bar, the terminal and the neighbor tab are where they were.
  expect(await box(bar(page))).toEqual(barBox);
  expect(await box(content(page))).toEqual(contentBox);
  expect((await box(treeRow(page, "scratch"))).y).toBe(before.y);
  // The line is still there until the tab lands.
  await expect(hint(page)).toBeVisible();
  await page.mouse.up();
  await expect(tile(page, "deploy")).toBeVisible();
  await expect(hint(page)).toHaveCount(0);
  await expect(bar(page)).not.toHaveAttribute("data-nr-state", "over");
  await expect.poll(async () => (await saved(page)).favorites).toEqual(["i5"]);
  // The tab stays in the tree, and the same after a reload.
  await expect(treeRow(page, "deploy")).toBeVisible();
  await page.reload();
  await expect(treeRow(page, "api")).toBeVisible();
  await expect(tile(page, "deploy")).toBeVisible();
  await expectOnTop(page);

  // A tab already a favorite does not light the bar again; one dropped elsewhere is no favorite.
  await dragTo(page, treeRow(page, "deploy"), bar(page));
  await expect(bar(page)).not.toHaveAttribute("data-nr-state", "over");
  await page.mouse.up();
  await clicksReachThePage(page);
  expect((await saved(page)).favorites).toEqual(["i5"]);
  await dragTo(page, treeRow(page, "scratch"), treeRow(page, "build"));
  await expect(bar(page)).not.toHaveAttribute("data-nr-state", "over");
  await page.mouse.up();
  await clicksReachThePage(page);
  expect((await saved(page)).favorites).toEqual(["i5"]);
});

test("the keyboard drag reaches the bar on top too", async ({ page }) => {
  await start(page, "en", { place: "top" });
  const status = page.locator('[data-nr-part="drop-status"]');
  await treeRow(page, "scratch").focus();
  await page.keyboard.press("Space");
  await expect(page.locator('[data-nr-part="drag-ghost"]')).toBeVisible();
  await page.evaluate(() => new Promise<void>((done) => setTimeout(done)));
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText("Pin this tab.");
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText("Add this tab to the favorites.");
  await expect(bar(page)).toHaveAttribute("data-nr-state", "over");
  await page.keyboard.press("Space");
  await expect(tile(page, "scratch")).toBeVisible();
  await expect.poll(async () => (await saved(page)).favorites).toEqual(["i6"]);
});

test("with the tabs on top too the two bars are at the top of the window, one under the other, and overlap nothing", async ({
  page,
}) => {
  const words = await start(page, "en", {
    place: "top",
    tabsTop: true,
    favorites: ["i6"],
    links: [PWSH_LINK, DEV_LINK],
  });
  await expectOnTop(page);
  await expect(tabBar(page)).toBeVisible();
  const tabs = await box(tabBarFrame(page));
  const favorites = await box(bar(page));
  const terminal = await box(content(page));
  // The tab bar first, the favorites bar under it, the terminal under both; same width.
  expect(tabs.y + tabs.height).toBeLessThanOrEqual(favorites.y + 1);
  expect(favorites.y + favorites.height).toBeLessThanOrEqual(terminal.y + 1);
  expect(favorites.x).toBeCloseTo(tabs.x, 0);
  expect(favorites.width).toBeCloseTo(tabs.width, 0);
  // The sidebar is out of the layout (it hides with top tabs), so it covers neither bar.
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  const side = await box(sidebar(page));
  expect(side.x + side.width).toBeLessThanOrEqual(favorites.x + 1);
  // Every tile is inside the bar and the bar's row of tiles does not touch the tab bar's.
  for (const index of [0, 1, 2]) {
    const one = await box(tiles(page).nth(index));
    expect(one.y).toBeGreaterThanOrEqual(favorites.y);
    expect(one.y + one.height).toBeLessThanOrEqual(favorites.y + favorites.height);
    expect(one.x + one.width).toBeLessThanOrEqual(favorites.x + favorites.width);
  }
  // The tabs of the tab bar are not dragged (they never were: only the sidebar tree is), so the right
  // click of one is how it joins the bar, and a tile removes it, with the sidebar staying where it
  // is: the menu does not come from it.
  await barTab(page, "build").click({ button: "right" });
  await menuItem(page, words.add).click();
  await expect(tile(page, "build")).toBeVisible();
  await expect.poll(async () => (await saved(page)).favorites).toEqual(["i6", "i3"]);
  await tile(page, "build").click({ button: "right" });
  await expect(menuItem(page, words.remove)).toBeVisible();
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  await menuItem(page, words.remove).click();
  await expect(tile(page, "build")).toHaveCount(0);
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  // Without the choice, the same file has the bar in the (hidden) sidebar and none on top.
});

test("the tabs on top alone keep the bar in the hidden sidebar, off the screen", async ({
  page,
}) => {
  await start(page, "en", { tabsTop: true, favorites: ["i6"] });
  await expectInSidebar(page);
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  await expect(bar(page)).not.toBeInViewport();
  // Moving it on top brings it onto the screen, under the tab bar.
  await page.evaluate(
    (text) => (window as HookWindow).__norenTest?.setConfig(text),
    JSON.stringify({ appearance: { tabs: "top", favorites: "top" } }),
  );
  await expectOnTop(page);
  await expect(bar(page)).toBeInViewport();
  await expect(tile(page, "scratch")).toBeVisible();
});

test("in compact mode the bar on top stays on screen across the window while the sidebar hides, and the sidebar slides over it without moving it", async ({
  page,
}) => {
  await start(page, "en", {
    place: "top",
    compact: true,
    favorites: ["i6"],
    links: [DEV_LINK],
  });
  await expectOnTop(page);
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  await expect(sidebar(page).locator('[data-nr-part="favorites"]')).toHaveCount(0);
  const full = await box(bar(page));
  const viewport = page.viewportSize();
  // Across the window: one gap of the glass style from each edge.
  expect(full.x).toBeCloseTo(GLASS_GAP, 0);
  expect(full.width).toBeCloseTo((viewport?.width ?? 0) - 2 * GLASS_GAP, 0);
  await expect(bar(page)).toBeInViewport({ ratio: 1 });
  // A tile works with the sidebar hidden, and its menu does not bring the sidebar out.
  await tile(page, "scratch").click();
  await expect(tile(page, "scratch")).toHaveAttribute("aria-current", "true");
  await tile(page, "scratch").click({ button: "right" });
  await expect(menuItem(page, "Remove from favorites")).toBeVisible();
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  // The question before the first run of an action, asked from its tile, does not bring it out either.
  await tile(page, "Run Dev server").click();
  await expect(dialog(page)).toBeVisible();
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  // The pointer on the edge brings the sidebar over the terminal and the bar; the bar does not move.
  await page.mouse.move(2, 400);
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "revealed");
  expect(await box(bar(page))).toEqual(full);
  await expect(sidebar(page).locator('[data-nr-part="favorites"]')).toHaveCount(0);
  // The same file with the bar in the sidebar has it in the hidden sidebar, off the screen.
});

test("in compact mode the bar in the sidebar is still in the hidden sidebar: only the choice brings it out", async ({
  page,
}) => {
  await start(page, "en", { compact: true });
  await expectInSidebar(page);
  await expect(bar(page)).not.toBeInViewport();
});

test("the compact density makes the bar on top thinner, and the line still fits", async ({
  page,
}) => {
  await start(page, "en", { place: "top" });
  const comfortable = (await box(bar(page))).height;
  // The file changes under the open window, as an edit by another program does.
  await page.evaluate(
    (text) => (window as HookWindow).__norenTest?.setConfig(text),
    JSON.stringify({ appearance: { favorites: "top", density: "compact" } }),
  );
  await expect(page.locator(".app-body")).toHaveAttribute("data-nr-density", "compact");
  const dense = (await box(bar(page))).height;
  expect(dense).toBeLessThan(comfortable);
  const fits = await hint(page).evaluate((node) => ({
    wide: node.scrollWidth > node.clientWidth,
    tall: node.scrollHeight > node.clientHeight,
  }));
  expect(fits).toEqual({ wide: false, tall: false });
  await expectOnTop(page);
});

test("a narrow window wraps the tiles of the bar on top onto more rows and hides none", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 700 });
  await start(page, "en", {
    place: "top",
    favorites: ["i1", "i2", "i3", "i4", "i5", "i6"],
    links: [PWSH_LINK, DEV_LINK],
  });
  await expect(tiles(page)).toHaveCount(8);
  const at = await box(bar(page));
  const rows = new Set<number>();
  for (let index = 0; index < 8; index++) {
    const one = await box(tiles(page).nth(index));
    rows.add(Math.round(one.y));
    expect(one.x).toBeGreaterThanOrEqual(at.x);
    expect(one.x + one.width).toBeLessThanOrEqual(at.x + at.width + 0.5);
    expect(one.y + one.height).toBeLessThanOrEqual(at.y + at.height + 0.5);
  }
  expect(rows.size).toBeGreaterThan(1);
  const scrolls = await bar(page).evaluate((node) => node.scrollWidth > node.clientWidth);
  expect(scrolls).toBe(false);
  // The terminal is under the taller bar, not covered by it.
  const under = await box(content(page));
  expect(at.y + at.height).toBeLessThanOrEqual(under.y + 1);
});

for (const lang of ["en", "pt-BR"] as const) {
  test(`the palette command moves the bar between the sidebar and the top, and writes only that setting (${lang})`, async ({
    page,
  }) => {
    const words = await start(page, lang);
    await expectInSidebar(page);
    const before = (await configText(page)) ?? "";
    await openCommandPalette(page);
    await palette(page).getByRole("combobox").fill(`>${words.command}`);
    await expect(palette(page).getByRole("option").first()).toContainText(words.command);
    await page.keyboard.press("Enter");
    await expect(palette(page)).toBeHidden();
    await expectOnTop(page);
    await expect.poll(() => configText(page)).toContain('"favorites": "top"');
    const written = (await configText(page)) ?? "";
    expect(written.replace(/,?\s*"favorites": "top",?/, "")).toEqual(
      before.replace(/,?\s*"favorites": "top",?/, ""),
    );

    await openCommandPalette(page);
    await palette(page).getByRole("combobox").fill(`>${words.command}`);
    await expect(palette(page).getByRole("option").first()).toContainText(words.command);
    await page.keyboard.press("Enter");
    await expect(palette(page)).toBeHidden();
    await expectInSidebar(page);
    await expect.poll(() => configText(page)).toContain('"favorites": "sidebar"');
  });
}

test("a change of the file by another program moves the bar, and a value the schema refuses leaves it where it was", async ({
  page,
}) => {
  await start(page, "en", { favorites: ["i6"] });
  await expectInSidebar(page);
  const set = (text: string | null) =>
    page.evaluate((value) => (window as HookWindow).__norenTest?.setConfig(value), text);
  await set('{ "appearance": { "favorites": "top" } }');
  await expectOnTop(page);
  await expect(tile(page, "scratch")).toBeVisible();
  // A value that is not one of the two is refused: the bar stays where it is, with its tiles.
  await set('{ "appearance": { "favorites": "bottom" } }');
  await page.waitForTimeout(300);
  await expectOnTop(page);
  await expect(tile(page, "scratch")).toBeVisible();
  await set('{ "appearance": { "favorites": "sidebar" } }');
  await expectInSidebar(page);
  await set(null);
  await expectInSidebar(page);
});

for (const lang of ["en", "pt-BR"] as const) {
  for (const mode of ["dark", "light"] as const) {
    test(`axe: the empty bar on top has no violation (${lang}, ${mode})`, async ({ page }) => {
      await start(page, lang, { place: "top", mode });
      await expectOnTop(page);
      await expect(hint(page)).toBeVisible();
      await expectNoAxeViolations(page, `the empty favorites bar on top, ${lang}, ${mode}`);
    });

    test(`axe: the bar on top with the three kinds of tile has no violation (${lang}, ${mode})`, async ({
      page,
    }) => {
      await start(page, lang, {
        place: "top",
        mode,
        favorites: ["i6", "i5"],
        links: [PWSH_LINK, DEV_LINK],
      });
      await expectOnTop(page);
      await expect(tiles(page)).toHaveCount(4);
      await tiles(page).first().click();
      await expectNoAxeViolations(page, `the favorites bar on top with tiles, ${lang}, ${mode}`);
    });

    test(`axe: the two bars on top, the tab bar and the favorites bar, have no violation (${lang}, ${mode})`, async ({
      page,
    }) => {
      await start(page, lang, {
        place: "top",
        tabsTop: true,
        mode,
        favorites: ["i6"],
        links: [PWSH_LINK, DEV_LINK],
      });
      await expectOnTop(page);
      await expect(tabBarFrame(page)).toBeVisible();
      await expect(tiles(page)).toHaveCount(3);
      await expectNoAxeViolations(page, `both bars on top, ${lang}, ${mode}`);
    });

    test(`axe: the menu of a tile of the bar on top has no violation (${lang}, ${mode})`, async ({
      page,
    }) => {
      const words = await start(page, lang, { place: "top", mode, favorites: ["i6"] });
      await expectOnTop(page);
      await tile(page, "scratch").click({ button: "right" });
      await expect(menuItem(page, words.remove)).toBeVisible();
      await expectNoAxeViolations(page, `the menu of a tile on top, ${lang}, ${mode}`);
    });

    test(`axe: the Favorites bar choice of the settings has no violation (${lang}, ${mode})`, async ({
      page,
    }) => {
      const words = await start(page, lang, { mode });
      const screen = await openSettings(page, words);
      const group = screen.getByRole("group", { name: words.row, exact: true });
      await group.scrollIntoViewIfNeeded();
      await expect(group.getByRole("radio")).toHaveCount(2);
      await expectNoAxeViolations(page, `the settings, favorites bar choice, ${lang}, ${mode}`);
    });
  }
}
