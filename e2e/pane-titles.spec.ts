import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";

// The title a program sets for its terminal (OSC 0 and OSC 2) names a pane that has no name of its own:
// it is written before the folder in the header of the pane and on its row in the sidebar; a name wins
// over it, a blank name brings it back, an empty title brings the folder back, and it is never saved.
// The fake backend plays the program: `sendOutput` makes the pane print the sequence.

const WEB_STATE_KEY = "noren.web.state";

interface Hook {
  sendOutput(paneId: string, text: string): boolean;
}
type HookWindow = Window & { __norenTest?: Hook };

const FIRST = "tp1";
const SECOND = "tp2";

interface Words {
  lang: "en" | "pt-BR";
  nameField: string;
}

const WORDS: Record<Words["lang"], Words> = {
  en: { lang: "en", nameField: "Pane name" },
  "pt-BR": { lang: "pt-BR", nameField: "Nome do painel" },
};

const leaf = (id: string) => ({
  kind: "pane",
  pane: {
    id,
    type: "terminal",
    profileId: "default",
    cwd: "/srv/alpha",
    status: "idle",
    unread: false,
    bell: false,
  },
});

/** One space with one tab: a split of two panes that share a folder, so only a title tells them apart. */
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
            title: "Servers",
            titleLocked: true,
            layout: {
              kind: "split",
              dir: "row",
              sizes: [50, 50],
              children: [leaf(FIRST), leaf(SECOND)],
            },
            focusedPaneId: FIRST,
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
    ({ stateKey, state }) => {
      if (window.localStorage.getItem(stateKey) !== null) return;
      window.localStorage.setItem(stateKey, state);
    },
    { stateKey: WEB_STATE_KEY, state: stateText() },
  );
  await page.goto("/");
  await expect(panes(page)).toHaveCount(2);
  return WORDS[lang];
}

const panes = (page: Page) => page.locator('[data-nr-part="pane"]:visible');
const paneRows = (page: Page) => page.locator('[data-nr-part="item-pane"]');
/** The titles written in the headers of the panes on screen, in layout order. */
const headerTitles = (page: Page) => page.locator('[data-nr-part="pane-program-title"]:visible');
const headerNames = (page: Page) => page.locator('[data-nr-part="pane-name"]:visible');
/** The titles written on the pane rows of the sidebar, in layout order. */
const rowTitles = (page: Page) => page.locator('[data-nr-part="item-pane-program"]');
const rowNames = (page: Page) => page.locator('[data-nr-part="item-pane-name"]');

/** The program of a pane sets the title of its terminal. */
async function setTitle(page: Page, paneId: string, sequence: string): Promise<void> {
  // The pane takes output once its session is up; the sequence is the same whenever it is sent.
  await expect
    .poll(() =>
      page.evaluate(
        ({ id, bytes }) => (window as HookWindow).__norenTest?.sendOutput(id, bytes) ?? false,
        { id: paneId, bytes: sequence },
      ),
    )
    .toBe(true);
}

const osc0 = (title: string): string => `\x1b]0;${title}\x07`;
const osc2 = (title: string): string => `\x1b]2;${title}\x07`;

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
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
  test.describe(`the title of a pane (${style}, ${lang})`, () => {
    test("a program that sets a title (OSC 0 or OSC 2) names its pane in the header and the sidebar", async ({
      page,
    }) => {
      await start(page, lang, style);
      await expect(headerTitles(page)).toHaveCount(0);
      await expect(rowTitles(page)).toHaveCount(0);

      await setTitle(page, FIRST, osc0("loop Noren"));
      await setTitle(page, SECOND, osc2("serve"));

      await expect(headerTitles(page)).toHaveText(["loop Noren", "serve"]);
      await expect(rowTitles(page)).toHaveText(["loop Noren", "serve"]);
      // The title comes before the folder, in the header.
      const header = panes(page).first().locator('[data-nr-part="pane-bar"]');
      const title = await box(header.locator('[data-nr-part="pane-program-title"]'));
      const folder = await box(header.locator('[data-nr-part="pane-folder"]'));
      expect(title.x).toBeLessThan(folder.x);
    });

    test("the title is replaced by the next one and an empty title brings the folder back", async ({
      page,
    }) => {
      await start(page, lang, style);
      await setTitle(page, FIRST, osc0("build"));
      await expect(headerTitles(page)).toHaveText(["build"]);
      await setTitle(page, FIRST, osc0("test"));
      await expect(headerTitles(page)).toHaveText(["test"]);
      await expect(rowTitles(page)).toHaveText(["test"]);

      await setTitle(page, FIRST, osc0(""));
      await expect(headerTitles(page)).toHaveCount(0);
      await expect(rowTitles(page)).toHaveCount(0);
    });

    test("a title that only says the folder adds nothing to it", async ({ page }) => {
      await start(page, lang, style);
      await setTitle(page, FIRST, osc0("/srv/alpha"));
      await setTitle(page, SECOND, osc0("shell"));
      await expect(headerTitles(page)).toHaveText(["shell"]);
      await expect(rowTitles(page)).toHaveText(["shell"]);
    });

    test("a name of its own wins over the title, and a blank name brings the title back", async ({
      page,
    }) => {
      const words = await start(page, lang, style);
      await setTitle(page, FIRST, osc0("loop Noren"));
      await expect(rowTitles(page)).toHaveText(["loop Noren"]);

      await paneRows(page).nth(0).focus();
      await page.keyboard.press("F2");
      const field = page.getByRole("textbox", { name: words.nameField, exact: true });
      await expect(field).toBeVisible();
      // The field starts from the name the pane has, which is none: the title is not a name.
      await expect(field).toHaveValue("");
      await field.fill("Loop");
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);

      await expect(headerNames(page)).toHaveText(["Loop"]);
      await expect(rowNames(page)).toHaveText(["Loop"]);
      await expect(headerTitles(page)).toHaveCount(0);
      await expect(rowTitles(page)).toHaveCount(0);

      // The title the program sets while the pane has a name waits behind it.
      await setTitle(page, FIRST, osc0("loop Noren again"));
      await expect(headerNames(page)).toHaveText(["Loop"]);
      await expect(headerTitles(page)).toHaveCount(0);

      await paneRows(page).nth(0).focus();
      await page.keyboard.press("F2");
      await expect(field).toHaveValue("Loop");
      await field.fill("   ");
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);
      await expect(headerNames(page)).toHaveCount(0);
      await expect(headerTitles(page)).toHaveText(["loop Noren again"]);
      await expect(rowTitles(page)).toHaveText(["loop Noren again"]);
    });

    test("a title is never saved: a reload brings the panes back with the folder", async ({
      page,
    }) => {
      const words = await start(page, lang, style);
      await setTitle(page, FIRST, osc0("secret-title"));
      await expect(headerTitles(page)).toHaveText(["secret-title"]);

      // A name saved after the title tells that the page saved the state with the title in it.
      await paneRows(page).nth(1).focus();
      await page.keyboard.press("F2");
      const field = page.getByRole("textbox", { name: words.nameField, exact: true });
      await field.fill("Marker");
      await page.keyboard.press("Enter");
      await saved(page, "Marker");
      const text = await page.evaluate(
        (key) => window.localStorage.getItem(key) ?? "",
        WEB_STATE_KEY,
      );
      expect(text).not.toContain("secret-title");

      await page.reload();
      await expect(panes(page)).toHaveCount(2);
      await expect(headerNames(page)).toHaveText(["Marker"]);
      await expect(headerTitles(page)).toHaveCount(0);
      await expect(rowTitles(page)).toHaveCount(0);
    });
  });
}
