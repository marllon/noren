import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// The media of the README (NOR-F12-03): one run of a script over the web demo, with a fixed window,
// that writes the screenshots and the video into `docs/media/` under stable names. It is not a test
// of the app (`e2e/demo/` is); it only fails when the script cannot run to its end. The AI side is
// the fake provider of the web build: a fake model list seeded here and a canned answer, so nothing
// reaches a network or the keychain of the system. Run it with `pnpm media`.

const WIDTH = 1280;
const HEIGHT = 800;
const MEDIA = resolve(process.cwd(), "docs", "media");
/** Where the browser drops the video until the context closes. */
const VIDEO_TMP = resolve(process.cwd(), "test-results", "media-video");

const WEB_CONFIG_KEY = "noren.web.config";
const WEB_AI_OLLAMA_KEY = "noren.web.ai-ollama";
/** The AI on, the fake Ollama named for Ask. */
const CONFIG = `{
  "ai": { "enabled": true, "defaults": { "ask": { "provider": "ollama", "model": "llama3" } } }
}
`;
/** What the fake provider answers, drawn as Markdown in the Ask panel. */
const ANSWER = [
  "To see the biggest files first, sort the listing by size:",
  "",
  "```sh",
  "ls -lS",
  "```",
  "",
  "Add `-h` for sizes people can read. Noren never runs this for you: put it at the prompt and press Enter.",
].join("\n");

interface Hook {
  paneIds(): string[];
  paneLines(paneId: string): string[];
  setAiReply(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const spaces = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string): Locator =>
  spaces(page).getByRole("button", { name, exact: true });
const tree = (page: Page): Locator => page.getByRole("tree", { name: "Tabs", exact: true });
const row = (page: Page, name: string | RegExp): Locator =>
  tree(page).getByRole("treeitem", { name }).first();
const panes = (page: Page): Locator => page.locator('[data-nr-part="pane"]:visible');
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const searchBox = (page: Page): Locator =>
  palette(page).getByRole("combobox", { name: "Command palette", exact: true });
const ask = (page: Page): Locator => page.getByRole("complementary", { name: "Ask", exact: true });

const paneLines = (page: Page, paneId: string): Promise<string[]> =>
  page.evaluate((id) => (window as HookWindow).__norenTest?.paneLines(id) ?? [], paneId);
const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);

/** A pause for the video to show what just happened; the screenshots do not need it. */
const beat = (page: Page, ms = 700): Promise<void> => page.waitForTimeout(ms);

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(MEDIA, `${name}.png`) });
}

/** Types a command in the pane on screen that holds the pointer and waits for its output. */
async function runIn(page: Page, pane: Locator, command: string, expected: string): Promise<void> {
  await pane.click();
  await page.keyboard.type(command, { delay: 60 });
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const ids = await paneIds(page);
      for (const id of ids) if ((await paneLines(page, id)).includes(expected)) return true;
      return false;
    })
    .toBe(true);
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
}

test("records the screenshots and the video of the README", async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(MEDIA, { recursive: true });
  rmSync(VIDEO_TMP, { recursive: true, force: true });

  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    locale: "en-US",
    colorScheme: "dark",
    recordVideo: { dir: VIDEO_TMP, size: { width: WIDTH, height: HEIGHT } },
  });
  const page = await context.newPage();
  await page.addInitScript(
    ({ configKey, config, ollamaKey, ollama }) => {
      if (window.localStorage.getItem(configKey) === null) {
        window.localStorage.setItem(configKey, config);
        window.localStorage.setItem(ollamaKey, ollama);
      }
    },
    {
      configKey: WEB_CONFIG_KEY,
      config: CONFIG,
      ollamaKey: WEB_AI_OLLAMA_KEY,
      ollama: JSON.stringify(["llama3"]),
    },
  );

  // 1. The demo opens on the first space: a pinned tab, a group and a tab split in two panes.
  await page.goto("/");
  await expect(panes(page)).toHaveCount(2);
  await expect.poll(async () => (await paneIds(page)).length).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const ids = await paneIds(page);
      const first = ids[0];
      return first === undefined ? false : (await paneLines(page, first)).length > 0;
    })
    .toBe(true);
  await runIn(page, panes(page).first(), "ls", "README.md  notes.txt  src");
  await runIn(page, panes(page).nth(1), "echo server ready", "server ready");
  await beat(page, 1200);
  await shoot(page, "01-overview");

  // 2. Spaces: each one has its own theme, and the theme shows while the space is active.
  await spaceButton(page, "Docs").click();
  await expect(spaceButton(page, "Docs")).toHaveAttribute("data-nr-state", "active");
  await beat(page, 1200);
  await shoot(page, "02-space-docs");
  await spaceButton(page, "Lab").click();
  await expect(spaceButton(page, "Lab")).toHaveAttribute("data-nr-state", "active");
  await beat(page, 1200);
  await shoot(page, "03-space-lab");
  await spaceButton(page, "Code").click();
  await expect(spaceButton(page, "Code")).toHaveAttribute("data-nr-state", "active");
  await beat(page);

  // 3. A tab dragged onto a pane joins it in a split.
  await row(page, "api").click();
  await expect(panes(page)).toHaveCount(1);
  await beat(page);
  const target = await box(panes(page).first());
  const from = await box(row(page, "scratch"));
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 10, start.y, { steps: 3 });
  await page.mouse.move(target.x + target.width * 0.9, target.y + target.height * 0.5, {
    steps: 25,
  });
  await expect(page.locator('[data-nr-part="pane-drop-zone"]')).toBeVisible();
  await beat(page, 900);
  await shoot(page, "04-drag-to-split");
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(2);
  // The panes of a joined tab are mounted anew: give each one a line so the shot is not empty.
  await runIn(page, panes(page).first(), "echo api tab", "api tab");
  await runIn(page, panes(page).nth(1), "echo scratch tab", "scratch tab");
  await beat(page, 1000);
  await shoot(page, "05-split");

  // 4. The command palette, then the theme of the space changed from it.
  await panes(page).first().click();
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await expect(searchBox(page)).toBeFocused();
  await page.keyboard.type("split", { delay: 90 });
  await beat(page, 900);
  await shoot(page, "06-palette");
  await searchBox(page).fill(">set theme for this space");
  await expect(palette(page).getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette(page).locator('[data-nr-kind="space-theme"]')).toHaveCount(9);
  await searchBox(page).fill("noren oat");
  await expect(palette(page).getByRole("option")).toHaveCount(1);
  await beat(page, 1200);
  await shoot(page, "07-theme-preview");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await beat(page, 1200);
  await shoot(page, "08-theme-switched");

  // 5. Ask: the question is previewed before anything is sent; the answer comes from the fake provider.
  await page.evaluate((text) => (window as HookWindow).__norenTest?.setAiReply(text), ANSWER);
  await panes(page).first().click();
  await page.keyboard.press("Control+Shift+A");
  await expect(ask(page)).toBeVisible();
  const question = ask(page).getByRole("textbox", { name: "Question", exact: true });
  await expect(question).toBeFocused();
  await page.keyboard.type("How do I list the biggest files first?", { delay: 50 });
  await beat(page, 500);
  await question.press("Enter");
  const preview = ask(page).getByRole("region", {
    name: "Preview of what will be sent",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await beat(page, 1000);
  await shoot(page, "09-ask-preview");
  await preview.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    ask(page).locator('[data-nr-part="ask-exchange"][data-nr-state="done"]'),
  ).toHaveCount(1);
  await beat(page, 1500);
  await shoot(page, "10-ask-answer");

  // The video is written when the context closes; it keeps a stable name.
  const video = page.video();
  await context.close();
  if (video === null) throw new Error("the browser recorded no video");
  await video.saveAs(resolve(MEDIA, "noren-demo.webm"));
  await video.delete();
  rmSync(VIDEO_TMP, { recursive: true, force: true });
});
