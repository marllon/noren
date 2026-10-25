import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";

// The Projects section of the sidebar (NOR-F20-29): a block for each space that has a valid
// `.noren/actions.json` with an action, closed to one line (a state dot, the name of the space and
// the Start or Stop button of its main action), opened by a click on the name. The button runs the
// action in its own space without bringing that space on screen. The seeded workspace: Alpha (the
// active space; main action "Loop", the first), Beta (main action "Worker", marked `main`) and
// Gamma (one action), each with a folder and a file; "Delta" has a folder and a file that is not valid
// and "Epsilon" has no folder, so neither has a block.

const WEB_STATE_KEY = "noren.web.state";
const WEB_ACTIONS_KEY = "noren.web.actions";

const FILES: Record<string, string> = {
  "/srv/alpha": JSON.stringify({
    actions: [
      { id: "loop", label: "Loop", command: "loop", stop: "loop parar", tab: "loop" },
      { id: "dev", label: "Dev server", command: "pnpm dev", tab: "dev" },
    ],
  }),
  "/srv/beta": JSON.stringify({
    actions: [
      { id: "api", label: "API", command: "pnpm api", tab: "api" },
      { id: "worker", label: "Worker", command: "pnpm worker", tab: "worker", main: true },
      { id: "tests", label: "Tests", command: "pnpm test", tab: "tests" },
    ],
  }),
  "/srv/gamma": JSON.stringify({
    actions: [{ id: "web", label: "Web", command: "pnpm web", tab: "web" }],
  }),
  "/srv/delta": '{ "actions": [ { "id": "x" } ] }',
};

interface Words {
  lang: "en" | "pt-BR";
  region: string;
  /** The name of the Start and Stop buttons, for an action of a space. */
  start(action: string, space: string): string;
  stop(action: string, space: string): string;
  runButton: string;
  none: string;
  showIn: string;
  menu(space: string): string;
}

const WORDS: Record<Words["lang"], Words> = {
  en: {
    lang: "en",
    region: "Projects",
    start: (action, space) => `Start ${action} in ${space}`,
    stop: (action, space) => `Stop ${action} in ${space}`,
    runButton: "Run",
    none: "No other actions",
    showIn: "Show in Projects",
    menu: (space) => `${space} options`,
  },
  "pt-BR": {
    lang: "pt-BR",
    region: "Projetos",
    start: (action, space) => `Iniciar ${action} em ${space}`,
    stop: (action, space) => `Parar ${action} em ${space}`,
    runButton: "Executar",
    none: "Nenhuma outra ação",
    showIn: "Mostrar em Projetos",
    menu: (space) => `Opções de ${space}`,
  },
};

function tab(id: string, title: string, paneId: string) {
  return {
    id,
    title,
    titleLocked: true,
    layout: {
      kind: "pane",
      pane: {
        id: paneId,
        type: "terminal",
        profileId: "default",
        status: "idle",
        unread: false,
        bell: false,
      },
    },
    focusedPaneId: paneId,
    lastActivityAt: 1,
  };
}

const SPACES: { id: string; name: string; color: string; cwd?: string }[] = [
  { id: "a", name: "Alpha", color: "#5EE6C8", cwd: "/srv/alpha" },
  { id: "b", name: "Beta", color: "#A99BFF", cwd: "/srv/beta" },
  { id: "c", name: "Gamma", color: "#F5B84B", cwd: "/srv/gamma" },
  { id: "d", name: "Delta", color: "#FF8FA3", cwd: "/srv/delta" },
  { id: "e", name: "Epsilon", color: "#5EE6C8" },
];

function stateText(): string {
  return JSON.stringify({
    version: 2,
    activeSpaceId: "a",
    favorites: [],
    closed: [],
    archive: [],
    spaces: SPACES.map((space) => ({
      id: space.id,
      name: space.name,
      icon: "terminal",
      color: space.color,
      modIds: [],
      defaults: { env: {}, ...(space.cwd !== undefined ? { cwd: space.cwd } : {}) },
      aiEnabled: true,
      saveScrollback: true,
      pinned: [],
      tree: [{ kind: "item", id: `${space.id}1` }],
      items: { [`${space.id}1`]: tab(`${space.id}1`, `${space.name} shell`, `${space.id}p1`) },
      activeItemId: `${space.id}1`,
    })),
  });
}

async function start(page: Page, lang: Words["lang"], style: "glass" | "dense" = "glass") {
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
  await expect(section(page)).toBeVisible();
  return WORDS[lang];
}

const section = (page: Page) => page.locator('[data-nr-part="projects"]');
const blocks = (page: Page) => section(page).locator('[data-nr-part="project"]');
const block = (page: Page, space: string) =>
  blocks(page).filter({ has: page.locator(".project-name-text", { hasText: space }) });
const nameOf = (page: Page, space: string) =>
  block(page, space).locator('[data-nr-part="project-name"]');
const button = (page: Page, name: string) =>
  section(page).getByRole("button", { name, exact: true });
const switcher = (page: Page) => page.getByRole("navigation", { name: /Spaces|Espaços/ });
const spaceButton = (page: Page, name: string) =>
  switcher(page).getByRole("button", { name, exact: true });

async function confirmRun(page: Page, words: Words): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: words.runButton, exact: true }).click();
  await expect(dialog).toBeHidden();
}

const height = async (locator: Locator): Promise<number> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the element has no box");
  return box.height;
};

for (const style of ["glass", "dense"] as const) {
  for (const lang of ["en", "pt-BR"] as const) {
    test.describe(`projects section (${style}, ${lang})`, () => {
      test("lists a block for each space with actions, closed to one line, in the order of the spaces", async ({
        page,
      }) => {
        const words = await start(page, lang, style);
        await expect(section(page)).toHaveAccessibleName(words.region);
        await expect(blocks(page).locator(".project-name-text")).toHaveText([
          "Alpha",
          "Beta",
          "Gamma",
        ]);
        // One line each: the blocks are as tall as each other and show no action row.
        const heights = await Promise.all([0, 1, 2].map((n) => height(blocks(page).nth(n))));
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
        await expect(section(page).locator(".project-action")).toHaveCount(0);
        // The header of the active space is gone: the actions are not drawn twice.
        await expect(page.locator('[data-nr-part="space-header"]')).toHaveCount(0);
        await expect(blocks(page).locator('[data-nr-indicator="running"]')).toHaveCount(0);
      });

      test("the active space is marked, and the others are not", async ({ page }) => {
        await start(page, lang, style);
        await expect(blocks(page).nth(0)).toHaveAttribute("aria-current", "true");
        await expect(blocks(page).nth(1)).not.toHaveAttribute("aria-current", "true");
        await expect(blocks(page).nth(2)).not.toHaveAttribute("aria-current", "true");
      });

      test("the button runs the main action: the marked one, else the first", async ({ page }) => {
        const words = await start(page, lang, style);
        await expect(button(page, words.start("Loop", "Alpha"))).toBeVisible();
        await expect(button(page, words.start("Worker", "Beta"))).toBeVisible();
        await expect(button(page, words.start("Web", "Gamma"))).toBeVisible();
        await expect(button(page, words.start("API", "Beta"))).toHaveCount(0);
      });

      test("starting an action of a space that is not on screen runs it there and keeps the active space", async ({
        page,
      }) => {
        const words = await start(page, lang, style);
        await button(page, words.start("Worker", "Beta")).click();
        await confirmRun(page, words);
        await expect(button(page, words.stop("Worker", "Beta"))).toBeVisible();
        await expect(block(page, "Beta")).toHaveAttribute("data-nr-state", "running");
        await expect(
          block(page, "Beta").locator('[data-nr-indicator="running"]').first(),
        ).toBeVisible();
        // The other blocks stay idle, and the space on screen is still Alpha.
        await expect(block(page, "Alpha")).toHaveAttribute("data-nr-state", "idle");
        await expect(block(page, "Alpha")).toHaveAttribute("aria-current", "true");
        await expect(block(page, "Beta")).not.toHaveAttribute("aria-current", "true");
        await expect(spaceButton(page, "Alpha")).toHaveAttribute("aria-current", "true");
        await expect(spaceButton(page, "Beta")).not.toHaveAttribute("aria-current", "true");
        // The tab of the action is in Beta, not in Alpha.
        await spaceButton(page, "Beta").click();
        await expect(page.getByRole("treeitem", { name: /worker/i })).toBeVisible();
      });

      test("the first run still asks, and cancelling runs nothing", async ({ page }) => {
        const words = await start(page, lang, style);
        await button(page, words.start("Web", "Gamma")).click();
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(block(page, "Gamma")).toHaveAttribute("data-nr-state", "idle");
        await expect(button(page, words.start("Web", "Gamma"))).toBeVisible();
      });

      test("stops the action of a space that is not on screen", async ({ page }) => {
        const words = await start(page, lang, style);
        await button(page, words.start("Web", "Gamma")).click();
        await confirmRun(page, words);
        await button(page, words.stop("Web", "Gamma")).click();
        await expect(button(page, words.start("Web", "Gamma"))).toBeVisible();
        await expect(block(page, "Gamma")).toHaveAttribute("data-nr-state", "idle");
        await expect(spaceButton(page, "Alpha")).toHaveAttribute("aria-current", "true");
      });

      test("a click on the name opens the block with the other actions, and the choice is kept", async ({
        page,
      }) => {
        const words = await start(page, lang, style);
        await expect(nameOf(page, "Beta")).toHaveAttribute("aria-expanded", "false");
        await nameOf(page, "Beta").click();
        await expect(nameOf(page, "Beta")).toHaveAttribute("aria-expanded", "true");
        await expect(block(page, "Beta").locator(".project-action-label")).toHaveText([
          "API",
          "Tests",
        ]);
        // The others are as the main one: their own button, in the space of the block.
        await expect(button(page, words.start("API", "Beta"))).toBeVisible();
        await expect(block(page, "Alpha").locator(".project-action")).toHaveCount(0);
        // Opening does not change the active space.
        await expect(spaceButton(page, "Alpha")).toHaveAttribute("aria-current", "true");

        await page.reload();
        await expect(nameOf(page, "Beta")).toHaveAttribute("aria-expanded", "true");
        await expect(nameOf(page, "Alpha")).toHaveAttribute("aria-expanded", "false");
        await nameOf(page, "Beta").click();
        await expect(nameOf(page, "Beta")).toHaveAttribute("aria-expanded", "false");
        await expect(block(page, "Beta").locator(".project-action")).toHaveCount(0);
      });

      test("a block with only its main action says there are no others", async ({ page }) => {
        const words = await start(page, lang, style);
        await nameOf(page, "Gamma").click();
        await expect(block(page, "Gamma")).toContainText(words.none);
      });

      test("an action of another space starts from its own row of an open block", async ({
        page,
      }) => {
        const words = await start(page, lang, style);
        await nameOf(page, "Beta").click();
        await button(page, words.start("Tests", "Beta")).click();
        await confirmRun(page, words);
        await expect(button(page, words.stop("Tests", "Beta"))).toBeVisible();
        // Some action runs: the dot of the closed line would be lit.
        await expect(block(page, "Beta")).toHaveAttribute("data-nr-state", "running");
        await expect(button(page, words.start("Worker", "Beta"))).toBeVisible();
        await expect(spaceButton(page, "Alpha")).toHaveAttribute("aria-current", "true");
      });

      test("Show in Projects is on by default and takes the space out of the list when turned off", async ({
        page,
      }) => {
        const words = await start(page, lang, style);
        await spaceButton(page, "Beta").click({ button: "right" });
        const menu = page.getByRole("menu", { name: words.menu("Beta"), exact: true });
        await expect(menu).toBeVisible();
        const item = menu.getByRole("menuitemcheckbox", { name: words.showIn, exact: true });
        await expect(item).toHaveAttribute("aria-checked", "true");
        await item.click();
        await expect(item).toHaveAttribute("aria-checked", "false");
        await page.keyboard.press("Escape");
        await expect(blocks(page).locator(".project-name-text")).toHaveText(["Alpha", "Gamma"]);

        await page.reload();
        await expect(blocks(page).locator(".project-name-text")).toHaveText(["Alpha", "Gamma"]);

        await spaceButton(page, "Beta").click({ button: "right" });
        await menu.getByRole("menuitemcheckbox", { name: words.showIn, exact: true }).click();
        await page.keyboard.press("Escape");
        await expect(blocks(page).locator(".project-name-text")).toHaveText([
          "Alpha",
          "Beta",
          "Gamma",
        ]);
      });
    });
  }
}

test.describe("projects section: the files", () => {
  test("a space whose file is not valid, or that has no folder, has no block, and a file that turns valid gets one", async ({
    page,
  }) => {
    await start(page, "en");
    await expect(blocks(page)).toHaveCount(3);
    await page.evaluate(
      ({ key, files }) => {
        window.localStorage.setItem(
          key,
          JSON.stringify({
            ...files,
            "/srv/delta": JSON.stringify({
              actions: [{ id: "x", label: "X", command: "x", tab: "x" }],
            }),
          }),
        );
      },
      { key: WEB_ACTIONS_KEY, files: FILES },
    );
    // The files are read again every 2 seconds.
    await expect(blocks(page)).toHaveCount(4, { timeout: 15_000 });
    await expect(blocks(page).locator(".project-name-text")).toHaveText([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
    ]);
  });

  test("a file with no action, or a file that goes away, takes the block with it", async ({
    page,
  }) => {
    await start(page, "en");
    await page.evaluate(
      ({ key, files }) => {
        const next = { ...files, "/srv/gamma": JSON.stringify({ actions: [] }) };
        delete (next as Record<string, string>)["/srv/beta"];
        window.localStorage.setItem(key, JSON.stringify(next));
      },
      { key: WEB_ACTIONS_KEY, files: FILES },
    );
    await expect(blocks(page).locator(".project-name-text")).toHaveText(["Alpha"], {
      timeout: 15_000,
    });
  });

  test("a state saved before the section opens with every space listed and closed", async ({
    page,
  }) => {
    await start(page, "en");
    const saved = await page.evaluate(
      (key) => JSON.parse(window.localStorage.getItem(key) ?? "{}") as { spaces: object[] },
      WEB_STATE_KEY,
    );
    for (const space of saved.spaces) {
      expect("inProjects" in space).toBe(false);
      expect("projectsOpen" in space).toBe(false);
    }
    await expect(blocks(page)).toHaveCount(3);
    await expect(section(page).locator(".project-action")).toHaveCount(0);
  });
});
