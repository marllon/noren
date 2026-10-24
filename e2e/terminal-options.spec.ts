import { expect, test } from "./test";
import type { Page } from "@playwright/test";
import { WEB_CONFIG_KEY, configText, openShortcutsScreen, seedConfig } from "./settings-fixture";
import { chooseFirstOption, openCommandPalette } from "./palette-fixture";

// The terminal takes its font, cursor, scrollback and bell from the `terminal` settings of
// config.jsonc, and Ctrl+= / Ctrl+- / Ctrl+0 zoom the font of every terminal of the window without
// writing the file. The web build keeps the text of the file under `noren.web.config`; the test
// hook `setConfig` replaces it the way an editor saving the file would, and `terminalDrawing` /
// `paneDrawing` read what xterm itself draws with.

interface Drawing {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: string;
  cursorBlink: boolean;
  scrollback: number;
}

interface Hook {
  setConfig(text: string | null): void;
  terminalDrawing(): Drawing | undefined;
  paneDrawing(paneId: string): Drawing | undefined;
  paneIds(): string[];
  focusedPaneId(): string | undefined;
  lines(): string[];
  viewport(): { top: number; rows: number };
  sendOutput(paneId: string, text: string): boolean;
  sessionStarts(): unknown[];
  killedSessions(): number[];
  configSaves(): number;
  split(dir: "row" | "column", paneId?: string): string | undefined;
}
type HookWindow = Window & { __norenTest?: Hook; __beeps?: number };

const BEL = "\x07";

/** What the terminal had before the options existed. */
const BEFORE = {
  fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 14,
  lineHeight: 1,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10_000,
} satisfies Drawing;

const drawing = (page: Page): Promise<Drawing | undefined> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.terminalDrawing());
const drawingOf = (page: Page, paneId: string): Promise<Drawing | undefined> =>
  page.evaluate((id) => (window as HookWindow).__norenTest?.paneDrawing(id), paneId);
const size = (page: Page): Promise<number | undefined> => drawing(page).then((d) => d?.fontSize);
const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const rows = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.viewport().rows ?? 0);
const lineCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines().length ?? 0);
const setConfig = (page: Page, text: string | null): Promise<void> =>
  page.evaluate((value) => (window as HookWindow).__norenTest?.setConfig(value), text);
const send = (page: Page, text: string): Promise<boolean> =>
  page.evaluate((value) => {
    const hook = (window as HookWindow).__norenTest;
    const id = hook?.focusedPaneId();
    return id !== undefined && hook?.sendOutput(id, value) === true;
  }, text);
const sessionStarts = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts().length ?? -1);
const killed = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.killedSessions() ?? []);
const configSaves = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.configSaves() ?? -1);

/**
 * Counts how many times a pane lit up: the light lasts a fraction of a second, so the test watches
 * the class being added instead of hoping to look at the right moment.
 */
async function watchFlashes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as HookWindow & { __flashes?: number };
    w.__flashes = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as Element;
        const was = record.oldValue?.split(" ").includes("bell-flash") ?? false;
        if (!was && target.classList.contains("bell-flash")) w.__flashes = (w.__flashes ?? 0) + 1;
      }
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
      attributeOldValue: true,
      subtree: true,
    });
  });
}
const flashes = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow & { __flashes?: number }).__flashes ?? -1);
const lit = (page: Page) => page.locator(".terminal-view.bell-flash");
const notice = (page: Page) => page.locator('[data-nr-part="config-notice"]');

/** Opens the app, with a settings file already on disk when given, and gives the terminal the keyboard. */
async function open(page: Page, file?: string): Promise<void> {
  if (file !== undefined) await seedConfig(page, file);
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await expect.poll(() => drawing(page)).toBeDefined();
  await page.locator('[data-nr-part="pane"]:visible').click();
}

test.describe("the options from the file", () => {
  test("with no file the terminal is what it was before the options existed", async ({ page }) => {
    await open(page);
    expect(await drawing(page)).toEqual(BEFORE);
  });

  test("a file with a terminal section sets the font, the cursor and the scrollback", async ({
    page,
  }) => {
    await open(
      page,
      `{
  "terminal": {
    "font": { "family": "Fira Code, JetBrains Mono, monospace", "size": 18, "lineHeight": 1.5 },
    "cursor": { "style": "bar", "blink": false },
    "scrollback": 123,
  },
}`,
    );
    expect(await drawing(page)).toEqual({
      fontFamily: '"Fira Code", "JetBrains Mono", monospace',
      fontSize: 18,
      lineHeight: 1.5,
      cursorStyle: "bar",
      cursorBlink: false,
      scrollback: 123,
    });
  });

  test("the rows of the terminal follow the size of the font from the file", async ({ page }) => {
    await open(page, '{ "terminal": { "font": { "size": 10 } } }');
    const small = await rows(page);
    await setConfig(page, '{ "terminal": { "font": { "size": 24 } } }');
    await expect.poll(() => rows(page)).toBeLessThan(small);
  });

  test("the cursor and the scrollback change when the file does, and the session goes on", async ({
    page,
  }) => {
    await open(page, '{ "terminal": { "cursor": { "style": "bar" }, "scrollback": 123 } }');
    // Something is typed and printed first: it must still be there after the reload.
    await page.keyboard.type("echo still-here");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.lines().join("\n")))
      .toContain("still-here");
    const starts = await sessionStarts(page);

    await setConfig(
      page,
      '{ "terminal": { "cursor": { "style": "underline", "blink": false }, "scrollback": 456 } }',
    );
    await expect
      .poll(() => drawing(page))
      .toMatchObject({ cursorStyle: "underline", cursorBlink: false, scrollback: 456 });

    // The same terminal and the same session: nothing started, nothing killed, the text is there.
    expect(await sessionStarts(page)).toBe(starts);
    expect(await killed(page)).toEqual([]);
    expect(
      await page.evaluate(() => (window as HookWindow).__norenTest?.lines().join("\n")),
    ).toContain("still-here");
    await setConfig(page, null);
    await expect.poll(() => drawing(page)).toEqual(BEFORE);
    expect(await sessionStarts(page)).toBe(starts);
    expect(await killed(page)).toEqual([]);
  });

  test("the scrollback decides how many lines the terminal keeps", async ({ page }) => {
    await open(page, '{ "terminal": { "scrollback": 50 } }');
    expect(await send(page, "line\r\n".repeat(400))).toBe(true);
    // The screen and no more than 50 lines above it.
    await expect.poll(() => lineCount(page)).toBeGreaterThan(50);
    const kept = await lineCount(page);
    const screen = await rows(page);
    expect(kept).toBeLessThanOrEqual(screen + 50);

    // A larger scrollback in the file keeps more of what comes next.
    await setConfig(page, '{ "terminal": { "scrollback": 1000 } }');
    await expect.poll(() => drawing(page).then((d) => d?.scrollback)).toBe(1000);
    expect(await send(page, "more\r\n".repeat(400))).toBe(true);
    await expect.poll(() => lineCount(page)).toBeGreaterThan(screen + 300);
  });
});

test.describe("a file that is not valid", () => {
  test("a font that is an address is refused with its line, and the last font stays", async ({
    page,
  }) => {
    await open(page, '{ "terminal": { "font": { "size": 16, "family": "Consolas" } } }');
    expect(await drawing(page)).toMatchObject({ fontSize: 16, fontFamily: "Consolas" });

    await setConfig(
      page,
      `{
  "terminal": {
    "font": {
      "family": "url(https://example.com/font.woff)"
    }
  }
}`,
    );
    const problem = page.locator('[data-nr-part="config-notice-error"]');
    await expect(notice(page)).toBeVisible();
    await expect(problem).toContainText("line 4");
    await expect(problem).toContainText("terminal.font.family");
    // Nothing of it reached the terminal.
    expect(await drawing(page)).toMatchObject({ fontSize: 16, fontFamily: "Consolas" });

    // A semicolon and a brace are no better.
    for (const family of ["Consolas; color: red", "Consolas } body { display: none"]) {
      await setConfig(page, `{ "terminal": { "font": { "family": ${JSON.stringify(family)} } } }`);
      await expect(problem).toContainText("terminal.font.family");
      expect(await drawing(page)).toMatchObject({ fontFamily: "Consolas" });
    }

    // A valid file puts the notice away and takes effect.
    await setConfig(page, '{ "terminal": { "font": { "family": "Hack, monospace" } } }');
    await expect(notice(page)).toHaveCount(0);
    await expect.poll(() => drawing(page).then((d) => d?.fontFamily)).toBe("Hack, monospace");
  });

  test("a size out of range and a line height under 1 are refused with their line", async ({
    page,
  }) => {
    await open(page, '{ "terminal": { "font": { "size": 16 } } }');
    const problem = page.locator('[data-nr-part="config-notice-error"]');
    await setConfig(page, '{\n  "terminal": {\n    "font": { "size": 300 }\n  }\n}');
    await expect(problem).toContainText("line 3");
    await expect(problem).toContainText("terminal.font.size");
    await setConfig(page, '{\n  "terminal": {\n    "font": { "lineHeight": 0.5 }\n  }\n}');
    await expect(problem).toContainText("terminal.font.lineHeight");
    expect(await drawing(page)).toMatchObject({ fontSize: 16, lineHeight: 1 });
  });
});

test.describe("the zoom of the font", () => {
  test("Ctrl+= makes it bigger, Ctrl+- smaller and Ctrl+0 goes back to the size of the file", async ({
    page,
  }) => {
    await open(page, '{ "terminal": { "font": { "size": 16 } } }');
    expect(await size(page)).toBe(16);

    await page.keyboard.press("Control+Equal");
    await expect.poll(() => size(page)).toBe(17);
    await page.keyboard.press("Control+Equal");
    await expect.poll(() => size(page)).toBe(18);
    await page.keyboard.press("Control+Minus");
    await expect.poll(() => size(page)).toBe(17);
    await page.keyboard.press("Control+Minus");
    await page.keyboard.press("Control+Minus");
    await page.keyboard.press("Control+Minus");
    await expect.poll(() => size(page)).toBe(14);
    await page.keyboard.press("Control+0");
    await expect.poll(() => size(page)).toBe(16);
  });

  test("Ctrl+0 goes back to the default size when the file sets none", async ({ page }) => {
    await open(page);
    await page.keyboard.press("Control+Equal");
    await expect.poll(() => size(page)).toBe(15);
    await page.keyboard.press("Control+0");
    await expect.poll(() => size(page)).toBe(14);
  });

  test("it is not written to the file", async ({ page }) => {
    const file = '{ "terminal": { "font": { "size": 16 } } }';
    await open(page, file);
    await page.keyboard.press("Control+Equal");
    await page.keyboard.press("Control+Equal");
    await expect.poll(() => size(page)).toBe(18);
    await page.keyboard.press("Control+0");
    await expect.poll(() => size(page)).toBe(16);
    expect(await configText(page)).toBe(file);
    expect(await configSaves(page)).toBe(0);
  });

  test("the grid fits the new size: bigger text means fewer rows, and smaller more", async ({
    page,
  }) => {
    await open(page);
    const normal = await rows(page);
    for (let i = 0; i < 6; i++) await page.keyboard.press("Control+Equal");
    await expect.poll(() => size(page)).toBe(20);
    await expect.poll(() => rows(page)).toBeLessThan(normal);
    await page.keyboard.press("Control+0");
    await expect.poll(() => rows(page)).toBe(normal);
    for (let i = 0; i < 6; i++) await page.keyboard.press("Control+Minus");
    await expect.poll(() => size(page)).toBe(8);
    await expect.poll(() => rows(page)).toBeGreaterThan(normal);
  });

  test("it stops at the smallest and the largest size", async ({ page }) => {
    await open(page, '{ "terminal": { "font": { "size": 70 } } }');
    for (let i = 0; i < 6; i++) await page.keyboard.press("Control+Equal");
    await expect.poll(() => size(page)).toBe(72);
    // One press back moves one step at once.
    await page.keyboard.press("Control+Minus");
    await expect.poll(() => size(page)).toBe(71);
    await page.keyboard.press("Control+0");
    await expect.poll(() => size(page)).toBe(70);

    await setConfig(page, '{ "terminal": { "font": { "size": 8 } } }');
    await expect.poll(() => size(page)).toBe(8);
    for (let i = 0; i < 5; i++) await page.keyboard.press("Control+Minus");
    await expect.poll(() => size(page)).toBe(6);
    await page.keyboard.press("Control+Equal");
    await expect.poll(() => size(page)).toBe(7);
  });

  test("it reaches every terminal of the window: the panes of a tab and the other tabs", async ({
    page,
  }) => {
    await open(page);
    const first = (await paneIds(page))[0] ?? "";
    const second = await page.evaluate(() => (window as HookWindow).__norenTest?.split("row"));
    if (second === undefined) throw new Error("the split was refused");
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(2);
    await expect.poll(() => drawingOf(page, second)).toBeDefined();

    // A second tab, so the first one is hidden when the zoom happens.
    await page.keyboard.press("Control+Shift+T");
    await expect.poll(() => paneIds(page)).toHaveLength(1);
    await expect.poll(() => paneIds(page)).not.toContain(first);
    await expect.poll(() => size(page)).toBe(14);
    await page.locator('[data-nr-part="pane"]:visible').click();

    await page.keyboard.press("Control+Equal");
    await page.keyboard.press("Control+Equal");
    await expect.poll(() => size(page)).toBe(16);
    expect((await drawingOf(page, first))?.fontSize).toBe(16);
    expect((await drawingOf(page, second))?.fontSize).toBe(16);

    await page.keyboard.press("Control+0");
    await expect.poll(() => size(page)).toBe(14);
    expect((await drawingOf(page, first))?.fontSize).toBe(14);
    expect((await drawingOf(page, second))?.fontSize).toBe(14);
  });

  test("a terminal opened after the zoom has the zoomed size", async ({ page }) => {
    await open(page);
    await page.keyboard.press("Control+Equal");
    await page.keyboard.press("Control+Equal");
    await page.keyboard.press("Control+Equal");
    await expect.poll(() => size(page)).toBe(17);
    await page.keyboard.press("Control+Shift+T");
    await expect(
      page.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem"),
    ).toHaveCount(2);
    await page.locator('[data-nr-part="pane"]:visible').click();
    await expect.poll(() => size(page)).toBe(17);
  });

  test("it keeps its steps over a size that the file changes", async ({ page }) => {
    await open(page, '{ "terminal": { "font": { "size": 14 } } }');
    await page.keyboard.press("Control+Equal");
    await page.keyboard.press("Control+Equal");
    await expect.poll(() => size(page)).toBe(16);
    await setConfig(page, '{ "terminal": { "font": { "size": 20 } } }');
    await expect.poll(() => size(page)).toBe(22);
    await page.keyboard.press("Control+0");
    await expect.poll(() => size(page)).toBe(20);
  });

  test("it does not start or end a session, and the key never reaches the shell", async ({
    page,
  }) => {
    await open(page);
    const starts = await sessionStarts(page);
    const writes = await page.evaluate(() =>
      (window as Window & { __norenTest?: { writeCalls(): number } }).__norenTest?.writeCalls(),
    );
    await page.keyboard.press("Control+Equal");
    await page.keyboard.press("Control+Minus");
    await page.keyboard.press("Control+0");
    await expect.poll(() => size(page)).toBe(14);
    expect(await sessionStarts(page)).toBe(starts);
    expect(await killed(page)).toEqual([]);
    expect(
      await page.evaluate(() =>
        (window as Window & { __norenTest?: { writeCalls(): number } }).__norenTest?.writeCalls(),
      ),
    ).toBe(writes);
  });

  test("the palette lists the three actions with their keys and runs them", async ({ page }) => {
    await open(page);
    await openCommandPalette(page);
    const palette = page.locator('[data-nr-part="palette"]');
    await expect(palette).toBeVisible();
    await page.getByRole("combobox", { name: "Command palette", exact: true }).fill("font size");
    const options = palette.getByRole("option");
    await expect(options).toHaveCount(3);
    await expect(options.filter({ hasText: "Increase font size" })).toContainText("Ctrl+=");
    await expect(options.filter({ hasText: "Decrease font size" })).toContainText("Ctrl+-");
    await expect(options.filter({ hasText: "Reset font size" })).toContainText("Ctrl+0");

    await options.filter({ hasText: "Increase font size" }).click();
    await expect(palette).toBeHidden();
    await expect.poll(() => size(page)).toBe(15);

    await openCommandPalette(page);
    await page.getByRole("combobox", { name: "Command palette", exact: true }).fill("reset font");
    // Enter takes the row that is selected: wait for the list to be the filtered one, with its first
    // row selected, or the key runs the row the unfiltered list had selected.
    await chooseFirstOption(page, "Reset font size");
    await expect.poll(() => size(page)).toBe(14);
  });

  test("the shortcuts screen shows the three chords", async ({ page }) => {
    await open(page);
    const screen = await openShortcutsScreen(page);
    await expect(screen.getByLabel("Shortcut for Increase font size", { exact: true })).toHaveText(
      "Ctrl+=",
    );
    await expect(screen.getByLabel("Shortcut for Decrease font size", { exact: true })).toHaveText(
      "Ctrl+-",
    );
    await expect(screen.getByLabel("Shortcut for Reset font size", { exact: true })).toHaveText(
      "Ctrl+0",
    );
  });

  test("the config text is the same after a zoom and a reload of the page", async ({ page }) => {
    const file = '{ "terminal": { "font": { "size": 16 } } }';
    await open(page, file);
    await page.keyboard.press("Control+Equal");
    await expect.poll(() => size(page)).toBe(17);
    await page.reload();
    await expect.poll(() => size(page)).toBe(16);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), WEB_CONFIG_KEY)).toBe(
      file,
    );
  });
});

test.describe("the bell", () => {
  /** Counts the beeps: the page gets a stand-in for the audio output that only counts. */
  async function countBeeps(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as HookWindow).__beeps = 0;
      class CountingAudio {
        currentTime = 0;
        destination = {};
        state = "running";
        createOscillator() {
          (window as HookWindow).__beeps = ((window as HookWindow).__beeps ?? 0) + 1;
          return { frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
        }
        createGain() {
          return { gain: { value: 0 }, connect() {} };
        }
      }
      (window as unknown as { AudioContext: unknown }).AudioContext = CountingAudio;
    });
  }
  const beeps = (page: Page): Promise<number> =>
    page.evaluate(() => (window as HookWindow).__beeps ?? -1);

  test("does nothing visible or audible by default", async ({ page }) => {
    await countBeeps(page);
    await open(page);
    await watchFlashes(page);
    expect(await send(page, BEL)).toBe(true);
    await page.waitForTimeout(300);
    expect(await flashes(page)).toBe(0);
    expect(await beeps(page)).toBe(0);
  });

  test("visual: the pane lights up for a moment and then goes back", async ({ page }) => {
    await countBeeps(page);
    await open(page, '{ "terminal": { "bell": "visual" } }');
    await watchFlashes(page);
    expect(await send(page, BEL)).toBe(true);
    await expect.poll(() => flashes(page)).toBe(1);
    // It goes away by itself.
    await expect(lit(page)).toHaveCount(0);
    expect(await beeps(page)).toBe(0);
  });

  test("sound: it beeps and does not light the pane", async ({ page }) => {
    await countBeeps(page);
    await open(page, '{ "terminal": { "bell": "sound" } }');
    await watchFlashes(page);
    expect(await send(page, BEL)).toBe(true);
    await expect.poll(() => beeps(page)).toBe(1);
    await page.waitForTimeout(300);
    expect(await flashes(page)).toBe(0);
    expect(await send(page, BEL + BEL)).toBe(true);
    await expect.poll(() => beeps(page)).toBe(3);
  });

  test("both: it lights the pane and beeps", async ({ page }) => {
    await countBeeps(page);
    await open(page, '{ "terminal": { "bell": "both" } }');
    await watchFlashes(page);
    expect(await send(page, BEL)).toBe(true);
    await expect.poll(() => flashes(page)).toBe(1);
    await expect.poll(() => beeps(page)).toBe(1);
  });

  test("follows the file without a reload", async ({ page }) => {
    await countBeeps(page);
    await open(page, '{ "terminal": { "bell": "none" } }');
    expect(await send(page, BEL)).toBe(true);
    await page.waitForTimeout(300);
    expect(await beeps(page)).toBe(0);
    await setConfig(page, '{ "terminal": { "bell": "sound" } }');
    // The next bell is heard once the new setting is in force.
    await expect
      .poll(async () => {
        await send(page, BEL);
        return beeps(page);
      })
      .toBeGreaterThan(0);
  });

  test("a bell in a tab that is not on screen still marks the tab, whatever the style", async ({
    page,
  }) => {
    await countBeeps(page);
    await open(page, '{ "terminal": { "bell": "none" } }');
    const first = (await paneIds(page))[0] ?? "";
    await page.keyboard.press("Control+Shift+T");
    await expect(
      page.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem"),
    ).toHaveCount(2);
    const rang = await page.evaluate(
      (id) => (window as HookWindow).__norenTest?.sendOutput(id, "\x07"),
      first,
    );
    expect(rang).toBe(true);
    await expect(page.locator('[data-nr-part="item"] [data-nr-indicator="bell"]')).toHaveCount(1);
  });
});
