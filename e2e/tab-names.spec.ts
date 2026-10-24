import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { numberTheTabs } from "./numbered-tabs";
import { seedConfig } from "./settings-fixture";
import { openCommandPalette } from "./palette-fixture";

// The name of a tab nobody named (NOR-F20-12, D22 item 9): the folder its shell reports, from the first
// one (the fake shell starts in `/home/fake`, which is `~`), and the program of the command after it
// while one runs (`api · sleep`); the placeholder (`Tab 1`) only while no folder is known. What the
// person typed always wins. The same words are in the sidebar, the bar of the top tabs, the favorites,
// the breadcrumb of the dense window and the palette: one rule gives all of them (`tabLabel`).

interface Hook {
  advanceClock(ms: number): void;
  paneIds(): string[];
  sendOutput(paneId: string, text: string): boolean;
}
type HookWindow = Window & { __norenTest?: Hook };

const OSC = (body: string): string => `\x1b]${body}\x07`;
const folder = (path: string): string => OSC(`7;file://host${path}`);

const tree = (page: Page): Locator => page.getByRole("tree", { name: /^(Tabs|Abas)$/ });
const titles = (page: Page): Locator => tree(page).locator('[data-nr-part="item-title"]');
const bar = (page: Page): Locator => page.locator('[data-nr-part="tabbar"]');
const barTabs = (page: Page): Locator => bar(page).locator('[data-nr-part="item"]');
const crumb = (page: Page): Locator => page.locator('[data-nr-crumb="tab"] .titlebar-crumb-text');
const tiles = (page: Page): Locator =>
  page.locator('[data-nr-part="favorites"]').getByRole("button");
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });

async function run(page: Page, line: string): Promise<void> {
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/** What the program of the first pane writes (the shell of the fake one reports as it would). */
function say(page: Page, text: string, pane = 0): Promise<boolean> {
  return page.evaluate(
    ({ text: out, at }) => {
      const hook = (window as HookWindow).__norenTest;
      const id = hook?.paneIds()[at];
      return id !== undefined && hook !== undefined ? hook.sendOutput(id, out) : false;
    },
    { text, at: pane },
  );
}

const advance = (page: Page, ms: number): Promise<void> =>
  page.evaluate((by) => (window as HookWindow).__norenTest?.advanceClock(by), ms);

async function newTab(page: Page): Promise<void> {
  const before = (await titles(page).count()) + (await barTabs(page).count());
  // The bar of the top tabs has its own button; the sidebar, hidden then, has another one.
  const button =
    (await bar(page).count()) > 0
      ? page.locator("nav.tab-bar").getByRole("button", { name: /^(New tab|Nova aba)$/ })
      : page.getByRole("button", { name: /^(New tab|Nova aba)$/ }).first();
  await button.click();
  await expect
    .poll(async () => (await titles(page).count()) + (await barTabs(page).count()))
    .toBe(before + 1);
}

test.describe("the sidebar", () => {
  test("a fresh tab is named after the first folder its shell reports, not by its number", async ({
    page,
  }) => {
    await page.goto("/");
    // The fake shell starts in its home folder and reports it at its first prompt.
    await expect(titles(page)).toHaveText(["~"]);
    await expect(titles(page).first()).not.toHaveText(/Tab/);
  });

  test("each tab says the folder its own shell is in, and the number stays for the ones with none", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(titles(page)).toHaveText(["~"]);
    await run(page, "cd /srv/api");
    await expect(titles(page)).toHaveText(["api"]);
    await newTab(page);
    await expect(titles(page)).toHaveText(["api", "~"]);
    await run(page, "cd /srv/web");
    await expect(titles(page)).toHaveText(["api", "web"]);
  });

  test("a tab of a shell that tells no folder keeps its number, and a command is its name while it runs", async ({
    page,
  }) => {
    await numberTheTabs({ page });
    await page.goto("/");
    await expect(titles(page)).toHaveText(["Tab 1"]);
    await newTab(page);
    await expect(titles(page)).toHaveText(["Tab 1", "Tab 2"]);
    await run(page, "sleep 3");
    await expect(titles(page)).toHaveText(["Tab 1", "sleep"]);
    await advance(page, 3000);
    await expect(titles(page)).toHaveText(["Tab 1", "Tab 2"]);
  });

  test("the command that runs comes after the folder, and goes when it ends", async ({ page }) => {
    await page.goto("/");
    await run(page, "cd /srv/api");
    await expect(titles(page)).toHaveText(["api"]);
    await run(page, "sleep 4");
    await expect(titles(page)).toHaveText(["api \u00b7 sleep"]);
    await advance(page, 4000);
    await expect(titles(page)).toHaveText(["api"]);
  });

  test("a shell that tells its first folder in a command line, the program is the name's second part", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(titles(page)).toHaveText(["~"]);
    await say(page, `${OSC("633;E;C:\\tools\\Node.EXE app.js")}${OSC("133;C")}`);
    await expect(titles(page)).toHaveText(["~ \u00b7 Node"]);
    await say(page, `${OSC("133;D;0")}`);
    await expect(titles(page)).toHaveText(["~"]);
  });

  test("a Windows folder, a POSIX one, a root and a trailing slash give the last part of the path", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(titles(page)).toHaveText(["~"]);
    const cases: [string, string][] = [
      ["/C:/Users/ada/proj", "proj"],
      ["/C:/Users/ada/proj/", "proj"],
      ["/home/x/proj", "proj"],
      ["/home/x/proj/", "proj"],
      ["/home/x/proj///", "proj"],
      ["/C:/", "C:/"],
      ["/", "/"],
      ["/home/fake", "~"],
    ];
    for (const [path, shown] of cases) {
      await say(page, folder(path));
      await expect(titles(page)).toHaveText([shown]);
    }
  });

  test("the window title a program sets does not rename the tab", async ({ page }) => {
    await page.goto("/");
    await expect(titles(page)).toHaveText(["~"]);
    await say(page, `${OSC("0;hijacked title")}${OSC("2;hijacked too")}${folder("/srv/api")}`);
    await expect(titles(page)).toHaveText(["api"]);
    // A program that sets the window title and then moves on: only the move is a name.
    await say(page, `${OSC("0;hijacked again")}${folder("/srv/web")}`);
    await expect(titles(page)).toHaveText(["web"]);
    await expect(tree(page)).not.toContainText("hijacked");
  });

  test("the title the person typed wins over the folder and the command, and clearing it gives the name back", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(titles(page)).toHaveText(["~"]);
    await titles(page).first().dblclick();
    const field = page.getByRole("textbox", { name: "Tab name", exact: true });
    // The box starts with the name the tab shows.
    await expect(field).toHaveValue("~");
    await field.fill("mine");
    await field.press("Enter");
    await expect(titles(page)).toHaveText(["mine"]);
    await expect(titles(page).first()).toBeVisible();
    await expect(tree(page).getByRole("treeitem", { name: "mine", exact: true })).toBeFocused();

    await run(page, "cd /srv/api");
    await expect(
      page.locator('[data-nr-part="item-command"] [data-nr-part="item-command-text"]'),
    ).toHaveText("cd /srv/api");
    await run(page, "sleep 2");
    await expect(titles(page)).toHaveText(["mine"]);
    await advance(page, 2000);
    await expect(titles(page)).toHaveText(["mine"]);

    await titles(page).first().dblclick();
    await field.fill("");
    await field.press("Enter");
    await expect(titles(page)).toHaveText(["api"]);
  });

  test("leaving the name as the tab shows it does not lock it", async ({ page }) => {
    await page.goto("/");
    await run(page, "cd /srv/api");
    await expect(titles(page)).toHaveText(["api"]);
    await titles(page).first().dblclick();
    const field = page.getByRole("textbox", { name: "Tab name", exact: true });
    await expect(field).toHaveValue("api");
    await field.press("Enter");
    await expect(field).toBeHidden();
    await expect(tree(page).getByRole("treeitem", { name: "api", exact: true })).toBeFocused();
    // Still the shell's to name: it follows the folder.
    await run(page, "cd /srv/web");
    await expect(titles(page)).toHaveText(["web"]);
  });

  test("a name too long for the column is cut by an ellipsis inside its own row", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(titles(page)).toHaveText(["~"]);
    const long = `a-folder-with-a-very-long-name-${"x".repeat(60)}`;
    await say(page, folder(`/srv/${long}`));
    await expect(titles(page)).toHaveText([long]);
    const title = titles(page).first();
    const row = tree(page).getByRole("treeitem").first();
    const fit = await title.evaluate(
      (node, rowNode) => {
        const box = node.getBoundingClientRect();
        const rowBox = (rowNode as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          ellipsis: style.textOverflow === "ellipsis" && style.overflow !== "visible",
          cut: node.scrollWidth > node.clientWidth,
          inside: box.right <= rowBox.right + 0.5 && box.left >= rowBox.left - 0.5,
        };
      },
      await row.elementHandle(),
    );
    expect(fit).toEqual({ ellipsis: true, cut: true, inside: true });
  });
});

test.describe("everywhere the name is read", () => {
  test("the favorites, the palette and what is read aloud say the same name as the sidebar", async ({
    page,
  }) => {
    await page.goto("/");
    await run(page, "cd /srv/api");
    await expect(titles(page)).toHaveText(["api"]);
    await newTab(page);
    await expect(titles(page)).toHaveText(["api", "~"]);

    // The tab as a favorite tile.
    await tree(page).getByRole("treeitem", { name: "api", exact: true }).click({ button: "right" });
    await menuItem(page, "Add to favorites").click();
    await expect(tiles(page)).toHaveCount(1);
    await expect(tiles(page).first()).toHaveAccessibleName("api");
    await run(page, "cd /srv/web");
    await run(page, "sleep 5");
    await expect(titles(page)).toHaveText(["api", "web \u00b7 sleep"]);

    // The palette lists the tabs by the same names.
    await openCommandPalette(page);
    await expect(palette(page)).toBeVisible();
    await page.keyboard.type("@");
    const entries = palette(page).locator('[data-nr-kind="tab"]');
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toContainText("api");
    await expect(entries.nth(1)).toContainText("web \u00b7 sleep");
    await page.keyboard.press("Escape");

    // The row says its name to a screen reader as it shows it.
    await expect(
      tree(page).getByRole("treeitem", { name: "web \u00b7 sleep", exact: true }),
    ).toHaveCount(1);
  });

  test("the bar of the top tabs says the same", async ({ page }) => {
    await seedConfig(page, JSON.stringify({ appearance: { tabs: "top" } }));
    await page.goto("/");
    await expect(barTabs(page)).toHaveAttribute("aria-label", "~");
    await run(page, "cd /srv/api");
    await expect(barTabs(page)).toHaveAttribute("aria-label", "api");
    await run(page, "sleep 3");
    await expect(barTabs(page)).toHaveAttribute("aria-label", "api \u00b7 sleep");
    await advance(page, 3000);
    await expect(barTabs(page)).toHaveAttribute("aria-label", "api");
    await newTab(page);
    await expect
      .poll(async () =>
        barTabs(page).evaluateAll((all) => all.map((n) => n.getAttribute("aria-label"))),
      )
      .toEqual(["api", "~"]);
  });

  test("the breadcrumb of the dense window says the same", async ({ page }) => {
    await seedConfig(page, JSON.stringify({ appearance: { style: "dense" } }));
    await page.goto("/");
    await expect(crumb(page)).toHaveText("~");
    await run(page, "cd /srv/api");
    await expect(crumb(page)).toHaveText("api");
    await run(page, "sleep 3");
    await expect(crumb(page)).toHaveText("api \u00b7 sleep");
    await expect(titles(page)).toHaveText(["api \u00b7 sleep"]);
    await advance(page, 3000);
    await expect(crumb(page)).toHaveText("api");
  });
});

test.describe("the name in both styles and both languages", () => {
  for (const style of ["glass", "dense"] as const) {
    for (const language of ["en", "pt-BR"] as const) {
      test(`${style}, ${language}: the folder, then the command after it, and no axe violation`, async ({
        page,
      }) => {
        await seedConfig(page, JSON.stringify({ appearance: { style }, language }));
        await page.goto("/");
        await expect(titles(page)).toHaveText(["~"]);
        await run(page, "cd /srv/api");
        await expect(titles(page)).toHaveText(["api"]);
        await run(page, "sleep 2");
        await expect(titles(page)).toHaveText(["api · sleep"]);
        await expectNoAxeViolations(page, `the name of a tab, ${style}, ${language}`);
        await advance(page, 2000);
        await expect(titles(page)).toHaveText(["api"]);
      });

      test(`${style}, ${language}: the number, in the words of the language, while no folder is known`, async ({
        page,
      }) => {
        await numberTheTabs({ page });
        await seedConfig(page, JSON.stringify({ appearance: { style }, language }));
        await page.goto("/");
        const word = language === "en" ? "Tab" : "Aba";
        await expect(titles(page)).toHaveText([`${word} 1`]);
        if (style === "dense") await expect(crumb(page)).toHaveText(`${word} 1`);
        await newTab(page);
        await expect(titles(page)).toHaveText([`${word} 1`, `${word} 2`]);
        await expectNoAxeViolations(page, `the numbered tabs, ${style}, ${language}`);
      });
    }
  }
});
