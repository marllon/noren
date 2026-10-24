import { expectNoAxeViolations } from "./axe-fixture";
import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedConfig } from "./settings-fixture";

// Opening a preview from the output (NOR-F15-02b). A path in the output of a terminal, absolute or
// relative to the folder of the pane, is a link: with Ctrl held (Cmd on a Mac) a click opens a
// preview pane beside the terminal and the keyboard stays where it was. These tests run on the
// `FakeBackend` of web mode with a saved state of one terminal in a folder and the files of the
// fake computer seeded in the browser storage before the page loads (as `preview-pane.spec.ts`
// does). They hold: that the terminal draws the paths as links and the click opens the right file
// (an absolute path, a relative one, one with `:line:column`), that a click without Ctrl opens
// nothing, that no shell starts for the pane and the keyboard stays with the terminal, that a path
// that cannot be opened and a tab with no room say so and make no pane, that the pane is there
// after a reload, that a Ctrl+click on an address still opens a browser pane, and that the notices
// speak both languages. The canvas of the terminal cannot be read, so "underlined" is read from
// what xterm does when the pointer is over a link: it puts `xterm-cursor-pointer` on the terminal.

interface Hook {
  paneIds(): string[];
  focusedPaneId(): string | undefined;
  sendOutput(paneId: string, text: string): boolean;
  split(dir: "row" | "column", paneId?: string): string | undefined;
  sessionStarts(): unknown[];
  previewReads(): string[];
  openedLinks(): string[];
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_STATE_KEY = "noren.web.state";
const WEB_FILES_KEY = "noren.web.files";
const FOLDER = "/fixtures/preview";
const CLEAR = "\x1b[2J\x1b[H";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/preview/${name}`, import.meta.url));
const NOTES = fixture("notes.md");
const LOG = fixture("log.txt");
const PICTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));

const FILES: Record<string, Buffer | null> = {
  [`${FOLDER}/notes.md`]: NOTES,
  [`${FOLDER}/pixel.png`]: PICTURE,
  [`${FOLDER}/log.txt`]: LOG,
  [`${FOLDER}/sub`]: null,
};

/** The saved state: one space, one tab, one terminal (in `cwd` when given). */
function savedState(cwd: string | undefined): string {
  const pane = {
    id: "t1",
    type: "terminal",
    profileId: "default",
    status: "idle",
    unread: false,
    bell: false,
    ...(cwd !== undefined ? { cwd } : {}),
  };
  return JSON.stringify({
    version: 2,
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
    spaces: [
      {
        id: "s1",
        name: "Main",
        icon: "terminal",
        color: "#6b8afd",
        modIds: [],
        defaults: { env: {} },
        aiEnabled: true,
        saveScrollback: false,
        pinned: [],
        tree: [{ kind: "item", id: "i1" }],
        items: {
          i1: {
            id: "i1",
            title: "work",
            titleLocked: true,
            layout: { kind: "pane", pane },
            focusedPaneId: "t1",
            lastActivityAt: 1,
          },
        },
        activeItemId: "i1",
      },
    ],
  });
}

/** Puts the saved workspace and the files in the browser storage before the page loads (once). */
async function seed(page: Page, cwd: string | undefined): Promise<void> {
  const encoded = Object.fromEntries(
    Object.entries(FILES).map(([path, bytes]) => [
      path,
      bytes === null ? null : bytes.toString("base64"),
    ]),
  );
  await page.addInitScript(
    ({ stateKey, state, filesKey, stored }) => {
      if (window.localStorage.getItem(stateKey) !== null) return;
      window.localStorage.setItem(stateKey, state);
      window.localStorage.setItem(filesKey, JSON.stringify(stored));
    },
    { stateKey: WEB_STATE_KEY, state: savedState(cwd), filesKey: WEB_FILES_KEY, stored: encoded },
  );
}

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const focusedPaneId = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.focusedPaneId());
const shells = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts().length ?? 0);
const reads = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.previewReads() ?? []);
const openedLinks = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.openedLinks() ?? []);
const savedText = (page: Page): Promise<string> =>
  page.evaluate((key) => window.localStorage.getItem(key) ?? "", WEB_STATE_KEY);

/** The panes of the saved state, as the file has them. */
async function savedPanes(
  page: Page,
): Promise<{ id: string; type: string; path?: string; sessionId?: string }[]> {
  interface Saved {
    spaces: { items: Record<string, { layout: unknown }> }[];
  }
  const panes: { id: string; type: string; path?: string; sessionId?: string }[] = [];
  const walk = (node: unknown): void => {
    const n = node as { kind: string; pane?: (typeof panes)[number]; children?: unknown[] };
    if (n.kind === "pane" && n.pane) panes.push(n.pane);
    n.children?.forEach(walk);
  };
  const state = JSON.parse(await savedText(page)) as Saved;
  for (const space of state.spaces) {
    for (const item of Object.values(space.items)) walk(item.layout);
  }
  return panes;
}

/** Opens the app on the seeded state; waits until the one terminal is there and has drawn. */
async function start(page: Page, cwd: string | null = FOLDER): Promise<void> {
  await seed(page, cwd ?? undefined);
  await page.goto("/");
  await expect.poll(() => paneIds(page)).toEqual(["t1"]);
  await expect.poll(() => shells(page)).toBe(1);
  await expect(page.locator(".xterm-screen:visible").first()).toBeVisible();
}

async function print(page: Page, text: string): Promise<void> {
  // xterm remembers the links of the row the pointer was last over until the pointer goes to
  // another row; output that changes the row under a pointer that stays is not what is tested here.
  const box = await page.locator(".xterm-screen:visible").first().boundingBox();
  if (box !== null) await page.mouse.move(box.x + 20, box.y + 120);
  const sent = await page.evaluate(
    ({ id, bytes }) => (window as HookWindow).__norenTest?.sendOutput(id, bytes) ?? false,
    { id: "t1", bytes: CLEAR + text },
  );
  expect(sent).toBe(true);
}

/** The screen of the terminal on view, whose class says whether the pointer is over a link. */
const terminal = (page: Page): Locator => page.locator(".xterm-screen:visible").first();

/** Moves the pointer onto the first row of the first terminal, `x` pixels from its left edge. */
async function pointAt(page: Page, x: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(".xterm-screen:visible").first().boundingBox();
  if (box === null) throw new Error("the terminal is not on screen");
  const point = { x: box.x + x, y: box.y + 6 };
  await page.mouse.move(point.x - 12, point.y);
  await page.mouse.move(point.x, point.y);
  return point;
}

/** Clicks the first row of the terminal, with Ctrl held or not. */
async function clickFirstRow(page: Page, x: number, withCtrl: boolean): Promise<void> {
  const point = await pointAt(page, x);
  if (withCtrl) await page.keyboard.down("Control");
  try {
    await page.mouse.click(point.x, point.y);
  } finally {
    if (withCtrl) await page.keyboard.up("Control");
  }
}

const previewPane = (page: Page): Locator => page.locator('[data-nr-part="preview-pane"]:visible');
const previewBody = (page: Page): Locator =>
  previewPane(page).locator('[data-nr-part="preview-body"]');
const previewPath = (page: Page): Locator =>
  previewPane(page).locator('[data-nr-part="preview-path"]');
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
const browserPane = (page: Page): Locator => page.locator('[data-nr-part="browser-pane"]');

/** What the person sees happen after a Ctrl+click that was not taken: nothing. */
async function expectNothingOpened(page: Page): Promise<void> {
  // The notice and the panes settle in the render after the click.
  await page.waitForTimeout(300);
  expect(await paneIds(page)).toEqual(["t1"]);
  await expect(previewPane(page)).toHaveCount(0);
  await expect(browserPane(page)).toHaveCount(0);
}

test.describe("a path in the output", () => {
  test("is a link where the pointer is over it and not where it is not", async ({ page }) => {
    await start(page);
    await print(page, `${FOLDER}/notes.md and some words after it`);
    await pointAt(page, 40);
    await expect(terminal(page)).toHaveClass(/xterm-cursor-pointer/);
    // Past the end of the path, over the words that follow.
    await pointAt(page, 400);
    await expect(terminal(page)).not.toHaveClass(/xterm-cursor-pointer/);
    // A relative path is a link here because the pane has a folder.
    await print(page, "./notes.md");
    await pointAt(page, 30);
    await expect(terminal(page)).toHaveClass(/xterm-cursor-pointer/);
    // A word with no folder and no extension is not.
    await print(page, "plain words only");
    await pointAt(page, 30);
    await expect(terminal(page)).not.toHaveClass(/xterm-cursor-pointer/);
  });

  test("Ctrl+click on an absolute path opens the file in a preview pane beside the terminal", async ({
    page,
  }) => {
    await start(page);
    await print(page, `wrote ${FOLDER}/notes.md just now`);
    await clickFirstRow(page, 120, true);
    await expect(previewPane(page)).toBeVisible();

    // The right file, drawn by the preview pane, with its full path on top.
    await expect(previewPath(page)).toContainText(`${FOLDER}/notes.md`);
    await expect(previewBody(page).locator("h3")).toHaveText("Notes");

    // Beside the terminal, to its right, and the terminal is still there.
    const ids = await paneIds(page);
    expect(ids).toHaveLength(2);
    const terminalBox = await page.locator(".xterm-screen:visible").first().boundingBox();
    const previewBox = await previewPane(page).boundingBox();
    if (terminalBox === null || previewBox === null) throw new Error("a pane is not on screen");
    expect(previewBox.x).toBeGreaterThanOrEqual(terminalBox.x + terminalBox.width - 1);

    // The file is in the saved state by its full path, and the pane has no session.
    await expect
      .poll(async () => (await savedPanes(page)).filter((pane) => pane.type === "preview"))
      .toEqual([expect.objectContaining({ type: "preview", path: `${FOLDER}/notes.md` })]);
    const saved = await savedPanes(page);
    expect(saved.find((pane) => pane.type === "preview")?.sessionId).toBeUndefined();

    // No new shell, the file read once, and nothing taken to another program.
    expect(await shells(page)).toBe(1);
    expect(await reads(page)).toEqual([`${FOLDER}/notes.md`]);
    expect(await openedLinks(page)).toEqual([]);
    await expect(page.getByRole("alertdialog", { name: "Open link" })).toHaveCount(0);

    // The keyboard stayed with the terminal.
    expect(await focusedPaneId(page)).toBe("t1");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          return (
            active?.classList.contains("xterm-helper-textarea") === true &&
            active.closest('[data-nr-part="preview-pane"]') === null
          );
        }),
      )
      .toBe(true);
  });

  test("Ctrl+click on a relative path opens it against the folder of the pane", async ({
    page,
  }) => {
    await start(page);
    await print(page, "./pixel.png");
    await clickFirstRow(page, 30, true);
    await expect(previewPane(page)).toBeVisible();
    await expect(previewPath(page)).toContainText(`${FOLDER}/pixel.png`);
    // The picture was drawn from the bytes of the file.
    const image = previewBody(page).locator("img");
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await savedPanes(page)).find((pane) => pane.type === "preview")?.path)
      .toBe(`${FOLDER}/pixel.png`);
    expect(await shells(page)).toBe(1);
  });

  test("with ../ in it reads the path against the folder of the pane and writes it out whole", async ({
    page,
  }) => {
    await start(page, `${FOLDER}/sub`);
    await print(page, "../log.txt");
    await clickFirstRow(page, 30, true);
    await expect(previewPane(page)).toBeVisible();
    await expect(previewPath(page)).toContainText(`${FOLDER}/log.txt`);
    await expect
      .poll(async () => (await savedPanes(page)).find((pane) => pane.type === "preview")?.path)
      .toBe(`${FOLDER}/log.txt`);
  });

  test("with a :line:column after it opens the file", async ({ page }) => {
    await start(page);
    await print(page, `at ${FOLDER}/log.txt:12:5: failed`);
    // Over the suffix, which is part of the link.
    await clickFirstRow(page, 4 * 9 + 24 * 9 + 6, true);
    await expect(previewPane(page)).toBeVisible();
    await expect(previewPath(page)).toContainText(`${FOLDER}/log.txt`);
    await expect(previewPath(page)).not.toContainText(":12");
    await expect
      .poll(async () => (await savedPanes(page)).find((pane) => pane.type === "preview")?.path)
      .toBe(`${FOLDER}/log.txt`);
  });

  test("a click without Ctrl opens nothing", async ({ page }) => {
    await start(page);
    await print(page, `${FOLDER}/notes.md and ./pixel.png`);
    await clickFirstRow(page, 40, false);
    await expectNothingOpened(page);
    expect(await openedLinks(page)).toEqual([]);
    await expect(notice(page)).toHaveAttribute("data-nr-state", "empty");
    expect(await reads(page)).toEqual([]);
  });

  test("is read from the screen, not from a disk: hovering reads no file", async ({ page }) => {
    await start(page);
    await print(page, `${FOLDER}/notes.md`);
    await pointAt(page, 40);
    await pointAt(page, 60);
    await pointAt(page, 80);
    await expect(terminal(page)).toHaveClass(/xterm-cursor-pointer/);
    expect(await reads(page)).toEqual([]);
  });

  test("a relative path is no link in a pane that has no folder", async ({ page }) => {
    await start(page, null);
    await print(page, "./notes.md");
    await pointAt(page, 30);
    await expect(terminal(page)).not.toHaveClass(/xterm-cursor-pointer/);
    await clickFirstRow(page, 30, true);
    await expectNothingOpened(page);
    await expect(notice(page)).toHaveAttribute("data-nr-state", "empty");
    // An absolute path is still one.
    await print(page, `${FOLDER}/notes.md`);
    await clickFirstRow(page, 40, true);
    await expect(previewPane(page)).toBeVisible();
  });

  test("a path the preview does not open says why and makes no pane", async ({ page }) => {
    await start(page, "\\\\server\\share\\work");
    await print(page, "./notes.md");
    await pointAt(page, 30);
    await expect(terminal(page)).toHaveClass(/xterm-cursor-pointer/);
    await clickFirstRow(page, 30, true);
    await expect(notice(page)).toHaveText(
      "That path is on the network, and network and device paths are not previewed.",
    );
    await expectNothingOpened(page);
    expect(await reads(page)).toEqual([]);
    expect(await shells(page)).toBe(1);
    // A path that is complete is not held back by the folder.
    await print(page, `${FOLDER}/notes.md`);
    await clickFirstRow(page, 40, true);
    await expect(previewPane(page)).toBeVisible();
  });

  test("a tab with no room says so and makes no pane", async ({ page }) => {
    // The limit of the settings (`terminal.maxPanes`) is four here; the default is eight.
    await seedConfig(page, '{ "terminal": { "maxPanes": 4 } }');
    await start(page);
    // Four panes is the most a tab holds: three more terminals below the first.
    for (let i = 0; i < 3; i++) {
      const added = await page.evaluate(() =>
        (window as HookWindow).__norenTest?.split("column", "t1"),
      );
      expect(added).toBeTruthy();
    }
    await expect.poll(async () => (await paneIds(page)).length).toBe(4);
    const startsBefore = await shells(page);
    await print(page, `${FOLDER}/notes.md`);
    await clickFirstRow(page, 40, true);
    await expect(notice(page)).toHaveText(
      "A tab holds at most 4 panes, so the preview was not opened.",
    );
    await page.waitForTimeout(300);
    expect(await paneIds(page)).toHaveLength(4);
    await expect(previewPane(page)).toHaveCount(0);
    expect(await shells(page)).toBe(startsBefore);
    expect(await reads(page)).toEqual([]);
  });

  test("is there again after a reload", async ({ page }) => {
    await start(page);
    await print(page, `${FOLDER}/notes.md`);
    await clickFirstRow(page, 40, true);
    await expect(previewPane(page)).toBeVisible();
    await expect.poll(async () => (await savedPanes(page)).length).toBe(2);

    await page.reload();
    await expect.poll(async () => (await paneIds(page)).length).toBe(2);
    await expect(previewPane(page)).toBeVisible();
    await expect(previewPath(page)).toContainText(`${FOLDER}/notes.md`);
    await expect(previewBody(page).locator("h3")).toHaveText("Notes");
    // One shell for the terminal; the preview pane starts none.
    await expect.poll(() => shells(page)).toBe(1);
  });

  test("a Ctrl+click on an address still opens a browser pane and the address is not read as a path", async ({
    page,
  }) => {
    await start(page);
    await print(page, "https://example.com/docs/notes.md");
    await clickFirstRow(page, 60, true);
    await expect(browserPane(page)).toBeVisible();
    await expect(previewPane(page)).toHaveCount(0);
    expect(await paneIds(page)).toHaveLength(2);
    // The text of the address was not read as a path: no preview pane in the saved state either.
    expect((await savedPanes(page)).filter((pane) => pane.type === "preview")).toEqual([]);
    // The keyboard is with the terminal and the address is not in the question either.
    await expect(page.getByRole("alertdialog", { name: "Open link" })).toHaveCount(0);
  });

  test("a click on an address without Ctrl still asks", async ({ page }) => {
    await start(page);
    await print(page, "https://example.com/docs/notes.md");
    await clickFirstRow(page, 60, false);
    await expect(page.getByRole("alertdialog", { name: "Open link" })).toBeVisible();
    expect(await paneIds(page)).toEqual(["t1"]);
  });

  test("axe: no violation with the preview open and the notice shown", async ({ page }) => {
    await start(page, "\\\\server\\share\\work");
    await print(page, "./notes.md");
    await clickFirstRow(page, 30, true);
    await expect(notice(page)).toHaveAttribute("data-nr-state", "shown");
    await print(page, `${FOLDER}/notes.md`);
    await clickFirstRow(page, 40, true);
    await expect(previewPane(page)).toBeVisible();
    await expect(previewBody(page).locator("h3")).toHaveText("Notes");
    await expectNoAxeViolations(page, "preview opened from the output");
  });
});

test.describe("in Portuguese", () => {
  test.use({ locale: "pt-BR" });

  test("the notices of a path that is not opened say why in the language", async ({ page }) => {
    await start(page, "\\\\server\\share\\work");
    await print(page, "./notes.md");
    await clickFirstRow(page, 30, true);
    await expect(notice(page)).toHaveText(
      "Esse caminho está na rede, e caminhos de rede e de dispositivo não têm prévia.",
    );
    await expectNothingOpened(page);
  });

  test("the notice of a full tab speaks Portuguese", async ({ page }) => {
    // The limit of the settings (`terminal.maxPanes`) is four here; the default is eight.
    await seedConfig(page, '{ "terminal": { "maxPanes": 4 } }');
    await start(page);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => (window as HookWindow).__norenTest?.split("column", "t1"));
    }
    await expect.poll(async () => (await paneIds(page)).length).toBe(4);
    await print(page, `${FOLDER}/notes.md`);
    await clickFirstRow(page, 40, true);
    await expect(notice(page)).toHaveText(
      "Uma aba tem no máximo 4 painéis, então a prévia não foi aberta.",
    );
  });

  test("Ctrl+click on a path opens the preview pane in Portuguese", async ({ page }) => {
    await start(page);
    await print(page, `${FOLDER}/notes.md`);
    await clickFirstRow(page, 40, true);
    await expect(previewPane(page)).toHaveAttribute("aria-label", "Prévia de arquivo");
  });
});
