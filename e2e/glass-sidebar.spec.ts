import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { AGENT_STATES, start } from "./glass-sidebar-fixture";
import { configText, openSettings, settingsScreen } from "./settings-fixture";

// The content of the glass sidebar (NOR-F20-18b), part by part as in the design of the window
// (`vidro-janela`): the brand and the button that folds the sidebar, the search with the shortcut of the
// palette, the favorites as a grid of four with a state dot, the card of the project actions, the tree
// with a state dot and a second line (folder and branch) on every tab, and the foot with the New tab row,
// the spaces and the settings. What each part does (keyboard, mouse, drag, right click, what is saved) is
// what it did before: the specs of those parts run under this style and are not repeated here. The dense
// style does not change, and a test says so.

const side = (page: Page): Locator => page.locator('[data-nr-part="sidebar"]');
const part = (page: Page, name: string): Locator => side(page).locator(`[data-nr-part="${name}"]`);
const tile = (page: Page, name: string): Locator =>
  side(page).getByRole("button", { name, exact: true });
const row = (page: Page, title: string): Locator =>
  side(page).getByRole("treeitem", { name: title, exact: true });

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not on screen");
  return found;
};

/** One computed property of an element, or of its pseudo-element (`::before`). */
const style = (locator: Locator, property: string, pseudo?: string): Promise<string> =>
  locator.evaluate(
    (element, arg) => getComputedStyle(element, arg.pseudo ?? null).getPropertyValue(arg.property),
    { property, pseudo },
  );

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/** `#rrggbb` as the `rgb(r, g, b)` a computed style gives. */
function rgbOf(hexColor: string): string {
  const n = (from: number) => parseInt(hexColor.slice(from, from + 2), 16);
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
}

/** What nothing in the sidebar may do: leave the card, or be cut by it, at the width asked. */
async function expectNothingLeavesTheCard(page: Page): Promise<void> {
  const report = await side(page).evaluate((aside) => {
    const edge = aside.getBoundingClientRect();
    const outside: string[] = [];
    for (const element of aside.querySelectorAll("*")) {
      if (element.closest(".sr-only, [hidden], .sidebar-resize, .drop-zones") !== null) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > edge.right + 0.5 || rect.left < edge.left - 0.5) {
        outside.push(`${element.className || element.tagName} ${rect.left}-${rect.right}`);
      }
    }
    // The card is not a scroll box on the horizontal axis, and no row is wider than what holds it.
    const wide: string[] = [];
    for (const element of aside.querySelectorAll<HTMLElement>(
      ".tab-button, .group-button, .action-button, .favorite-button, .sidebar-search, .new-tab, .space-header, .sidebar-head",
    )) {
      if (element.scrollWidth > element.clientWidth + 1) {
        // A text cut by an ellipsis is inside its own box; the box itself must not overflow.
        wide.push(`${element.className} ${element.scrollWidth}>${element.clientWidth}`);
      }
    }
    // The list of tabs, the one box of the card that scrolls, does not scroll sideways.
    const list = aside.querySelector<HTMLElement>(".tab-list");
    return { outside, wide, scroll: list === null ? 0 : list.scrollWidth - list.clientWidth };
  });
  expect(report.outside, "elements that leave the sidebar card").toEqual([]);
  expect(report.wide, "boxes that overflow themselves").toEqual([]);
  expect(report.scroll, "the list of tabs scrolls sideways").toBeLessThanOrEqual(0);
}

test.describe("the head: the brand and the button that folds the sidebar", () => {
  test("the head is the first thing of the sidebar: the mark in the color of the space and the name", async ({
    page,
  }) => {
    await start(page);
    const head = part(page, "sidebar-head");
    await expect(head).toBeVisible();
    await expect(head).toContainText("noren");
    const sidebar = await box(side(page));
    const at = await box(head);
    // At the padding of the card (12 px) and a little of its own (2 px) from the top.
    expect(at.y - sidebar.y).toBeGreaterThanOrEqual(12);
    expect(at.y - sidebar.y).toBeLessThanOrEqual(16);
    // The mark is the highlight of the window: the color of the active space (the fixture's blue).
    const mark = part(page, "sidebar-head").locator(".sidebar-mark");
    expect(await style(mark, "background-color")).toBe("rgb(107, 138, 253)");
    expect(await style(mark, "border-top-left-radius")).toBe("7px");
    const markBox = await box(mark);
    expect([markBox.width, markBox.height]).toEqual([22, 22]);
    // And it follows the space: another space has another color.
    await expect(part(page, "sidebar-brand")).toBeVisible();
  });

  test("the mark takes the color of the space that is active", async ({ page }) => {
    await start(page, { secondSpace: true });
    const mark = part(page, "sidebar-head").locator(".sidebar-mark");
    expect(await style(mark, "background-color")).toBe("rgb(107, 138, 253)");
    await side(page).getByRole("button", { name: "Other", exact: true }).click();
    await expect(side(page).getByRole("button", { name: "Other", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // The amber of the second space of the fixture, #e0a458.
    await expect.poll(() => style(mark, "background-color")).toBe("rgb(224, 164, 88)");
  });

  test("the button is named, 28 px, and a click folds the sidebar: compact mode is written and the sidebar hides", async ({
    page,
  }) => {
    await start(page);
    const collapse = side(page).getByRole("button", { name: "Collapse the sidebar", exact: true });
    await expect(collapse).toBeVisible();
    const at = await box(collapse);
    expect([at.width, at.height]).toEqual([28, 28]);
    await collapse.click();
    await expect.poll(() => configText(page)).toContain('"compact": true');
    await expect(page.locator(".app-body")).toHaveAttribute("data-nr-sidebar-mode", "auto-hide");
    // It stays shown while the pointer is on it, and hides when the pointer goes away.
    await page.mouse.move(700, 400);
    await expect(side(page)).toHaveAttribute("data-nr-state", "hidden");
    // Nothing else of the file changed on the way.
    expect(await configText(page)).toContain('"style": "glass"');
  });

  test("a folded sidebar shows at the edge, and its button keeps it open again (compact mode off)", async ({
    page,
  }) => {
    await start(page, { appearance: '"sidebar": { "compact": true }' });
    await expect(side(page)).toHaveAttribute("data-nr-state", "hidden");
    await page.mouse.move(2, 300);
    await expect(side(page)).toHaveAttribute("data-nr-state", "revealed");
    const keep = side(page).getByRole("button", { name: "Keep the sidebar open", exact: true });
    await keep.click();
    await expect.poll(() => configText(page)).toContain('"compact": false');
    await expect(page.locator(".app-body")).toHaveAttribute("data-nr-sidebar-mode", "docked");
    await expect(
      side(page).getByRole("button", { name: "Collapse the sidebar", exact: true }),
    ).toBeVisible();
  });

  test("the button works from the keyboard, with Enter and with Space", async ({ page }) => {
    await start(page);
    const collapse = side(page).getByRole("button", { name: "Collapse the sidebar", exact: true });
    await collapse.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => configText(page)).toContain('"compact": true');
  });

  test("with the tabs on top the sidebar hides whatever the setting says, so the button is not there", async ({
    page,
  }) => {
    await start(page, { appearance: '"tabs": "top"' });
    await expect(part(page, "sidebar-head")).toBeVisible();
    await expect(part(page, "sidebar-collapse")).toHaveCount(0);
  });

  test("the head in Portuguese", async ({ page }) => {
    await start(page, { lang: "pt-BR" });
    await expect(
      side(page).getByRole("button", { name: "Recolher a barra lateral", exact: true }),
    ).toBeVisible();
  });
});

test.describe("the search: a button that looks like a field, with the shortcut of the palette", () => {
  test("it is under the head, 38 px, with a magnifier, the word and the keycap of the palette", async ({
    page,
  }) => {
    await start(page);
    const search = side(page).getByRole("button", { name: "Search", exact: true });
    await expect(search).toBeVisible();
    const head = await box(part(page, "sidebar-head"));
    const at = await box(search);
    expect(at.height).toBe(38);
    expect(at.y - (head.y + head.height)).toBeCloseTo(14, 0);
    expect(await style(search, "border-top-left-radius")).toBe("10px");
    await expect(search.locator("svg")).toHaveCount(1);
    await expect(search.locator(".keycap")).toHaveText("Ctrl ⇧ P");
    // The keycap is for the eyes; the button says its shortcut to assistive technology as a property.
    await expect(search.locator(".keycap")).toHaveAttribute("aria-hidden", "true");
    await expect(search).toHaveAttribute("aria-keyshortcuts", "Control+Shift+P");
    await expect(search).toHaveAttribute("title", "Search or run a command");
    expect(await style(search.locator(".keycap"), "font-family")).toContain("Geist Mono");
  });

  test("a click on it opens the command palette", async ({ page }) => {
    await start(page);
    await side(page).getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator('[data-nr-part="palette"]')).toBeVisible();
  });

  // One page for each key: the palette gives the focus back as it closes, a moment after, so a button
  // focused right after closing it is not a thing to wait on.
  for (const key of ["Enter", "Space"] as const) {
    test(`the keyboard opens the command palette from it: ${key}`, async ({ page }) => {
      await start(page);
      const search = side(page).getByRole("button", { name: "Search", exact: true });
      await search.focus();
      await expect(search).toBeFocused();
      await page.keyboard.press(key);
      await expect(page.locator('[data-nr-part="palette"]')).toBeVisible();
    });
  }

  test("the keycap is the chord the person set, not a fixed one", async ({ page }) => {
    await page.addInitScript(() =>
      window.localStorage.setItem(
        "noren.ui.keybindings",
        JSON.stringify({ overrides: { "palette.open": "Ctrl+Alt+KeyK", "tab.new": "Alt+KeyN" } }),
      ),
    );
    await start(page);
    await expect(part(page, "sidebar-search").locator(".keycap")).toHaveText("Ctrl Alt K");
    await expect(part(page, "sidebar-search")).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Alt+K",
    );
    await expect(side(page).locator(".new-tab .keycap")).toHaveText("Alt N");
  });

  test("an action with no key has no keycap", async ({ page }) => {
    await page.addInitScript(() =>
      window.localStorage.setItem(
        "noren.ui.keybindings",
        JSON.stringify({ overrides: { "palette.open": null } }),
      ),
    );
    await start(page);
    await expect(part(page, "sidebar-search")).toBeVisible();
    await expect(part(page, "sidebar-search").locator(".keycap")).toHaveCount(0);
    await expect(part(page, "sidebar-search")).not.toHaveAttribute("aria-keyshortcuts");
  });

  test("at the default width the word is short; the sentence is its tooltip", async ({ page }) => {
    await start(page);
    await expect(part(page, "sidebar-search")).toHaveAccessibleName("Search");
  });

  test("the whole sentence shows when the sidebar is 320 px wide, with the keycap beside it", async ({
    page,
  }) => {
    await start(page, { appearance: '"sidebar": { "width": 320 }' });
    await expect(part(page, "sidebar-search")).toHaveAccessibleName("Search or run a command");
    // The sentence and the keycap share the line without cutting either.
    const text = await part(page, "sidebar-search")
      .locator(".sidebar-search-text")
      .evaluate((node) => node.scrollWidth <= node.clientWidth);
    expect(text).toBe(true);
  });

  test("in Portuguese the word and the sentence are in the language", async ({ page }) => {
    await start(page, { lang: "pt-BR" });
    await expect(part(page, "sidebar-search")).toHaveAccessibleName("Buscar");
    await expect(part(page, "sidebar-search")).toHaveAttribute("title", "Buscar ou rodar comando");
  });
});

test.describe("the favorites: a grid of four tiles with a state dot", () => {
  test("the tiles are four to a row, equal, 50 px tall, 6 px apart, with a line, and the fifth wraps", async ({
    page,
  }) => {
    await start(page, { bar: true });
    const tiles = part(page, "favorites").locator('[data-nr-part="favorite"]');
    await expect(tiles).toHaveCount(5);
    const grid = part(page, "favorites").locator(".favorites-grid");
    const columns = (await style(grid, "grid-template-columns")).split(" ");
    expect(columns).toHaveLength(4);
    expect(new Set(columns).size).toBe(1);
    expect(await style(grid, "column-gap")).toBe("6px");
    expect(await style(grid, "row-gap")).toBe("6px");
    const boxes = [];
    for (let index = 0; index < 5; index++) boxes.push(await box(tiles.nth(index)));
    const [first, second, , , fifth] = boxes;
    if (first === undefined || second === undefined || fifth === undefined)
      throw new Error("tiles");
    for (const at of boxes) {
      expect(at.height).toBe(50);
      expect(at.width).toBeCloseTo(first.width, 0);
    }
    // Four on the first row, the fifth under the first.
    expect(new Set(boxes.slice(0, 4).map((at) => at.y)).size).toBe(1);
    expect(fifth.y).toBeCloseTo(first.y + 50 + 6, 0);
    expect(fifth.x).toBeCloseTo(first.x, 0);
    // The gap between two tiles of a row.
    expect(second.x - (first.x + first.width)).toBeCloseTo(6, 0);
    const tileOne = tiles.first();
    expect(await style(tileOne, "border-top-left-radius")).toBe("10px");
    expect(await style(tileOne, "border-top-width")).toBe("1px");
    await expectNothingLeavesTheCard(page);
  });

  test("a favorite tab that waits for you has an amber dot, one that works a green one, one that is idle none", async ({
    page,
  }) => {
    await start(page, { bar: true, agents: AGENT_STATES });
    const waiting = tile(page, "deploy");
    const working = tile(page, "scratch");
    await expect(waiting.locator('[data-nr-part="favorite-dot"]')).toHaveAttribute(
      "data-nr-dot",
      "waiting",
    );
    await expect(working.locator('[data-nr-part="favorite-dot"]')).toHaveAttribute(
      "data-nr-dot",
      "running",
    );
    const waitingColor = await rootVar(page, "--nr-state-waiting");
    const runningColor = await rootVar(page, "--nr-state-running");
    expect(await style(waiting.locator(".favorite-dot"), "background-color")).toBe(
      rgbOf(waitingColor),
    );
    expect(await style(working.locator(".favorite-dot"), "background-color")).toBe(
      rgbOf(runningColor),
    );
    // On the corner: 7 px, 7 px from the top and the right edge of the tile.
    const dot = await box(waiting.locator(".favorite-dot"));
    const tileBox = await box(waiting);
    expect([dot.width, dot.height]).toEqual([7, 7]);
    expect(dot.y - tileBox.y).toBeCloseTo(8, 0);
    expect(tileBox.x + tileBox.width - (dot.x + dot.width)).toBeCloseTo(8, 0);
    // The profile never has a dot.
    await expect(
      part(page, "favorites").locator('[data-nr-kind="profile"] .favorite-dot'),
    ).toHaveCount(0);
    // The state is said in words too, as the description of the tile.
    await expect(waiting).toHaveAccessibleDescription(/waiting/i);
    await expect(working).toHaveAccessibleDescription(/working/i);
  });

  test("an action that runs puts a green dot on its tile, and the dot goes when it stops", async ({
    page,
  }) => {
    await start(page, { bar: true });
    const header = page.getByRole("region", { name: "Project actions", exact: true });
    await header.getByRole("button", { name: "Start Loop", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "Run project action", exact: true })
      .getByRole("button", { name: "Run", exact: true })
      .click();
    const running = part(page, "favorites").locator(
      '[data-nr-kind="action"][data-nr-state="running"]',
    );
    await expect(running).toHaveCount(1);
    await expect(running.locator(".favorite-dot")).toHaveAttribute("data-nr-dot", "running");
    await header.getByRole("button", { name: "Stop Loop", exact: true }).click();
    await expect(
      part(page, "favorites").locator('[data-nr-kind="action"] .favorite-dot'),
    ).toHaveCount(0);
  });

  test("the empty bar keeps its line that teaches, as a dashed place with the corners of the tiles", async ({
    page,
  }) => {
    await start(page);
    const hint = part(page, "favorites").locator('[data-nr-part="favorites-hint"]');
    await expect(hint).toBeVisible();
    expect(await style(hint, "border-top-style")).toBe("dashed");
    expect(await style(hint, "border-top-left-radius")).toBe("10px");
    await expectNothingLeavesTheCard(page);
  });

  test("the dense style draws its favorites as chips of 22 px in the bar under the title bar, not as a grid of four in the sidebar", async ({
    page,
  }) => {
    await start(page, { style: "dense", bar: true, agents: AGENT_STATES });
    await expect(side(page).locator('[data-nr-part="favorites"]')).toHaveCount(0);
    const bar = page.locator('[data-nr-part="dense-toolbar"]');
    const first = bar.locator('[data-nr-part="favorite"]').first();
    expect((await box(first)).height).toBe(22);
    expect(await style(bar.locator(".favorites-grid"), "display")).toBe("flex");
    // The state is a square of 6 px before the name, not the round dot of the glass.
    const dot = bar.locator(".favorite-dot").first();
    await expect(dot).toHaveCount(1);
    expect(await style(dot, "border-top-left-radius")).toBe("0px");
  });
});

test.describe("the card of the project actions", () => {
  test("the card has the mark of the space, its name, the words, and one button per action", async ({
    page,
  }) => {
    await start(page);
    const card = part(page, "space-header");
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name: "Main", exact: true })).toBeVisible();
    await expect(card.locator(".space-header-note")).toHaveText("· project actions");
    expect(await style(card.locator(".space-header-mark"), "background-color")).toBe(
      "rgb(107, 138, 253)",
    );
    expect(await style(card, "border-top-left-radius")).toBe("12px");
    expect(await style(card, "padding-top")).toBe("10px");
    const loop = card.getByRole("button", { name: "Start Loop", exact: true });
    const dev = card.getByRole("button", { name: "Start Dev server", exact: true });
    for (const button of [loop, dev]) {
      const at = await box(button);
      expect(at.height).toBe(30);
      expect(await style(button, "border-top-left-radius")).toBe("8px");
    }
    // The label is the visible word of each button; the verb is in its name.
    await expect(loop).toContainText("Loop");
    await expect(dev).toContainText("Dev server");
    await expectNothingLeavesTheCard(page);
  });

  test("at the default width the buttons are one to a line, and side by side when there is room for two", async ({
    page,
  }) => {
    await start(page);
    const loop = await box(part(page, "space-header").getByRole("button", { name: "Start Loop" }));
    const dev = await box(
      part(page, "space-header").getByRole("button", { name: "Start Dev server" }),
    );
    expect(dev.x).toBeCloseTo(loop.x, 0);
    expect(dev.y).toBeGreaterThan(loop.y + loop.height);
    expect(dev.y - (loop.y + loop.height)).toBeCloseTo(6, 0);
  });

  test("with a wide sidebar the two buttons share the line, like the design", async ({ page }) => {
    await start(page, { appearance: '"sidebar": { "width": 300 }' });
    const loop = await box(part(page, "space-header").getByRole("button", { name: "Start Loop" }));
    const dev = await box(
      part(page, "space-header").getByRole("button", { name: "Start Dev server" }),
    );
    expect(dev.y).toBeCloseTo(loop.y, 0);
    expect(dev.x).toBeGreaterThan(loop.x + loop.width);
    expect(loop.width).toBeCloseTo(dev.width, 0);
  });

  test("a running action is a green button with a stop mark and a dot, named Stop; idle has no dot", async ({
    page,
  }) => {
    await start(page);
    const card = page.getByRole("region", { name: "Project actions", exact: true });
    await expect(card.locator(".action-dot[data-nr-indicator='running']")).toHaveCount(0);
    await expect(card.locator(".action-dot:visible")).toHaveCount(0);
    await card.getByRole("button", { name: "Start Dev server", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "Run project action", exact: true })
      .getByRole("button", { name: "Run", exact: true })
      .click();
    const stop = card.getByRole("button", { name: "Stop Dev server", exact: true });
    await expect(stop).toBeVisible();
    await expect(card.locator(".action-dot[data-nr-indicator='running']")).toHaveCount(1);
    await expect(card.locator(".action-dot[data-nr-indicator='running']")).toBeVisible();
    await expect(card.locator("li[data-nr-state='running']")).toHaveCount(1);
    // The mark of the button turned into a stop (the square), and the border is green, not a gray line.
    expect(await style(stop, "border-top-color")).not.toBe(
      await style(
        card.getByRole("button", { name: "Start Loop", exact: true }),
        "border-top-color",
      ),
    );
    await stop.click();
    await expect(card.getByRole("button", { name: "Start Dev server", exact: true })).toBeVisible();
    await expect(card.locator(".action-dot[data-nr-indicator='running']")).toHaveCount(0);
  });

  test("a long name of an action and of the space stays inside the card, cut by an ellipsis in its own box", async ({
    page,
  }) => {
    const long = JSON.stringify({
      actions: [
        {
          id: "long",
          label: "A label of an action that is much longer than the sidebar is wide",
          command: "echo long",
          tab: "long",
        },
      ],
    });
    await start(page, { actions: long, longNames: true });
    await expect(part(page, "space-header")).toBeVisible();
    await expectNothingLeavesTheCard(page);
    const label = part(page, "space-header").locator(".action-label");
    expect(await style(label, "text-overflow")).toBe("ellipsis");
    expect(await label.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    const title = part(page, "space-header").locator(".space-header-title");
    expect(await style(title, "text-overflow")).toBe("ellipsis");
  });

  test("the dense style puts the actions in the bar under the title bar: a button with its mark and its label, after the word actions", async ({
    page,
  }) => {
    await start(page, { style: "dense" });
    await expect(side(page).locator('[data-nr-part="space-header"]')).toHaveCount(0);
    const card = page
      .locator('[data-nr-part="dense-toolbar"]')
      .getByRole("region", { name: "Project actions", exact: true });
    await expect(card.locator(".space-header-mark")).toHaveCount(0);
    await expect(card.locator(".space-header-note")).toHaveCount(0);
    await expect(card.getByRole("heading")).toHaveCount(0);
    await expect(card.locator(".space-header-label")).toHaveText("actions");
    const loop = card.getByRole("button", { name: "Start Loop", exact: true });
    await expect(loop).toHaveText("Loop");
    await expect(loop.locator("svg")).toHaveCount(1);
    await expect(card.locator(".action-dot")).toHaveCount(0);
    expect((await box(loop)).height).toBe(22);
  });
});

test.describe("the tree: a state dot, the title, a second line with the folder and the branch", () => {
  test("every tab has a dot at the start: idle is a muted point, working green, waiting amber", async ({
    page,
  }) => {
    await start(page, { agents: AGENT_STATES });
    const dotOf = (title: string) => row(page, title).locator('[data-nr-part="item-dot"]');
    await expect(dotOf("api")).toHaveAttribute("data-nr-dot", "running");
    await expect(dotOf("deploy")).toHaveAttribute("data-nr-dot", "waiting");
    await expect(dotOf("scratch")).toHaveAttribute("data-nr-dot", "running");
    await expect(dotOf("build")).toHaveAttribute("data-nr-dot", "idle");
    await expect(dotOf("notes")).toHaveAttribute("data-nr-dot", "idle");
    expect(await style(dotOf("api"), "background-color")).toBe(
      rgbOf(await rootVar(page, "--nr-state-running")),
    );
    expect(await style(dotOf("deploy"), "background-color")).toBe(
      rgbOf(await rootVar(page, "--nr-state-waiting")),
    );
    const idle = await style(dotOf("build"), "background-color");
    expect(idle).not.toBe(rgbOf(await rootVar(page, "--nr-state-running")));
    const at = await box(dotOf("build"));
    expect([at.width, at.height]).toEqual([8, 8]);
    expect(await style(dotOf("build"), "border-top-left-radius")).toBe("50%");
    // The dot is for the eyes: it is not part of what the row is called.
    await expect(row(page, "api")).toHaveAccessibleName("api");
    await expect(dotOf("api")).toHaveAttribute("aria-hidden", "true");
  });

  test("a tab says its state in words too, as the description of its row", async ({ page }) => {
    await start(page, { agents: AGENT_STATES });
    await expect(row(page, "deploy")).toHaveAccessibleDescription(/waiting/i);
    await expect(row(page, "api")).toHaveAccessibleDescription(/working/i);
  });

  test("the second line is the folder, a middle dot and the branch, with no icon", async ({
    page,
  }) => {
    await start(page);
    const meta = row(page, "api").locator('[data-nr-part="item-meta"]');
    await expect(meta.locator('[data-nr-part="item-cwd"]')).toHaveText("~/projects/noren");
    await expect(meta.locator('[data-nr-part="item-branch"]')).toHaveText("main");
    expect(await style(meta.locator('[data-nr-part="item-branch"]'), "content", "::before")).toBe(
      '"·"',
    );
    await expect(meta.locator(".tab-branch-icon")).toBeHidden();
    // The folder first, the branch after it, on one line under the title.
    const title = await box(row(page, "api").locator('[data-nr-part="item-title"]'));
    const cwd = await box(meta.locator('[data-nr-part="item-cwd"]'));
    const branch = await box(meta.locator('[data-nr-part="item-branch"]'));
    expect(cwd.y).toBeGreaterThan(title.y);
    expect(branch.x).toBeGreaterThan(cwd.x + cwd.width - 1);
    expect(branch.y).toBeCloseTo(cwd.y, 0);
    expect(await style(meta, "font-size")).toBe("11.5px");
  });

  test("a row is 44 px at least, with the corners of a control, a lit one for the tab on screen", async ({
    page,
  }) => {
    await start(page);
    const api = row(page, "api");
    const at = await box(api);
    expect(at.height).toBeGreaterThanOrEqual(44);
    expect(await style(api, "border-top-left-radius")).toBe("10px");
    await expect(api).toHaveAttribute("data-nr-state", "active");
    expect(await style(api, "box-shadow")).toContain("inset");
    expect(await style(api, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
    const build = row(page, "build");
    expect(await style(build, "background-color")).toBe("rgba(0, 0, 0, 0)");
    expect(await style(build, "box-shadow")).toBe("none");
    // The rows are one above the other with the 2 px of the list between them, none over another.
    const first = await box(row(page, "api"));
    const second = await box(row(page, "build"));
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
  });

  test("a click on a row shows its tab, the arrow keys move between rows, as before", async ({
    page,
  }) => {
    await start(page);
    await row(page, "build").click();
    await expect(row(page, "build")).toHaveAttribute("data-nr-state", "active");
    await row(page, "build").focus();
    await page.keyboard.press("ArrowDown");
    await expect(row(page, "logs")).toBeFocused();
  });

  test("the compact density makes the rows a third shorter and keeps every part", async ({
    page,
  }) => {
    await start(page, { appearance: '"density": "compact"' });
    const at = await box(row(page, "api"));
    expect(at.height).toBeLessThan(44);
    await expect(row(page, "api").locator('[data-nr-part="item-dot"]')).toBeVisible();
    await expect(row(page, "api").locator('[data-nr-part="item-meta"]')).toBeVisible();
  });

  test("a group is a quiet row with its count at the end, not a pill", async ({ page }) => {
    await start(page);
    const group = side(page).locator('[data-nr-part="group"]').first();
    await expect(group).toContainText("Work");
    const count = group.locator('[data-nr-part="group-count"]');
    expect(await style(count, "background-color")).toBe("rgba(0, 0, 0, 0)");
    const groupBox = await box(group);
    const countBox = await box(count);
    expect(groupBox.x + groupBox.width - (countBox.x + countBox.width)).toBeLessThanOrEqual(10);
    expect(groupBox.height).toBeGreaterThanOrEqual(28);
  });

  test("long names (a title, a folder, a branch, a group) stay in their rows at the default width and at the narrowest", async ({
    page,
  }) => {
    await start(page, { longNames: true });
    await expect(side(page).locator('[data-nr-part="item"]').first()).toBeVisible();
    await expectNothingLeavesTheCard(page);
    // Rows do not overlap: each starts where the one before it ends or later, and the title ends
    // before the marks of its row begin.
    const rows = await side(page)
      .locator('[data-nr-part="item"], [data-nr-part="group"]')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            label: button.textContent?.slice(0, 20) ?? "",
          };
        }),
      );
    const visible = rows.filter((r) => r.bottom - r.top > 0);
    for (let index = 1; index < visible.length; index++) {
      const previous = visible[index - 1];
      const current = visible[index];
      if (previous === undefined || current === undefined) continue;
      if (current.top >= previous.top) {
        expect(current.top, `${current.label} over ${previous.label}`).toBeGreaterThanOrEqual(
          previous.bottom - 0.5,
        );
      }
    }
    const title = await box(side(page).locator('[data-nr-part="item-title"]').first());
    const sidebar = await box(side(page));
    expect(title.x + title.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
  });

  test("the narrowest sidebar (180 px) holds the same rows without anything leaving it", async ({
    page,
  }) => {
    await start(page, {
      bar: true,
      appearance: '"sidebar": { "width": 180 }',
      agents: AGENT_STATES,
    });
    await expect(side(page).locator('[data-nr-part="item"]').first()).toBeVisible();
    await expectNothingLeavesTheCard(page);
  });

  test("the widest sidebar (480 px) lets the actions share the line and the whole sentence show", async ({
    page,
  }) => {
    await start(page, { bar: true, appearance: '"sidebar": { "width": 480 }' });
    await expectNothingLeavesTheCard(page);
    await expect(part(page, "sidebar-search")).toHaveAccessibleName("Search or run a command");
  });

  test("the dense style has rows of one line: a square state at the start, the title, the branch at the end, no icon of the branch", async ({
    page,
  }) => {
    await start(page, { style: "dense" });
    const dot = row(page, "api").locator('[data-nr-part="item-dot"]');
    await expect(dot).toHaveCount(1);
    expect(await style(dot, "border-top-left-radius")).toBe("0px");
    const branch = row(page, "api").locator('[data-nr-part="item-branch"]');
    await expect(branch.locator(".tab-branch-icon")).toBeHidden();
    await expect(row(page, "api").locator('[data-nr-part="item-cwd"]')).toBeHidden();
    expect(await style(row(page, "api"), "flex-direction")).toBe("row");
    expect((await box(row(page, "api"))).height).toBe(24);
  });
});

test.describe("the foot: New tab, the spaces and the settings", () => {
  test("New tab is a quiet row with a plus, its word and the keycap at the end", async ({
    page,
  }) => {
    await start(page);
    const newTab = side(page).getByRole("button", { name: "New tab", exact: true });
    await expect(newTab).toBeVisible();
    const at = await box(newTab);
    expect(at.height).toBe(36);
    await expect(newTab.locator("svg")).toHaveCount(1);
    await expect(newTab.locator(".keycap")).toHaveText("Ctrl ⇧ T");
    const keycap = await box(newTab.locator(".keycap"));
    expect(at.x + at.width - (keycap.x + keycap.width)).toBeCloseTo(10, 0);
    expect(await style(newTab, "border-top-width")).toBe("0px");
    const before = await side(page).locator('[data-nr-part="item"]').count();
    await newTab.click();
    await expect(side(page).locator('[data-nr-part="item"]')).toHaveCount(before + 1);
  });

  test("the foot has the spaces and the settings under a line, at the bottom of the card", async ({
    page,
  }) => {
    await start(page);
    const base = part(page, "sidebar-base");
    await expect(base).toBeVisible();
    expect(await style(base, "border-top-width")).toBe("1px");
    const baseBox = await box(base);
    const sidebar = await box(side(page));
    // Its bottom is at the padding of the card (12 px) from the bottom edge, less the 1 px line.
    expect(sidebar.y + sidebar.height - (baseBox.y + baseBox.height)).toBeCloseTo(13, 0);
    const spaces = base.getByRole("navigation", { name: "Spaces", exact: true });
    const main = spaces.getByRole("button", { name: "Main", exact: true });
    const at = await box(main);
    expect([at.width, at.height]).toEqual([34, 34]);
    expect(await style(main, "border-top-left-radius")).toBe("10px");
    await expect(main).toHaveAttribute("aria-current", "true");
    expect(await style(main, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
    await expect(spaces.getByRole("button", { name: "New space", exact: true })).toBeVisible();
    await expect(spaces.getByRole("button", { name: "Space options", exact: true })).toBeVisible();
  });

  test("the settings button is at the right end of the foot, 34 px, and opens the settings", async ({
    page,
  }) => {
    await start(page);
    const settings = part(page, "sidebar-base").getByRole("button", {
      name: "Settings",
      exact: true,
    });
    await expect(settings).toBeVisible();
    const at = await box(settings);
    expect([at.width, at.height]).toEqual([34, 34]);
    const base = await box(part(page, "sidebar-base"));
    expect(base.x + base.width - (at.x + at.width)).toBeLessThanOrEqual(1);
    // The one button of that name on the page: the title bar does not have a second one.
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(1);
    await expect(page.locator(".titlebar").getByRole("button", { name: "Settings" })).toHaveCount(
      0,
    );
    await settings.click();
    await expect(settingsScreen(page)).toBeVisible();
  });

  test("with the sidebar folded the settings are in the title bar again (still one button of that name)", async ({
    page,
  }) => {
    await start(page, { appearance: '"sidebar": { "compact": true }' });
    await expect(side(page)).toHaveAttribute("data-nr-state", "hidden");
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(1);
    await expect(
      page.locator(".titlebar").getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible();
    await openSettings(page);
  });

  test("with the tabs on top the sidebar hides, so the title bar has the settings", async ({
    page,
  }) => {
    await start(page, { appearance: '"tabs": "top"' });
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(1);
    await expect(
      page.locator(".titlebar").getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible();
  });

  test("the dense style has the settings as the last row of the sidebar (and not in the title bar) and the spaces at its top", async ({
    page,
  }) => {
    await start(page, { style: "dense" });
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(1);
    await expect(side(page).getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.locator(".titlebar").getByRole("button", { name: "Settings" })).toHaveCount(
      0,
    );
    await expect(part(page, "sidebar-base")).toHaveCount(0);
    await expect(part(page, "sidebar-head")).toHaveCount(0);
    await expect(part(page, "sidebar-search")).toHaveCount(0);
    // New tab says its shortcut in the plain form of the dense style, and is a row without a line.
    await expect(side(page).locator(".new-tab .keycap")).toHaveText("ctrl+⇧+t");
    expect(await style(side(page).locator(".new-tab"), "border-top-width")).toBe("0px");
    // The spaces are the first thing in the sidebar.
    const spaces = await box(part(page, "space-switcher"));
    const sidebar = await box(side(page));
    expect(Math.abs(spaces.y - sidebar.y)).toBeLessThanOrEqual(1);
  });

  test("the style switch moves the settings button and brings the parts back at once", async ({
    page,
  }) => {
    await start(page, { style: "dense" });
    await expect(part(page, "sidebar-head")).toHaveCount(0);
    const screen = await openSettings(page);
    await screen.getByRole("radio", { name: "Glass", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "glass");
    await screen.getByRole("button", { name: "Close", exact: true }).click();
    await expect(part(page, "sidebar-head")).toBeVisible();
    await expect(part(page, "sidebar-search")).toBeVisible();
    await expect(
      part(page, "sidebar-base").getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".titlebar").getByRole("button", { name: "Settings" })).toHaveCount(
      0,
    );
  });
});

test.describe("the colors of a space: the four of the design are offered", () => {
  const DESIGN = [
    ["Mint", "rgb(94, 230, 200)"],
    ["Lilac", "rgb(169, 155, 255)"],
    ["Gold", "rgb(245, 184, 75)"],
    ["Blush", "rgb(255, 143, 163)"],
  ] as const;

  test("the dialog of a new space offers them after the older eight (and the four of the dense design after them), and the first, Blue, is still the one it starts on", async ({
    page,
  }) => {
    await start(page);
    await side(page).getByRole("button", { name: "New space", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New space", exact: true });
    await expect(dialog).toBeVisible();
    const radios = dialog.locator('input[name="space-color"]');
    await expect(radios).toHaveCount(16);
    await expect(radios.first()).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Blue", exact: true })).toBeChecked();
    for (const [name] of DESIGN) {
      await expect(dialog.getByRole("radio", { name, exact: true })).toBeVisible();
    }
    await expect(radios.nth(8)).toHaveAccessibleName("Mint");
  });

  for (const [name, rgb] of DESIGN) {
    test(`a space made ${name} has it as the highlight of the window, the mark of the head and the card of its actions`, async ({
      page,
    }) => {
      await start(page);
      await side(page).getByRole("button", { name: "New space", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "New space", exact: true });
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Design");
      await dialog.getByRole("radio", { name, exact: true }).check();
      await dialog.getByRole("button", { name: "Create space", exact: true }).click();
      await expect(dialog).toBeHidden();
      const mark = part(page, "sidebar-head").locator(".sidebar-mark");
      await expect.poll(() => style(mark, "background-color")).toBe(rgb);
      const swatch = side(page).getByRole("button", { name: "Design", exact: true });
      await expect(swatch).toHaveAttribute("aria-current", "true");
    });
  }

  test("the names are in Portuguese too", async ({ page }) => {
    await start(page, { lang: "pt-BR" });
    await side(page).getByRole("button", { name: "Novo espaço", exact: true }).click();
    const dialog = page.getByRole("dialog");
    for (const name of ["Menta", "Lilás", "Dourado", "Rosado"]) {
      await expect(dialog.getByRole("radio", { name, exact: true })).toBeVisible();
    }
  });

  test("the dialog has no axe violation with twelve colors, in both languages", async ({
    page,
  }) => {
    await start(page);
    await side(page).getByRole("button", { name: "New space", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New space", exact: true })).toBeVisible();
    await expectNoAxeViolations(page, "the new space dialog with twelve colors");
  });
});

test.describe("the sidebar as a whole", () => {
  test("the parts come in the order of the design: head, search, favorites, actions, tabs, New tab, foot", async ({
    page,
  }) => {
    await start(page, { bar: true });
    const tops = [
      (await box(part(page, "sidebar-head"))).y,
      (await box(part(page, "sidebar-search"))).y,
      (await box(part(page, "favorites"))).y,
      (await box(part(page, "space-header"))).y,
      (await box(side(page).locator('[data-nr-part="item"]').first())).y,
      (await box(side(page).getByRole("button", { name: "New tab", exact: true }))).y,
      (await box(part(page, "sidebar-base"))).y,
    ];
    const sorted = [...tops].sort((a, b) => a - b);
    expect(tops).toEqual(sorted);
    expect(new Set(tops).size).toBe(tops.length);
    // The 14 px between the sections of the card.
    const search = await box(part(page, "sidebar-search"));
    const bar = await box(part(page, "favorites"));
    expect(bar.y - (search.y + search.height)).toBeCloseTo(14, 0);
  });

  test("the card has the paddings of the design and the sidebar is still 200 px by default", async ({
    page,
  }) => {
    await start(page);
    const sidebar = side(page);
    expect(await style(sidebar, "padding-top")).toBe("12px");
    expect(await style(sidebar, "padding-left")).toBe("10px");
    expect(await style(sidebar, "row-gap")).toBe("14px");
    expect((await box(sidebar)).width).toBe(200);
    expect(await style(sidebar, "font-size")).toBe("13px");
    expect(await style(sidebar, "font-family")).toContain("Geist");
  });

  test("everything keeps its place with a picture behind the window", async ({ page }) => {
    await start(page, { bar: true, agents: AGENT_STATES });
    await expect(part(page, "sidebar-head")).toBeVisible();
    await expectNothingLeavesTheCard(page);
  });
});

for (const lang of ["en", "pt-BR"] as const) {
  for (const mode of ["dark", "light"] as const) {
    test.describe(`axe, ${lang}, ${mode} theme`, () => {
      test("the glass sidebar with favorites, an action running, a tab waiting and one working has no violation", async ({
        page,
      }) => {
        await start(page, { lang, mode, bar: true, agents: AGENT_STATES });
        await expect(tile(page, lang === "en" ? "deploy" : "deploy")).toBeVisible();
        await expectNoAxeViolations(page, `the glass sidebar, ${lang}, ${mode}`);
      });

      test("the glass sidebar with the action running and the sidebar 320 px wide has no violation", async ({
        page,
      }) => {
        await start(page, { lang, mode, appearance: '"sidebar": { "width": 320 }' });
        const card = page.locator('[data-nr-part="space-header"]');
        await card.getByRole("button").first().click();
        await page.getByRole("alertdialog").getByRole("button").last().click();
        await expect(card.locator(".action-dot[data-nr-indicator='running']")).toHaveCount(1);
        await expectNoAxeViolations(page, `the glass sidebar, wide, ${lang}, ${mode}`);
      });

      test("the glass sidebar folded away and shown at the edge has no violation", async ({
        page,
      }) => {
        await start(page, { lang, mode, appearance: '"sidebar": { "compact": true }' });
        await page.mouse.move(2, 300);
        await expect(side(page)).toHaveAttribute("data-nr-state", "revealed");
        await expectNoAxeViolations(page, `the folded sidebar, ${lang}, ${mode}`);
      });
    });
  }
}
