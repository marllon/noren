import { expect, newServedContext, test } from "./test";
import type { Page } from "@playwright/test";

// The scrollback of a pane is saved when the window closes and every minute for the panes that had
// activity, and shown again, dimmed and under the line "session restored <date>", when the pane
// opens, with a new shell in the folder of the old one. A space or the settings of the app can say
// never: then nothing is written and a file saved before goes. The fake shell of web mode runs on a
// clock the page moves (`advanceClock`), and the files are kept in the browser storage, so a reload
// finds them again.

interface Hook {
  lines(): string[];
  paneLines(paneId: string): string[];
  paneDimLines(paneId: string): string[];
  paneIds(): string[];
  split(dir: "row" | "column", paneId?: string): string | undefined;
  sendOutput(paneId: string, text: string): boolean;
  writeCalls(): number;
  advanceClock(ms: number): void;
  setConfig(text: string | null): void;
  sessionStarts(): { profileId?: string; cwd?: string; env?: Record<string, string> }[];
  scrollbackFiles(): Record<string, string>;
  scrollbackCalls(): {
    method: "loadScrollback" | "saveScrollback" | "deleteScrollback";
    paneId: string;
  }[];
}
type HookWindow = Window & { __norenTest?: Hook };

// Keys of the browser storage of web mode (apps/desktop/src/web-backend.ts).
const WEB_STATE_KEY = "noren.web.state";
const WEB_CONFIG_KEY = "noren.web.config";
const WEB_SCROLLBACK_KEY = "noren.web.scrollback";

const PANE = "sbp1";
const FOLDER = "/srv/proj";
const MARKER = /^session restored \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const ESC = "\x1b";

interface Seed {
  /** `saveScrollback` of the space. Default true. */
  spaceSaves?: boolean;
  /** The pane records a snapshot file. */
  ref?: boolean;
  /** The text of `config.jsonc`. */
  config?: string;
  /** The snapshot files, by pane id. */
  files?: Record<string, string>;
}

/** One space, one tab and one pane in `FOLDER`, as a window that was closed would have left it. */
function savedState(options: Seed): string {
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
        saveScrollback: options.spaceSaves ?? true,
        pinned: [],
        tree: [{ kind: "item", id: "i1" }],
        items: {
          i1: {
            id: "i1",
            title: "work",
            titleLocked: true,
            layout: {
              kind: "pane",
              pane: {
                id: PANE,
                type: "terminal",
                profileId: "default",
                cwd: FOLDER,
                status: "idle",
                unread: false,
                bell: false,
                ...(options.ref ? { scrollbackRef: `${PANE}.txt` } : {}),
              },
            },
            focusedPaneId: PANE,
            lastActivityAt: 1,
          },
        },
        activeItemId: "i1",
      },
    ],
  });
}

/** Seeds the saved workspace, the settings and the snapshot files before the page loads (only once per test). */
async function seed(page: Page, options: Seed = {}): Promise<void> {
  await page.addInitScript(
    ({ stateKey, state, configKey, config, filesKey, files }) => {
      if (window.localStorage.getItem(stateKey) !== null) return;
      window.localStorage.setItem(stateKey, state);
      if (config !== undefined) window.localStorage.setItem(configKey, config);
      if (files !== undefined) window.localStorage.setItem(filesKey, JSON.stringify(files));
    },
    {
      stateKey: WEB_STATE_KEY,
      state: savedState(options),
      configKey: WEB_CONFIG_KEY,
      config: options.config,
      filesKey: WEB_SCROLLBACK_KEY,
      files: options.files,
    },
  );
}

const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);

const paneLines = (page: Page, paneId: string): Promise<string[]> =>
  page.evaluate((id) => (window as HookWindow).__norenTest?.paneLines(id) ?? [], paneId);

const paneDimLines = (page: Page, paneId: string): Promise<string[]> =>
  page.evaluate((id) => (window as HookWindow).__norenTest?.paneDimLines(id) ?? [], paneId);

const writeCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.writeCalls() ?? -1);

const files = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.scrollbackFiles() ?? {});

const calls = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.scrollbackCalls() ?? []);

/** The calls that wrote or removed a snapshot: the ones that must not happen when nothing is saved. */
const writes = (page: Page) =>
  page.evaluate(
    () =>
      (window as HookWindow).__norenTest
        ?.scrollbackCalls()
        .filter((call) => call.method !== "loadScrollback") ?? [],
  );

const sessionStarts = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts() ?? []);

const stored = (page: Page): Promise<string | null> =>
  page.evaluate((key) => window.localStorage.getItem(key), WEB_SCROLLBACK_KEY);

async function advance(page: Page, ms: number): Promise<void> {
  await page.evaluate((by) => (window as HookWindow).__norenTest?.advanceClock(by), ms);
}

async function waitForPrompt(page: Page): Promise<void> {
  await expect.poll(async () => (await lines(page)).some((l) => l.startsWith("fake$"))).toBe(true);
}

async function run(page: Page, line: string): Promise<void> {
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/** Waits until the terminal shows `text` on a line of its own. */
async function waitForLine(page: Page, text: string): Promise<void> {
  await expect.poll(async () => (await lines(page)).includes(text)).toBe(true);
}

async function waitForMarker(page: Page, count = 1): Promise<void> {
  await expect
    .poll(async () => (await lines(page)).filter((l) => MARKER.test(l)).length)
    .toBe(count);
}

test("output, a reload, and the old output comes back dimmed above the marker, with a new shell in the same folder", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/");
  await waitForPrompt(page);
  await run(page, "cd /var/work");
  await run(page, "echo old-output-one");
  await waitForLine(page, "old-output-one");
  await run(page, "echo old-output-two");
  await waitForLine(page, "old-output-two");

  // Closing the window saves it: not a minute has passed.
  expect(await writes(page)).toEqual([]);
  await page.reload();

  // The old output, the marker line and, under it, the prompt of the new shell, in this order.
  await waitForMarker(page);
  await waitForPrompt(page);
  const after = await lines(page);
  const first = after.indexOf("old-output-one");
  const second = after.indexOf("old-output-two");
  const marker = after.findIndex((l) => MARKER.test(l));
  const prompt = after.findIndex((l, i) => i > marker && l.startsWith("fake$"));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThan(first);
  expect(marker).toBeGreaterThan(second);
  expect(prompt).toBeGreaterThan(marker);
  // The commands typed before are in it too, as they were on screen.
  expect(after).toContain("fake$ echo old-output-one");

  // A new shell, started in the folder the old one had moved to.
  const starts = await sessionStarts(page);
  expect(starts).toHaveLength(1);
  expect(starts[0]?.cwd).toBe("/var/work");
  await run(page, "pwd");
  await expect
    .poll(async () => (await lines(page)).filter((l) => l === "/var/work").length)
    .toBeGreaterThan(0);

  // The old output is dimmed; what the new shell printed is not.
  const dim = await paneDimLines(page, PANE);
  expect(dim).toContain("old-output-two");
  expect(dim).toContain("fake$ echo old-output-one");
  expect(dim.some((l) => MARKER.test(l))).toBe(true);
  // What the new shell printed is not dim: its prompt, the command typed and the answer.
  expect(dim.some((l) => l.startsWith("fake$ pwd") || l === "/var/work")).toBe(false);
  expect((await lines(page)).slice(marker + 1).some((l) => l.startsWith("fake$"))).toBe(true);
});

test("a pane with output is saved at 60 seconds and not before, and not again until it prints", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/");
  await waitForPrompt(page);
  await run(page, "echo minute-one");
  await waitForLine(page, "minute-one");

  await advance(page, 59_000);
  expect(await writes(page)).toEqual([]);
  await advance(page, 1000);
  await expect.poll(async () => (await writes(page)).length).toBe(1);
  expect(await writes(page)).toEqual([{ method: "saveScrollback", paneId: PANE }]);
  const saved = (await files(page))[PANE] ?? "";
  expect(saved).toContain("minute-one");
  // A snapshot is text and colors only, whatever the terminal serialized.
  // eslint-disable-next-line no-control-regex
  expect(saved).toMatch(/^(?:[^\x00-\x1f\x7f-\x9f]|\t|\n|\x1b\[[0-9;:]*m)*$/);

  // Minutes with nothing printed save nothing.
  await advance(page, 60_000);
  await advance(page, 60_000);
  expect(await writes(page)).toHaveLength(1);

  // Output makes the next minute save again, with the new lines.
  await run(page, "echo minute-two");
  await waitForLine(page, "minute-two");
  await advance(page, 60_000);
  await expect.poll(async () => (await writes(page)).length).toBe(2);
  expect((await files(page))[PANE]).toContain("minute-two");
  expect((await files(page))[PANE]).toContain("minute-one");
});

test("only the panes that printed since their last snapshot are saved", async ({ page }) => {
  await seed(page);
  await page.goto("/");
  await waitForPrompt(page);
  await page.evaluate(() => (window as HookWindow).__norenTest?.split("row"));
  await expect.poll(async () => (await paneIds(page)).length).toBe(2);
  const [a = "", b = ""] = await paneIds(page);
  const print = (id: string, text: string) =>
    page.evaluate(({ id, text }) => (window as HookWindow).__norenTest?.sendOutput(id, text), {
      id,
      text,
    });
  // The new pane has a shell once its prompt is there; output can be sent to it only from then on.
  await expect
    .poll(async () => (await paneLines(page, b)).some((l) => l.startsWith("fake$")))
    .toBe(true);
  await print(a, "first in a\r\n");
  await print(b, "first in b\r\n");
  await expect
    .poll(async () => (await paneLines(page, a)).some((l) => l.includes("first in a")))
    .toBe(true);
  await expect
    .poll(async () => (await paneLines(page, b)).some((l) => l.includes("first in b")))
    .toBe(true);

  // Both printed: the first minute saves both.
  await advance(page, 60_000);
  await expect.poll(async () => (await writes(page)).length).toBe(2);
  expect((await writes(page)).map((c) => c.paneId).sort()).toEqual([a, b].sort());

  // Then only the second one prints.
  await print(b, "only here\r\n");
  await expect
    .poll(async () => (await paneLines(page, b)).some((l) => l.includes("only here")))
    .toBe(true);
  await advance(page, 60_000);
  await expect.poll(async () => (await writes(page)).length).toBe(3);
  expect((await writes(page)).at(-1)).toEqual({ method: "saveScrollback", paneId: b });
  expect((await files(page))[b]).toContain("only here");
  expect((await files(page))[a] ?? "").not.toContain("only here");
});

test("a space that never saves scrollback writes no file, in a minute or when the window closes", async ({
  page,
}) => {
  await seed(page, { spaceSaves: false });
  await page.goto("/");
  await waitForPrompt(page);
  await run(page, "echo secret-output");
  await waitForLine(page, "secret-output");

  await advance(page, 60_000);
  await advance(page, 60_000);
  // Not a save, not a removal: the backend is not even asked.
  expect(await writes(page)).toEqual([]);
  expect(await files(page)).toEqual({});

  // Closing the window writes nothing either, and the reload opens a pane with no old output.
  await page.reload();
  await waitForPrompt(page);
  expect(await stored(page)).toBeNull();
  expect((await lines(page)).some((l) => MARKER.test(l))).toBe(false);
  expect(await lines(page)).not.toContain("secret-output");
  expect(await writes(page)).toEqual([]);
});

test("the setting of the app that never saves writes no file, in a minute or when the window closes", async ({
  page,
}) => {
  await seed(page, { config: '{ "terminal": { "saveScrollback": false } }' });
  await page.goto("/");
  await waitForPrompt(page);
  await run(page, "echo secret-output");
  await waitForLine(page, "secret-output");

  await advance(page, 60_000);
  expect(await writes(page)).toEqual([]);

  await page.reload();
  await waitForPrompt(page);
  expect(await stored(page)).toBeNull();
  expect((await lines(page)).some((l) => MARKER.test(l))).toBe(false);
  expect(await writes(page)).toEqual([]);
});

test("a file saved before is not shown and is removed when the space says never", async ({
  page,
}) => {
  await seed(page, {
    spaceSaves: false,
    ref: true,
    files: { [PANE]: "old text that must not come back\nsecond line" },
  });
  await page.goto("/");
  await waitForPrompt(page);

  expect(await lines(page)).not.toContain("old text that must not come back");
  expect((await lines(page)).some((l) => MARKER.test(l))).toBe(false);
  // The file goes, and the pane stops recording it.
  await expect.poll(() => files(page)).toEqual({});
  expect(await writes(page)).toEqual([{ method: "deleteScrollback", paneId: PANE }]);
  expect(await stored(page)).toBeNull();
  // The old text was never read: a space that never saves has nothing to restore.
  expect((await calls(page)).filter((c) => c.method === "loadScrollback")).toEqual([]);
});

test("a file saved before is not shown and is removed when the setting of the app says never", async ({
  page,
}) => {
  await seed(page, {
    ref: true,
    config: '{ "terminal": { "saveScrollback": false } }',
    files: { [PANE]: "old text that must not come back" },
  });
  await page.goto("/");
  await waitForPrompt(page);

  expect(await lines(page)).not.toContain("old text that must not come back");
  await expect.poll(() => files(page)).toEqual({});
  expect(await writes(page)).toEqual([{ method: "deleteScrollback", paneId: PANE }]);
  expect(await stored(page)).toBeNull();
});

test("turning the setting off while the app runs removes the files at once and nothing is saved after", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/");
  await waitForPrompt(page);
  await run(page, "echo before-off");
  await waitForLine(page, "before-off");
  await advance(page, 60_000);
  await expect.poll(async () => Object.keys(await files(page))).toEqual([PANE]);

  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setConfig('{ "terminal": { "saveScrollback": false } }'),
  );
  await expect.poll(() => files(page)).toEqual({});

  await run(page, "echo after-off");
  await waitForLine(page, "after-off");
  await advance(page, 60_000);
  await advance(page, 60_000);
  expect(await files(page)).toEqual({});
  expect((await writes(page)).filter((c) => c.method === "saveScrollback")).toHaveLength(1);
});

test("the saved text is cleaned: a sequence that would change the terminal or make it answer does nothing", async ({
  browser,
  baseURL,
  page,
}) => {
  const hostile = [
    "visible before",
    `${ESC}]52;c;SGVsbG8=\x07after the clipboard`,
    `${ESC}]0;evil title\x07after the title`,
    `${ESC}[6nafter the position report`,
    `${ESC}[cafter the attributes request`,
    `${ESC}[>0qafter the version request`,
    `${ESC}[?1049h${ESC}[?1000h${ESC}[?2004hafter the modes`,
    `${ESC}[2J${ESC}[Hafter the clear`,
    "\x07after the bell",
    `${ESC}[31mred text${ESC}[0m`,
    "visible after",
  ].join("\n");

  // A real terminal answers a request for the cursor position by typing the answer to the shell, so
  // the harness sees a write. Checked first, on a page of its own with nothing to restore, so the
  // zero below means something.
  const control = await (await newServedContext(browser, baseURL)).newPage();
  await control.goto("/");
  await waitForPrompt(control);
  await control.evaluate(() => {
    const hook = (window as HookWindow).__norenTest;
    hook?.sendOutput(hook.paneIds()[0] ?? "", "\x1b[6n");
  });
  await expect.poll(() => writeCalls(control)).toBeGreaterThan(0);
  await control.context().close();

  await seed(page, { ref: true, files: { [PANE]: hostile } });
  await page.goto("/");
  await waitForMarker(page);
  await waitForPrompt(page);
  const shown = (await lines(page)).join("\n");
  expect(shown).toContain("visible before");
  expect(shown).toContain("after the clipboard");
  expect(shown).toContain("after the position report");
  expect(shown).toContain("red text");
  expect(shown).toContain("visible after");
  // What the sequences carried is gone.
  expect(shown).not.toContain("SGVsbG8");
  expect(shown).not.toContain("evil title");
  // The old text reached the terminal without a single byte going back to the shell.
  expect(await writeCalls(page)).toBe(0);
  // And the terminal is still on its normal screen, with the old lines in it.
  expect(await lines(page)).toContain("visible before");
  expect(await paneDimLines(page, PANE)).toContain("visible before");
});

test("a snapshot with more than 2000 lines shows the last 2000", async ({ page }) => {
  const long = Array.from({ length: 2600 }, (_, i) => `line ${i}`).join("\n");
  await seed(page, { ref: true, files: { [PANE]: long } });
  await page.goto("/");
  await waitForMarker(page);
  const shown = await lines(page);
  expect(shown).toContain("line 2599");
  expect(shown).toContain("line 600");
  expect(shown).not.toContain("line 599");
});

test("a pane saved twice keeps the lines it showed before the restart above the new ones", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/");
  await waitForPrompt(page);
  await run(page, "echo first-life");
  await waitForLine(page, "first-life");
  await page.reload();
  await waitForMarker(page);
  await run(page, "echo second-life");
  await waitForLine(page, "second-life");
  await page.reload();

  await waitForMarker(page, 2);
  const shown = await lines(page);
  const markers = shown.flatMap((l, i) => (MARKER.test(l) ? [i] : []));
  expect(shown.indexOf("first-life")).toBeLessThan(markers[0] ?? 0);
  expect(shown.indexOf("second-life")).toBeGreaterThan(markers[0] ?? 0);
  expect(shown.indexOf("second-life")).toBeLessThan(markers[1] ?? 0);
});
