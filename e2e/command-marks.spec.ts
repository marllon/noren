import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openShortcutsScreen, setPaneHeaders } from "./settings-fixture";

// The shell of a pane reports where each prompt starts and how each command ended (OSC 133 A, C and
// D). The terminal marks every command at its prompt, draws a red mark in the ruler beside the
// scrollbar for the ones that failed, steps between prompts on Ctrl+Up and Ctrl+Down, and selects or
// copies the output of a command from the palette and from two menus. The fake shell of web mode
// reports all of it, so everything below runs without a real shell.

interface Mark {
  row: number;
  text: string;
  state: "running" | "done";
  exitCode?: number;
  failed: boolean;
  ruler: boolean;
  current: boolean;
  outputRows: number;
}
interface Hook {
  marks(): Mark[];
  lines(): string[];
  selection(): string;
  viewport(): { top: number; rows: number };
  writeCalls(): number;
  paneIds(): string[];
  split(dir: "row" | "column", paneId?: string): string | undefined;
}
type HookWindow = Window & { __norenTest?: Hook };

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const marks = (page: Page): Promise<Mark[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.marks() ?? []);
const texts = async (page: Page): Promise<string[]> => (await marks(page)).map((m) => m.text);
const writeCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.writeCalls() ?? -1);
// xterm.js joins the rows of a selection with CRLF on Windows, and so does the system clipboard
// whatever is written to it: the tests compare the text with the line breaks as plain LF.
const lf = (text: string): string => text.replaceAll("\r\n", "\n");
const selection = async (page: Page): Promise<string> =>
  lf(await page.evaluate(() => (window as HookWindow).__norenTest?.selection() ?? ""));
const viewport = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.viewport() ?? { top: -1, rows: 0 });
const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);
const bufferRows = async (page: Page): Promise<number> => (await lines(page)).length;
const clipboard = async (page: Page): Promise<string> =>
  lf(await page.evaluate(() => navigator.clipboard.readText()));
const setClipboard = (page: Page, text: string): Promise<void> =>
  page.evaluate((value) => navigator.clipboard.writeText(value), text);

/** The mark that Ctrl+Up or Ctrl+Down stepped to last, by its text; undefined when none is current. */
const currentText = async (page: Page): Promise<string | undefined> =>
  (await marks(page)).find((m) => m.current)?.text;

const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
const tabList = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });

/** Types a command line in the terminal of the focused pane and presses Enter. */
async function run(page: Page, line: string): Promise<void> {
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

const doneCount = async (page: Page): Promise<number> =>
  (await marks(page)).filter((m) => m.state === "done").length;

/** Runs the commands and waits until the terminal has marked every one of them as ended. */
async function runAll(page: Page, commands: string[]): Promise<void> {
  const before = await doneCount(page);
  for (const line of commands) await run(page, line);
  await expect.poll(() => doneCount(page)).toBe(before + commands.length);
}

/** The color of each stretch of rows in the ruler beside the scrollbar that has something drawn. */
async function rulerRuns(page: Page): Promise<number[][]> {
  return page.evaluate(() => {
    const canvases = [
      ...document.querySelectorAll<HTMLCanvasElement>(".xterm-decoration-overview-ruler"),
    ];
    const canvas = canvases.find((c) => c.offsetParent !== null);
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || canvas.width === 0 || canvas.height === 0) return [];
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const runs: number[][] = [];
    let open: number[] | undefined;
    for (let y = 0; y < canvas.height; y++) {
      let color: number[] | undefined;
      for (let x = 0; x < canvas.width && color === undefined; x++) {
        const at = (y * canvas.width + x) * 4;
        if ((data[at + 3] ?? 0) > 0) color = [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0];
      }
      if (color !== undefined && open === undefined) {
        open = color;
        runs.push(color);
      } else if (color === undefined) {
        open = undefined;
      }
    }
    return runs;
  });
}

const isRed = ([r = 0, g = 0, b = 0]: number[]): boolean => r > g + 40 && r > b + 40;

/** Runs an action of the palette by its title. */
async function paletteRun(page: Page, title: string): Promise<void> {
  await page.keyboard.press("Control+Shift+P");
  const box = page.getByRole("combobox", { name: "Command palette", exact: true });
  await box.fill(`> ${title}`);
  await expect(page.getByRole("option").first()).toContainText(title);
  await page.keyboard.press("Enter");
  await expect(box).toBeHidden();
}

test("three commands, one failing, show exactly one red mark, in the margin and in the ruler", async ({
  page,
}) => {
  await page.goto("/");
  await runAll(page, ["echo one", "false", "echo three"]);

  const list = await marks(page);
  expect(list.map((m) => m.text)).toEqual(["fake$ echo one", "fake$ false", "fake$ echo three"]);
  expect(list.map((m) => m.exitCode)).toEqual([0, 1, 0]);
  expect(list.map((m) => m.failed)).toEqual([false, true, false]);
  expect(list.map((m) => m.ruler)).toEqual([false, true, false]);

  // The margin: one mark on each prompt row, one of them for the failure.
  const dots = page.locator('[data-nr-part="command-mark"]');
  await expect(dots).toHaveCount(3);
  await expect(page.locator('[data-nr-part="command-mark"][data-nr-state="failed"]')).toHaveCount(
    1,
  );
  await expect(page.locator('[data-nr-part="command-mark"][data-nr-state="done"]')).toHaveCount(2);

  // The ruler: a single stretch is drawn, and it is red.
  await expect.poll(async () => (await rulerRuns(page)).length).toBe(1);
  const [color = []] = await rulerRuns(page);
  expect(isRed(color), `ruler color ${color.join(",")}`).toBe(true);
});

test("no command failed, so the ruler stays empty and no mark is red", async ({ page }) => {
  await page.goto("/");
  await runAll(page, ["echo one", "true"]);
  await expect(page.locator('[data-nr-part="command-mark"]')).toHaveCount(2);
  await expect(page.locator('[data-nr-part="command-mark"][data-nr-state="failed"]')).toHaveCount(
    0,
  );
  expect((await marks(page)).some((m) => m.ruler)).toBe(false);
  expect(await rulerRuns(page)).toEqual([]);
});

test("a running command is marked as running and ends with its state", async ({ page }) => {
  await page.goto("/");
  await run(page, "sleep 4");
  await expect(page.locator('[data-nr-part="command-mark"][data-nr-state="running"]')).toHaveCount(
    1,
  );
  expect((await marks(page)).map((m) => [m.state, m.failed, m.ruler])).toEqual([
    ["running", false, false],
  ]);
  await page.evaluate(() => {
    (
      window as Window & { __norenTest?: { advanceClock(ms: number): void } }
    ).__norenTest?.advanceClock(4000);
  });
  await expect(page.locator('[data-nr-part="command-mark"][data-nr-state="done"]')).toHaveCount(1);
});

test("an empty line is not a command: it gets no mark", async ({ page }) => {
  await page.goto("/");
  await run(page, "");
  await run(page, "");
  await run(page, "echo hi");
  await expect.poll(() => texts(page)).toEqual(["fake$ echo hi"]);
  await expect(page.locator('[data-nr-part="command-mark"]')).toHaveCount(1);
});

test("Ctrl+Up goes to the previous prompt and Ctrl+Down to the next, without the shell seeing the keys", async ({
  page,
}) => {
  await page.goto("/");
  await runAll(page, ["echo one", "false", "echo three"]);
  const writes = await writeCalls(page);

  await page.keyboard.press("Control+ArrowUp");
  expect(await currentText(page)).toBe("fake$ echo three");
  await page.keyboard.press("Control+ArrowUp");
  expect(await currentText(page)).toBe("fake$ false");
  await expect(page.locator('[data-nr-part="command-mark"][data-nr-current="true"]')).toHaveCount(
    1,
  );
  await page.keyboard.press("Control+ArrowUp");
  expect(await currentText(page)).toBe("fake$ echo one");
  // Nothing before the first prompt: it stays, and the key is still ours.
  await page.keyboard.press("Control+ArrowUp");
  expect(await currentText(page)).toBe("fake$ echo one");

  await page.keyboard.press("Control+ArrowDown");
  expect(await currentText(page)).toBe("fake$ false");
  await page.keyboard.press("Control+ArrowDown");
  expect(await currentText(page)).toBe("fake$ echo three");
  // Past the last prompt is the live end: nothing is current any more.
  await page.keyboard.press("Control+ArrowDown");
  expect(await currentText(page)).toBeUndefined();

  expect(await writeCalls(page)).toBe(writes);
});

test("the view scrolls so that the prompt stepped to is at its top", async ({ page }) => {
  await page.goto("/");
  await runAll(page, ["echo first", "seq 120", "echo last"]);
  const rows = await bufferRows(page);
  const { top, rows: height } = await viewport(page);
  // At the live end, and with room to scroll.
  expect(top + height).toBe(rows);
  expect(top).toBeGreaterThan(5);

  const rowOf = async (text: string) => (await marks(page)).find((m) => m.text === text)?.row;
  const lastRow = await rowOf("fake$ echo last");
  const seqRow = await rowOf("fake$ seq 120");
  const firstRow = await rowOf("fake$ echo first");
  expect(firstRow).toBe(0);

  await page.keyboard.press("Control+ArrowUp");
  expect(await currentText(page)).toBe("fake$ echo last");
  // The prompt of `echo last` is near the end: the view goes as far down as it can.
  expect((await viewport(page)).top).toBe(Math.min(lastRow ?? -1, top));

  await page.keyboard.press("Control+ArrowUp");
  expect(await currentText(page)).toBe("fake$ seq 120");
  expect((await viewport(page)).top).toBe(seqRow);

  await page.keyboard.press("Control+ArrowUp");
  expect(await currentText(page)).toBe("fake$ echo first");
  expect((await viewport(page)).top).toBe(0);

  await page.keyboard.press("Control+ArrowDown");
  await page.keyboard.press("Control+ArrowDown");
  await page.keyboard.press("Control+ArrowDown");
  expect(await currentText(page)).toBeUndefined();
  const end = await viewport(page);
  expect(end.top + end.rows).toBe(await bufferRows(page));
});

test("a step goes on from where the user scrolled to", async ({ page }) => {
  await page.goto("/");
  await runAll(page, ["echo first", "seq 120", "echo last"]);
  const seqRow = (await marks(page)).find((m) => m.text === "fake$ seq 120")?.row ?? -1;
  // Scroll the view up by pages (Shift+PageUp, which the terminal keeps for itself) to the top.
  for (let page_ = 0; page_ < 10; page_++) await page.keyboard.press("Shift+PageUp");
  await expect.poll(async () => (await viewport(page)).top).toBe(0);
  await page.keyboard.press("Control+ArrowDown");
  // The next prompt below the top of the view is `seq 120` (row 2), not the first one.
  expect(await currentText(page)).toBe("fake$ seq 120");
  expect((await viewport(page)).top).toBe(seqRow);
});

test("with no mark to go to the arrows still reach the shell", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  await expect.poll(() => writeCalls(page)).toBe(0);
  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(() => writeCalls(page)).toBe(1);
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(() => writeCalls(page)).toBe(2);

  // With a command in the pane the same keys are no longer the shell's.
  await runAll(page, ["echo hi"]);
  const writes = await writeCalls(page);
  await page.keyboard.press("Control+ArrowUp");
  expect(await currentText(page)).toBe("fake$ echo hi");
  expect(await writeCalls(page)).toBe(writes);
  // Other arrows are untouched.
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => writeCalls(page)).toBe(writes + 1);
});

test("copy last command output puts the text of the last command, and only that, on the clipboard", async ({
  page,
}) => {
  await page.goto("/");
  await runAll(page, ["echo one", "false", "echo hello world"]);
  await setClipboard(page, "before");
  await paletteRun(page, "Copy last command output");
  await expect(notice(page)).toHaveText("Copied the output of the last command");
  expect(await clipboard(page)).toBe("hello world");

  // An output of several rows keeps its lines, with no trailing line break.
  await runAll(page, ["seq 3"]);
  await paletteRun(page, "Copy last command output");
  await expect.poll(() => clipboard(page)).toBe("1\n2\n3");

  await runAll(page, ["ls"]);
  await paletteRun(page, "Copy last command output");
  await expect.poll(() => clipboard(page)).toBe("README.md  notes.txt  src");
});

test("copying after a command that printed nothing says so and leaves the clipboard alone", async ({
  page,
}) => {
  await page.goto("/");
  await runAll(page, ["echo hello", "false"]);
  await setClipboard(page, "kept");
  await paletteRun(page, "Copy last command output");
  await expect(notice(page)).toHaveText("The last command printed no output");
  expect(await clipboard(page)).toBe("kept");
});

test("copying before any command ended says so", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => (await lines(page)).some((line) => line.startsWith("fake$")))
    .toBe(true);
  await paletteRun(page, "Copy last command output");
  await expect(notice(page)).toHaveText("No command has finished in this pane yet");
  await paletteRun(page, "Previous prompt");
  await expect(notice(page)).toHaveText("No command prompts in this pane yet");
});

test("select command output selects the output rows of the last command, from the palette", async ({
  page,
}) => {
  await page.goto("/");
  await runAll(page, ["echo aaa", "seq 3", "false"]);
  // The last command printed nothing: there is nothing to select.
  await paletteRun(page, "Select command output");
  await expect(notice(page)).toHaveText("No finished command with output to select in this pane");

  await runAll(page, ["ls"]);
  await paletteRun(page, "Select command output");
  await expect.poll(() => selection(page)).toBe("README.md  notes.txt  src");
});

test("select command output acts on the prompt stepped to", async ({ page }) => {
  await page.goto("/");
  await runAll(page, ["echo aaa", "seq 3", "echo zzz"]);
  await page.keyboard.press("Control+ArrowUp");
  await page.keyboard.press("Control+ArrowUp");
  expect(await currentText(page)).toBe("fake$ seq 3");
  await paletteRun(page, "Select command output");
  await expect.poll(() => selection(page)).toBe("1\n2\n3");
});

test("the pane menu in the header selects or copies the output of a command", async ({ page }) => {
  await page.goto("/");
  await setPaneHeaders(page, true);
  await runAll(page, ["echo one", "echo hello world"]);

  await page.getByRole("button", { name: "Pane menu", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Pane options", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Select command output", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect.poll(() => selection(page)).toBe("hello world");

  await setClipboard(page, "before");
  await page.getByRole("button", { name: "Pane menu", exact: true }).click();
  await page
    .getByRole("menu", { name: "Pane options", exact: true })
    .getByRole("menuitem", { name: "Copy last command output", exact: true })
    .click();
  await expect.poll(() => clipboard(page)).toBe("hello world");
  await expect(notice(page)).toHaveText("Copied the output of the last command");
});

test("the tab menu offers the same two actions for the focused pane of that tab", async ({
  page,
}) => {
  await page.goto("/");
  await runAll(page, ["echo from the tab menu"]);
  await tabList(page).locator('[data-nr-part="item"]').click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Tab options", exact: true });
  await menu.getByRole("menuitem", { name: "Copy last command output", exact: true }).click();
  await expect.poll(() => clipboard(page)).toBe("from the tab menu");

  await tabList(page).locator('[data-nr-part="item"]').click({ button: "right" });
  await page
    .getByRole("menu", { name: "Tab options", exact: true })
    .getByRole("menuitem", { name: "Select command output", exact: true })
    .click();
  await expect.poll(() => selection(page)).toBe("from the tab menu");
});

test("selecting from the menu of another tab shows that tab with the output selected", async ({
  page,
}) => {
  await page.goto("/");
  await runAll(page, ["echo in the first tab"]);
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  const items = tabList(page).locator('[data-nr-part="item"]');
  await expect(items).toHaveCount(2);
  // The new tab is on screen and has run nothing.
  await expect.poll(() => texts(page)).toEqual([]);

  await items.nth(0).click({ button: "right" });
  await page
    .getByRole("menu", { name: "Tab options", exact: true })
    .getByRole("menuitem", { name: "Select command output", exact: true })
    .click();
  await expect(items.nth(0)).toHaveAttribute("aria-current", "true");
  await expect.poll(() => selection(page)).toBe("in the first tab");
});

test("each pane of a split has its own marks and keeps its own output", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  const first = await page.evaluate(() => (window as HookWindow).__norenTest?.paneIds()[0] ?? "");
  const second = await page.evaluate(() => (window as HookWindow).__norenTest?.split("row"));
  expect(second).toBeDefined();
  const focused = (id: string) =>
    page.locator(`[data-pane-id="${id}"] textarea.xterm-helper-textarea:focus`);
  // A split gives the screens of its panes back empty, so each pane runs its command after it.
  await expect(focused(second ?? "")).toHaveCount(1);
  expect(await texts(page)).toEqual([]);
  await page.keyboard.type("echo right side");
  await page.keyboard.press("Enter");
  await expect.poll(() => texts(page)).toEqual(["fake$ echo right side"]);
  await paletteRun(page, "Copy last command output");
  await expect.poll(() => clipboard(page)).toBe("right side");

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(focused(first)).toHaveCount(1);
  expect(await texts(page)).toEqual([]);
  await page.keyboard.type("echo left side");
  await page.keyboard.press("Enter");
  // This screen came back empty after the split, so its prompt row holds what was typed only.
  await expect.poll(() => texts(page)).toEqual(["echo left side"]);
  await paletteRun(page, "Copy last command output");
  await expect.poll(() => clipboard(page)).toBe("left side");
});

test("the new actions are in the shortcuts screen with their keys", async ({ page }) => {
  await page.goto("/");
  const screen = await openShortcutsScreen(page);
  await expect(screen.getByLabel("Shortcut for Previous prompt", { exact: true })).toHaveText(
    "Ctrl+Up",
  );
  await expect(screen.getByLabel("Shortcut for Next prompt", { exact: true })).toHaveText(
    "Ctrl+Down",
  );
  await expect(screen.getByLabel("Shortcut for Select command output", { exact: true })).toHaveText(
    "None",
  );
  await expect(
    screen.getByLabel("Shortcut for Copy last command output", { exact: true }),
  ).toHaveText("None");
});
