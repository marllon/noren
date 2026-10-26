import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";

// The state of a project action follows the pane its command runs in, not the tab (NOR-F20-33).
// The case that found it: a tab opened by the action "Loop Simbora" is split, the loop of the other
// action is started in the new pane, and the first pane is closed. The tab lives on with one pane,
// which runs the other loop: the Projects section must show "Loop Simbora" idle and "Loop Noren"
// running, and stopping "Loop Noren" ends only that pane. The seeded space "Alpha" has both actions
// and one shell tab.

const WEB_STATE_KEY = "noren.web.state";
const WEB_ACTIONS_KEY = "noren.web.actions";

const FILES: Record<string, string> = {
  "/srv/alpha": JSON.stringify({
    actions: [
      { id: "simbora", label: "Loop Simbora", command: "loop simbora", tab: "simbora" },
      { id: "noren", label: "Loop Noren", command: "loop noren", tab: "noren" },
    ],
  }),
};

interface Words {
  lang: "en" | "pt-BR";
  runButton: string;
  start(action: string): string;
  stop(action: string): string;
  closePane: string;
}

const WORDS: Record<Words["lang"], Words> = {
  en: {
    lang: "en",
    runButton: "Run",
    start: (action) => `Start ${action} in Alpha`,
    stop: (action) => `Stop ${action} in Alpha`,
    closePane: "Close pane",
  },
  "pt-BR": {
    lang: "pt-BR",
    runButton: "Executar",
    start: (action) => `Iniciar ${action} em Alpha`,
    stop: (action) => `Parar ${action} em Alpha`,
    closePane: "Fechar painel",
  },
};

interface Hook {
  paneIds(): string[];
  split(dir: "row" | "column", paneId?: string): string | undefined;
  sendOutput(paneId: string, text: string): boolean;
}
type HookWindow = Window & { __norenTest?: Hook };

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
  await seedConfig(
    page,
    `{ ${language}"appearance": { "style": "${style}", "paneHeaders": true } }\n`,
  );
  await page.addInitScript(
    ({ stateKey, state, actionsKey, files }) => {
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
const button = (page: Page, name: string): Locator =>
  projects(page).getByRole("button", { name, exact: true });
const panes = (page: Page) => page.locator('[data-nr-part="pane"]:visible');
const frame = (page: Page, paneId: string) => page.locator(`[data-pane-id="${paneId}"]`);

async function confirmRun(page: Page, words: Words): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: words.runButton, exact: true }).click();
  await expect(dialog).toBeHidden();
}

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);

/** What the shell of a pane reports when it starts a command: the line, then the start. */
const reportCommand = (page: Page, paneId: string, line: string): Promise<boolean> =>
  page.evaluate(
    ({ pane, text }) => (window as HookWindow).__norenTest?.sendOutput(pane, text) ?? false,
    { pane: paneId, text: `\u001b]633;E;${line}\u0007\u001b]133;C\u0007` },
  );

const COMBOS = [
  { style: "glass", lang: "en" },
  { style: "dense", lang: "pt-BR" },
] as const;

for (const { style, lang } of COMBOS) {
  test.describe(`the state of an action follows its pane (${style}, ${lang})`, () => {
    test("a split, the other loop in the new pane and the first pane closed: the first idle, the second running, and Stop ends only the new pane", async ({
      page,
    }) => {
      const words = await start(page, lang, style);

      // Open the tab with "Loop Simbora" (the main action of the space) and wait for its loop.
      await button(page, words.start("Loop Simbora")).click();
      await confirmRun(page, words);
      await expect(button(page, words.stop("Loop Simbora"))).toBeVisible();
      await expect(panes(page)).toHaveCount(1);
      const [original] = await paneIds(page);
      if (original === undefined) throw new Error("the tab has no pane");

      // Split it, and run the other loop in the new pane, as typed by hand.
      const fresh = await page.evaluate(
        () => (window as HookWindow).__norenTest?.split("row") ?? "",
      );
      expect(fresh).not.toBe("");
      await expect(panes(page)).toHaveCount(2);
      await expect.poll(() => reportCommand(page, fresh, "loop noren")).toBe(true);

      // Both lit: the block of the space shows the other action once it is opened.
      await projects(page).locator('[data-nr-part="project-name"]').click();
      await expect(button(page, words.stop("Loop Noren"))).toBeVisible();
      await expect(button(page, words.stop("Loop Simbora"))).toBeVisible();

      // The first pane is closed; the tab stays open with the new pane.
      await frame(page, original)
        .getByRole("button", { name: words.closePane, exact: true })
        .click();
      await expect(panes(page)).toHaveCount(1);
      expect(await paneIds(page)).toEqual([fresh]);
      await expect(button(page, words.start("Loop Simbora"))).toBeVisible();
      await expect(button(page, words.stop("Loop Noren"))).toBeVisible();
      await expect(projects(page).locator('[data-nr-part="project"]')).toHaveAttribute(
        "data-nr-state",
        "running",
      );

      // Stop ends the session of the pane of "Loop Noren"; nothing is left running.
      await button(page, words.stop("Loop Noren")).click();
      await expect(button(page, words.start("Loop Noren"))).toBeVisible();
      await expect(button(page, words.start("Loop Simbora"))).toBeVisible();
      await expect(projects(page).locator('[data-nr-part="project"]')).toHaveAttribute(
        "data-nr-state",
        "idle",
      );
    });

    test("a split pane does not take the action, and closing it leaves the action running", async ({
      page,
    }) => {
      const words = await start(page, lang, style);
      await button(page, words.start("Loop Simbora")).click();
      await confirmRun(page, words);
      await expect(button(page, words.stop("Loop Simbora"))).toBeVisible();

      const fresh = await page.evaluate(
        () => (window as HookWindow).__norenTest?.split("row") ?? "",
      );
      await expect(panes(page)).toHaveCount(2);
      await expect(button(page, words.stop("Loop Simbora"))).toBeVisible();
      // The split pane has no name of the action.
      await expect(frame(page, fresh).locator('[data-nr-part="pane-name"]')).toHaveCount(0);

      await frame(page, fresh).getByRole("button", { name: words.closePane, exact: true }).click();
      await expect(panes(page)).toHaveCount(1);
      await expect(button(page, words.stop("Loop Simbora"))).toBeVisible();
    });
  });
}
