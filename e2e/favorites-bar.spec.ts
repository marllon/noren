import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { seedConfig } from "./settings-fixture";
import { clicksReachThePage, seedSidebarState } from "./sidebar-fixture";

// The Favorites bar of NOR-F20-11a: always on screen at the top of the sidebar, with a line that
// teaches how to fill it while it is empty, filled by dragging a tab onto it and by the right click
// of a tab, emptied by the right click of a tile, and the same after a reload. The seeded sidebar:
// Main with pinned "notes", the group "Work" (api, build, logs), "deploy" and "scratch"; the space
// "Other" with the tab "elsewhere". (`favorites.spec.ts` holds the rest of what favorites do.)

const WEB_STATE_KEY = "noren.web.state";

interface Words {
  lang: "en" | "pt-BR";
  region: string;
  hint: string;
  add: string;
  remove: string;
}

const WORDS: Record<Words["lang"], Words> = {
  en: {
    lang: "en",
    region: "Favorites",
    hint: "Drag a tab here, or right-click a tab, an action, or a profile in the palette, and choose Add to favorites.",
    add: "Add to favorites",
    remove: "Remove from favorites",
  },
  "pt-BR": {
    lang: "pt-BR",
    region: "Favoritos",
    hint: "Arraste uma aba até aqui, ou clique com o botão direito numa aba, numa ação ou num perfil da paleta e escolha Adicionar aos favoritos.",
    add: "Adicionar aos favoritos",
    remove: "Remover dos favoritos",
  },
};

type Mode = "dark" | "light";
const THEME: Record<Mode, string> = { dark: "noren-dusk", light: "noren-paper" };

const bar = (page: Page) => page.locator('[data-nr-part="favorites"]');
const hint = (page: Page) => page.locator('[data-nr-part="favorites-hint"]');
const tiles = (page: Page) => bar(page).getByRole("button");
const tile = (page: Page, name: string) => bar(page).getByRole("button", { name, exact: true });
const row = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const sidebar = (page: Page) => page.locator('[data-nr-part="sidebar"]');
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });
const spaceButton = (page: Page, name: string) =>
  page.locator('[data-nr-part="space-switcher"]').getByRole("button", { name, exact: true });

/** The saved workspace, as the web backend keeps it. */
async function saved(page: Page): Promise<{ favorites: string[] }> {
  const text = await page.evaluate((key) => window.localStorage.getItem(key), WEB_STATE_KEY);
  return JSON.parse(text ?? "{}");
}

/** Starts the page in a language and a theme, with the seeded sidebar. */
async function start(page: Page, lang: Words["lang"], mode: Mode = "dark"): Promise<Words> {
  const language = lang === "pt-BR" ? '"language": "pt-BR", ' : "";
  await seedConfig(page, `{ ${language}"appearance": { "theme": "${THEME[mode]}" } }\n`);
  await seedSidebarState(page, { secondSpace: true });
  await page.goto("/");
  await expect(row(page, "api")).toBeVisible();
  return WORDS[lang];
}

/** Presses on `source` and drags it over the middle of `over`; the caller drops with the mouse. */
async function dragTo(page: Page, source: Locator, over: Locator): Promise<void> {
  const from = await source.boundingBox();
  const to = await over.boundingBox();
  if (!from || !to) throw new Error("not on screen");
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 10, { steps: 3 });
  await page.mouse.move(end.x, end.y, { steps: 20 });
}

/** Right click on a tab, then the item that makes it a favorite. */
async function addFavorite(page: Page, name: string, words: Words): Promise<void> {
  await row(page, name).click({ button: "right" });
  await menuItem(page, words.add).click();
  await expect(tile(page, name)).toBeVisible();
}

for (const lang of ["en", "pt-BR"] as const) {
  test(`with no favorite the bar is on screen and teaches how to add one (${lang})`, async ({
    page,
  }) => {
    const words = await start(page, lang);
    // The bar is a region of its own, named, and it holds the line and no tile.
    const region = page.getByRole("region", { name: words.region, exact: true });
    await expect(region).toBeVisible();
    await expect(bar(page)).toBeVisible();
    await expect(hint(page)).toBeVisible();
    await expect(hint(page)).toHaveText(words.hint);
    await expect(tiles(page)).toHaveCount(0);
    await expect(bar(page).getByRole("list")).toHaveCount(0);
    // It is the bar of every space, not of one: the other space has the same line.
    await spaceButton(page, "Other").click();
    await expect(row(page, "elsewhere")).toBeVisible();
    await expect(hint(page)).toHaveText(words.hint);
    // The other language's line is not there.
    const other = WORDS[lang === "en" ? "pt-BR" : "en"].hint;
    await expect(page.getByText(other, { exact: true })).toHaveCount(0);
  });
}

test("the bar is the first thing at the top of the sidebar, empty or not, and its line fits", async ({
  page,
}) => {
  const words = await start(page, "en");
  const inside = async (): Promise<void> => {
    const side = await sidebar(page).boundingBox();
    const box = await bar(page).boundingBox();
    const first = await page.getByRole("group", { name: "Pinned", exact: true }).boundingBox();
    if (!side || !box || !first) throw new Error("not on screen");
    // Inside the sidebar, at its padding from the top and from both edges, above the pinned list.
    // The glass sidebar has the brand and the search above the bar (the bar is the first of the
    // content under them, at the gap of the sidebar from the search); the dense one has nothing.
    const search = page.locator('[data-nr-part="sidebar-search"]');
    const searchBox = (await search.count()) > 0 ? await search.boundingBox() : null;
    const top = searchBox !== null ? searchBox.y + searchBox.height : side.y;
    expect(box.y).toBeGreaterThanOrEqual(side.y);
    expect(box.y - top).toBeLessThanOrEqual(16);
    expect(box.x).toBeGreaterThanOrEqual(side.x);
    expect(box.x + box.width).toBeLessThanOrEqual(side.x + side.width);
    expect(box.y + box.height).toBeLessThanOrEqual(first.y);
  };
  await inside();
  // The line wraps inside the bar: nothing is wider than the box, and the box is not taller than
  // a few lines.
  const overflow = await hint(page).evaluate((node) => ({
    wide: node.scrollWidth > node.clientWidth,
    tall: node.scrollHeight > node.clientHeight,
    height: node.getBoundingClientRect().height,
  }));
  expect(overflow.wide).toBe(false);
  expect(overflow.tall).toBe(false);
  expect(overflow.height).toBeLessThan(100);
  await addFavorite(page, "scratch", words);
  await inside();
  await expect(hint(page)).toHaveCount(0);
});

test("a drag does not move the tabs: the bar takes no room when it starts", async ({ page }) => {
  await start(page, "en");
  const before = await row(page, "scratch").boundingBox();
  const barBox = await bar(page).boundingBox();
  if (!before || !barBox) throw new Error("not on screen");
  await dragTo(page, row(page, "deploy"), bar(page));
  await expect(bar(page)).toHaveAttribute("data-nr-state", "over");
  // The tab next to the one dragged is exactly where it was, and so is the bar.
  const during = await row(page, "scratch").boundingBox();
  const barDuring = await bar(page).boundingBox();
  expect(during?.y).toBe(before.y);
  expect(barDuring).toEqual(barBox);
  await page.mouse.up();
});

test("dragging a tab onto the empty bar makes it a favorite, and it stays after a reload", async ({
  page,
}) => {
  await start(page, "en");
  await dragTo(page, row(page, "scratch"), bar(page));
  await expect(bar(page)).toHaveAttribute("data-nr-state", "over");
  // The line is still there until the tab lands.
  await expect(hint(page)).toBeVisible();
  await page.mouse.up();
  await expect(tile(page, "scratch")).toBeVisible();
  await expect(hint(page)).toHaveCount(0);
  await expect(bar(page)).not.toHaveAttribute("data-nr-state", "over");
  await expect.poll(async () => (await saved(page)).favorites).toEqual(["i6"]);
  // The tab stays in the tree.
  await expect(row(page, "scratch")).toBeVisible();

  await page.reload();
  await expect(row(page, "api")).toBeVisible();
  await expect(tile(page, "scratch")).toBeVisible();
  await expect(tiles(page)).toHaveCount(1);
  await expect(hint(page)).toHaveCount(0);
  expect((await saved(page)).favorites).toEqual(["i6"]);
});

test("a tab dropped anywhere but on the bar does not make it a favorite", async ({ page }) => {
  await start(page, "en");
  await dragTo(page, row(page, "scratch"), row(page, "deploy"));
  await expect(bar(page)).not.toHaveAttribute("data-nr-state", "over");
  await page.mouse.up();
  await clicksReachThePage(page);
  expect((await saved(page)).favorites).toEqual([]);
  await expect(hint(page)).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);
});

for (const lang of ["en", "pt-BR"] as const) {
  test(`the right click of a tab adds it and the right click of a tile removes it, across reloads (${lang})`, async ({
    page,
  }) => {
    const words = await start(page, lang);
    await expect(hint(page)).toBeVisible();

    // A tab adds: its tile is on the bar and the line is gone.
    await addFavorite(page, "scratch", words);
    await addFavorite(page, "deploy", words);
    await expect(hint(page)).toHaveCount(0);
    await expect(tiles(page)).toHaveCount(2);
    await expect.poll(async () => (await saved(page)).favorites).toEqual(["i6", "i5"]);
    // The menu of a tab that is one already offers to remove it, and no tile is added twice.
    await row(page, "scratch").click({ button: "right" });
    await expect(menuItem(page, words.remove)).toBeVisible();
    await expect(menuItem(page, words.add)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(tiles(page)).toHaveCount(2);

    await page.reload();
    await expect(tile(page, "scratch")).toBeVisible();
    await expect(tile(page, "deploy")).toBeVisible();
    await expect(hint(page)).toHaveCount(0);

    // A tile removes: only that one goes, the tab stays, and the last one brings the line back.
    await tile(page, "scratch").click({ button: "right" });
    await menuItem(page, words.remove).click();
    await expect(tile(page, "scratch")).toHaveCount(0);
    await expect(tile(page, "deploy")).toBeVisible();
    await expect(row(page, "scratch")).toBeVisible();
    await expect.poll(async () => (await saved(page)).favorites).toEqual(["i5"]);

    await page.reload();
    await expect(tiles(page)).toHaveCount(1);
    await expect(tile(page, "deploy")).toBeVisible();

    await tile(page, "deploy").click({ button: "right" });
    await menuItem(page, words.remove).click();
    await expect(tiles(page)).toHaveCount(0);
    await expect(hint(page)).toBeVisible();
    await expect(hint(page)).toHaveText(words.hint);
    await expect.poll(async () => (await saved(page)).favorites).toEqual([]);

    await page.reload();
    await expect(row(page, "api")).toBeVisible();
    await expect(hint(page)).toBeVisible();
    await expect(tiles(page)).toHaveCount(0);
    expect((await saved(page)).favorites).toEqual([]);
  });
}

for (const lang of ["en", "pt-BR"] as const) {
  for (const mode of ["dark", "light"] as const) {
    test(`axe: the empty bar has no violation (${lang}, ${mode})`, async ({ page }) => {
      await start(page, lang, mode);
      await expect(hint(page)).toBeVisible();
      await expectNoAxeViolations(page, `the empty favorites bar, ${lang}, ${mode}`);
    });

    test(`axe: the bar with favorites has no violation (${lang}, ${mode})`, async ({ page }) => {
      const words = await start(page, lang, mode);
      await addFavorite(page, "scratch", words);
      await addFavorite(page, "deploy", words);
      await tile(page, "scratch").click();
      await expect(tile(page, "scratch")).toHaveAttribute("aria-current", "true");
      await expectNoAxeViolations(page, `the favorites bar with favorites, ${lang}, ${mode}`);
    });

    test(`axe: the menus of the bar have no violation (${lang}, ${mode})`, async ({ page }) => {
      const words = await start(page, lang, mode);
      await row(page, "scratch").click({ button: "right" });
      await expect(menuItem(page, words.add)).toBeVisible();
      await expectNoAxeViolations(page, `the menu of a tab, ${lang}, ${mode}`);
      await menuItem(page, words.add).click();
      await tile(page, "scratch").click({ button: "right" });
      await expect(menuItem(page, words.remove)).toBeVisible();
      await expectNoAxeViolations(page, `the menu of a tile, ${lang}, ${mode}`);
    });
  }
}
