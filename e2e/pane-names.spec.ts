import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";

// The name of a pane (NOR-F20-32a): the pane that a project action opens is named after the action;
// two of them merged into a split show both names in the header of each pane and on its row in the
// sidebar; F2 on a row turns its name into a text field; and the names are still there after a reload.
// The seeded space "Alpha" has two actions, "Loop Noren" (main) and "Dev server", and one shell tab.

const WEB_STATE_KEY = "noren.web.state";
const WEB_ACTIONS_KEY = "noren.web.actions";

const FILES: Record<string, string> = {
  "/srv/alpha": JSON.stringify({
    actions: [
      { id: "loop", label: "Loop Noren", command: "loop", tab: "loop" },
      { id: "dev", label: "Dev server", command: "pnpm dev", tab: "dev" },
    ],
  }),
};

interface Words {
  lang: "en" | "pt-BR";
  runButton: string;
  start(action: string): string;
  nameField: string;
  rename: string;
  tabs: string;
}

const WORDS: Record<Words["lang"], Words> = {
  en: {
    lang: "en",
    runButton: "Run",
    start: (action) => `Start ${action} in Alpha`,
    nameField: "Pane name",
    rename: "Rename pane",
    tabs: "Tabs",
  },
  "pt-BR": {
    lang: "pt-BR",
    runButton: "Executar",
    start: (action) => `Iniciar ${action} em Alpha`,
    nameField: "Nome do painel",
    rename: "Renomear painel",
    tabs: "Abas",
  },
};

function stateText(): string {
  return JSON.stringify({
    version: 2,
    activeSpaceId: "a",
    favorites: [],
    closed: [],
    archive: [],
    spaces: [
      {
        id: "a",
        name: "Alpha",
        icon: "terminal",
        color: "#5EE6C8",
        modIds: [],
        defaults: { env: {}, cwd: "/srv/alpha" },
        aiEnabled: true,
        saveScrollback: true,
        pinned: [],
        tree: [{ kind: "item", id: "a1" }],
        items: {
          a1: {
            id: "a1",
            title: "Alpha shell",
            titleLocked: true,
            layout: {
              kind: "pane",
              pane: {
                id: "a1p1",
                type: "terminal",
                profileId: "default",
                status: "idle",
                unread: false,
                bell: false,
              },
            },
            focusedPaneId: "a1p1",
            lastActivityAt: 1,
          },
        },
        activeItemId: "a1",
      },
    ],
  });
}

async function start(page: Page, lang: Words["lang"], style: "glass" | "dense"): Promise<Words> {
  const language = lang === "pt-BR" ? '"language": "pt-BR", ' : "";
  await seedConfig(page, `{ ${language}"appearance": { "style": "${style}" } }\n`);
  await page.addInitScript(
    ({ stateKey, state, actionsKey, files }) => {
      // Only the first load: a reload in a test must find what the page saved.
      if (window.localStorage.getItem(stateKey) !== null) return;
      window.localStorage.setItem(stateKey, state);
      window.localStorage.setItem(actionsKey, JSON.stringify(files));
    },
    { stateKey: WEB_STATE_KEY, state: stateText(), actionsKey: WEB_ACTIONS_KEY, files: FILES },
  );
  await page.goto("/");
  await expect(page.locator('[data-nr-part="projects"]')).toBeVisible();
  return WORDS[lang];
}

const projects = (page: Page) => page.locator('[data-nr-part="projects"]');
const startButton = (page: Page, name: string) =>
  projects(page).getByRole("button", { name, exact: true });
const tree = (page: Page, words: Words) =>
  page.getByRole("tree", { name: words.tabs, exact: true });
const tabRow = (page: Page, words: Words, name: string) =>
  tree(page, words).getByRole("treeitem", { name, exact: true });
/** The names written in the headers of the panes on screen, in layout order. */
const headerNames = (page: Page) => page.locator('[data-nr-part="pane-name"]:visible');
/** The names written on the pane rows of the sidebar, in layout order. */
const rowNames = (page: Page) => page.locator('[data-nr-part="item-pane-name"]');
const paneRows = (page: Page) => page.locator('[data-nr-part="item-pane"]');
const panes = (page: Page) => page.locator('[data-nr-part="pane"]:visible');

async function confirmRun(page: Page, words: Words): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: words.runButton, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
}

/** Presses on a row and drags it to `to`; the caller drops with the mouse. */
async function dragRowTo(row: Locator, page: Page, to: { x: number; y: number }) {
  const from = await box(row);
  const origin = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  // A first small step crosses the activation distance, then the pointer travels in steps.
  await page.mouse.move(origin.x + 10, origin.y, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  return { drop: () => page.mouse.up() };
}

/** Runs both actions of the space, then merges the tab of the second one beside the first. */
async function splitOfTwoActions(page: Page, words: Words): Promise<void> {
  await startButton(page, words.start("Loop Noren")).click();
  await confirmRun(page, words);
  await expect(tabRow(page, words, "loop")).toBeVisible();
  // The other action is in the block of the space once it is open.
  await projects(page).locator('[data-nr-part="project-name"]').click();
  await startButton(page, words.start("Dev server")).click();
  await confirmRun(page, words);
  await expect(tabRow(page, words, "dev")).toBeVisible();

  // The tab of the first action is on screen again; the second is dropped on its right edge.
  await tabRow(page, words, "loop").click();
  await expect(panes(page)).toHaveCount(1);
  const area = await box(panes(page).first());
  const drag = await dragRowTo(tabRow(page, words, "dev"), page, {
    x: area.x + area.width * 0.9,
    y: area.y + area.height * 0.5,
  });
  await drag.drop();
  await expect(panes(page)).toHaveCount(2);
  await expect(tabRow(page, words, "dev")).toHaveCount(0);
}

/** The state the page saved holds this text (it saves a moment after a change). */
async function saved(page: Page, text: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((key) => window.localStorage.getItem(key) ?? "", WEB_STATE_KEY))
    .toContain(text);
}

const COMBOS = [
  { style: "glass", lang: "en" },
  { style: "dense", lang: "pt-BR" },
] as const;

for (const { style, lang } of COMBOS) {
  test.describe(`the name of a pane (${style}, ${lang})`, () => {
    test("two panes opened by different actions show both names in the headers and the sidebar", async ({
      page,
    }) => {
      const words = await start(page, lang, style);
      await splitOfTwoActions(page, words);

      await expect(headerNames(page)).toHaveText(["Loop Noren", "Dev server"]);
      await expect(rowNames(page)).toHaveText(["Loop Noren", "Dev server"]);
      // The name comes before the folder in the header.
      const header = panes(page).first().locator('[data-nr-part="pane-bar"]');
      const name = await box(header.locator('[data-nr-part="pane-name"]'));
      const folder = await box(header.locator('[data-nr-part="pane-folder"]'));
      expect(name.x).toBeLessThan(folder.x);
    });

    test("F2 on a pane row renames it in the header and the sidebar, and a reload keeps the names", async ({
      page,
    }) => {
      const words = await start(page, lang, style);
      await splitOfTwoActions(page, words);
      await expect(rowNames(page)).toHaveText(["Loop Noren", "Dev server"]);

      await paneRows(page).nth(1).focus();
      await page.keyboard.press("F2");
      const field = page.getByRole("textbox", { name: words.nameField, exact: true });
      await expect(field).toBeVisible();
      await expect(field).toHaveValue("Dev server");
      await field.fill("API watcher");
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);

      await expect(headerNames(page)).toHaveText(["Loop Noren", "API watcher"]);
      await expect(rowNames(page)).toHaveText(["Loop Noren", "API watcher"]);
      // The keyboard is back on the row that was renamed.
      await expect(paneRows(page).nth(1)).toBeFocused();

      await saved(page, "API watcher");
      await page.reload();
      await expect(panes(page)).toHaveCount(2);
      await expect(headerNames(page)).toHaveText(["Loop Noren", "API watcher"]);
      await expect(rowNames(page)).toHaveText(["Loop Noren", "API watcher"]);
    });

    test("Escape leaves the name as it was, and a blank name takes it away", async ({ page }) => {
      const words = await start(page, lang, style);
      await splitOfTwoActions(page, words);

      await paneRows(page).nth(0).focus();
      await page.keyboard.press("F2");
      const field = page.getByRole("textbox", { name: words.nameField, exact: true });
      await field.fill("Something else");
      await page.keyboard.press("Escape");
      await expect(field).toHaveCount(0);
      await expect(headerNames(page)).toHaveText(["Loop Noren", "Dev server"]);

      await paneRows(page).nth(0).focus();
      await page.keyboard.press("F2");
      await field.fill("   ");
      await page.keyboard.press("Enter");
      await expect(headerNames(page)).toHaveText(["Dev server"]);
      await expect(rowNames(page)).toHaveText(["Dev server"]);
    });

    test("the menu of the terminal renames the pane in its header", async ({ page }) => {
      const words = await start(page, lang, style);
      await expect(panes(page)).toHaveCount(1);
      await expect(headerNames(page)).toHaveCount(0);

      await panes(page)
        .first()
        .locator(".xterm-screen")
        .click({
          button: "right",
          position: { x: 60, y: 30 },
        });
      await page.getByRole("menuitem", { name: words.rename, exact: true }).click();
      const field = page.getByRole("textbox", { name: words.nameField, exact: true });
      await expect(field).toBeVisible();
      await field.fill("Scratch");
      await page.keyboard.press("Enter");
      await expect(headerNames(page)).toHaveText(["Scratch"]);
      await saved(page, "Scratch");
    });
  });
}
