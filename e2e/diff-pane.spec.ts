import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { expectNoAxeViolations } from "./axe-fixture";
import { seedConfig, setPaneHeaders } from "./settings-fixture";

// The diff pane (NOR-F15-03): a pane that shows the git diff of a folder, with the files that
// changed in a list and the one picked side by side. The state is restored with panes of type
// "diff", and the diffs they ask for live in the fake git of web mode (seeded in the browser storage
// before the page loads, like the files of a preview), so these tests show what each kind of change
// turns into on screen: a changed file with two hunks, an added, a deleted and a renamed one, a
// binary file, a change of mode, a file with no line break at the end, a name outside ASCII, and a
// folder git refuses. They hold that no shell is started for a diff pane, that the diff is read when
// the pane is on screen and not before, that the palette opens the diff of the folder of the focused
// pane beside it with the folder in `state.json` and the keyboard where it was, that a pane with no
// folder, a folder git is not run in and a full tab say so in a notice and make no pane, that the
// pane is there after a reload, that it is where it is drawn (composition is checked with
// `elementFromPoint`, since the unit tests render no layout), and that it scrolls by keyboard. The
// fixture is the text of a real `git diff` (`fixtures/diff/sample.diff`); what the real git does with
// real repositories is in the Rust tests (`git_diff_real.rs`).

interface Hook {
  paneIds(): string[];
  focusedPaneId(): string | undefined;
  sessionStarts(): unknown[];
  gitDiffReads(): string[];
  setGitDiff(folder: string, entry: string | { kind: "refused"; reason: string } | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_STATE_KEY = "noren.web.state";
const WEB_GIT_DIFFS_KEY = "noren.web.git-diffs";
const REPO = "/work/repo";

const SAMPLE = readFileSync(new URL("./fixtures/diff/sample.diff", import.meta.url), "utf8");

/** The files of the fixture in the order git printed them: path, status, letter, and what the list says. */
const SAMPLE_FILES = [
  { path: "README.md", status: "modified", letter: "M", counts: "+1 −1" },
  { path: "docs/guide.md", status: "renamed", letter: "R", counts: "+1 −1" },
  { path: "legacy.txt", status: "deleted", letter: "D", counts: "+0 −2" },
  { path: "logo.bin", status: "modified", letter: "M", counts: "binary" },
  { path: "no-newline.txt", status: "modified", letter: "M", counts: "+1 −1" },
  { path: "notes/café.txt", status: "modified", letter: "M", counts: "+1 −0" },
  { path: "scripts/run.sh", status: "modified", letter: "M", counts: "+0 −0" },
  { path: "src/added.ts", status: "added", letter: "A", counts: "+2 −0" },
  { path: "src/greeting.ts", status: "modified", letter: "M", counts: "+4 −3" },
] as const;

/** The diff of one more file than the cap draws: a new file of `count` lines. */
function addedFileDiff(path: string, count: number): string {
  const lines = Array.from({ length: count }, (_, n) => `+line ${n + 1}`);
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${count} @@`,
    ...lines,
    "",
  ].join("\n");
}

/** A pane of a seeded tab: a diff of a folder, or a terminal (in a folder when given). */
type PaneSeed =
  { id: string; kind: "diff"; cwd: string } | { id: string; kind: "terminal"; cwd?: string };

interface TabSeed {
  id: string;
  /** What the tab is called. Absent, the tab is named by what its panes say. */
  title?: string;
  panes: PaneSeed[];
}

const diffPane = (id: string, cwd: string): PaneSeed => ({ id, kind: "diff", cwd });

function paneJson(seed: PaneSeed): Record<string, unknown> {
  const common = { id: seed.id, profileId: "default", unread: false, bell: false };
  return seed.kind === "diff"
    ? { ...common, type: "diff", cwd: seed.cwd, status: "idle" }
    : {
        ...common,
        type: "terminal",
        status: "idle",
        ...(seed.cwd !== undefined ? { cwd: seed.cwd } : {}),
      };
}

/** The state file of one space whose tabs are `tabs`, the first one on screen. */
function savedState(tabs: TabSeed[], spaceCwd: string | undefined): string {
  const items = Object.fromEntries(
    tabs.map((tab) => {
      const panes = tab.panes.map((pane) => ({ kind: "pane" as const, pane: paneJson(pane) }));
      const layout =
        panes.length === 1
          ? panes[0]
          : {
              kind: "split",
              dir: "row",
              sizes: panes.map(() => 100 / panes.length),
              children: panes,
            };
      return [
        tab.id,
        {
          id: tab.id,
          ...(tab.title !== undefined ? { title: tab.title } : {}),
          titleLocked: tab.title !== undefined,
          layout,
          focusedPaneId: tab.panes[0]?.id,
          lastActivityAt: 1,
        },
      ];
    }),
  );
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
        defaults: { env: {}, ...(spaceCwd !== undefined ? { cwd: spaceCwd } : {}) },
        aiEnabled: true,
        saveScrollback: false,
        pinned: [],
        tree: tabs.map((tab) => ({ kind: "item", id: tab.id })),
        items,
        activeItemId: tabs[0]?.id,
      },
    ],
  });
}

type DiffSeed = string | { reason: string; detail?: string };

interface StartOptions {
  /** What the fake git answers, by the folder of each repository. */
  diffs?: Record<string, DiffSeed>;
  /** The start folder of the space. */
  spaceCwd?: string;
}

/** Puts the saved workspace and the diffs in the browser storage before the page loads (once). */
async function seed(page: Page, tabs: TabSeed[], options: StartOptions): Promise<void> {
  await page.addInitScript(
    ({ stateKey, state, diffsKey, diffs }) => {
      if (window.localStorage.getItem(stateKey) !== null) return;
      window.localStorage.setItem(stateKey, state);
      window.localStorage.setItem(diffsKey, JSON.stringify(diffs));
    },
    {
      stateKey: WEB_STATE_KEY,
      state: savedState(tabs, options.spaceCwd),
      diffsKey: WEB_GIT_DIFFS_KEY,
      diffs: options.diffs ?? { [REPO]: SAMPLE },
    },
  );
}

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const focusedPaneId = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.focusedPaneId());
const shells = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts().length ?? 0);
const reads = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.gitDiffReads() ?? []);
const savedText = (page: Page): Promise<string> =>
  page.evaluate((key) => window.localStorage.getItem(key) ?? "", WEB_STATE_KEY);

interface SavedPane {
  id: string;
  type: string;
  cwd?: string;
  sessionId?: string;
  path?: string;
  url?: string;
}

/** The panes of the saved state, as the file has them. */
async function savedPanes(page: Page): Promise<SavedPane[]> {
  interface Saved {
    spaces: { items: Record<string, { layout: unknown }> }[];
  }
  const panes: SavedPane[] = [];
  const walk = (node: unknown): void => {
    const n = node as { kind: string; pane?: SavedPane; children?: unknown[] };
    if (n.kind === "pane" && n.pane) panes.push(n.pane);
    n.children?.forEach(walk);
  };
  const state = JSON.parse(await savedText(page)) as Saved;
  for (const space of state.spaces) {
    for (const item of Object.values(space.items)) walk(item.layout);
  }
  return panes;
}

/** Seeds and opens the app; waits until the panes of the tab on screen (the first) are known. */
async function start(page: Page, tabs: TabSeed[], options: StartOptions = {}): Promise<void> {
  await seed(page, tabs, options);
  await page.goto("/");
  await expect.poll(() => paneIds(page)).toEqual(tabs[0]?.panes.map((pane) => pane.id));
}

/** The tabs of the sidebar: the one tree of the window, called "Tabs" or "Abas". */
const tabList = (page: Page) => page.getByRole("tree");
const tabRow = (page: Page, name: string): Locator =>
  tabList(page).getByRole("treeitem", { name, exact: true });
/** The diff pane on screen (the panes of the other tabs are mounted and hidden). */
const shown = (page: Page): Locator => page.locator('[data-nr-part="diff-pane"]:visible');
const fileButtons = (page: Page): Locator => shown(page).locator('[data-nr-part="diff-file"]');
const fileButton = (page: Page, path: string): Locator =>
  shown(page).locator(`[data-nr-part="diff-file"][data-nr-path="${path}"]`);
const content = (page: Page): Locator => shown(page).locator('[data-nr-part="diff-content"]');
const rows = (page: Page): Locator => content(page).locator("tr[data-nr-row]");
const changeRows = (page: Page): Locator => content(page).locator('tr[data-nr-row="change"]');
const problem = (page: Page): Locator => shown(page).locator('[data-nr-part="diff-problem"]');
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');

async function pick(page: Page, path: string): Promise<void> {
  await fileButton(page, path).click();
  await expect(fileButton(page, path)).toHaveAttribute("aria-current", "true");
}

/** What a side of a row holds: the number and the text, without the sign in front of it. */
async function side(
  row: Locator,
  which: "old" | "new",
): Promise<{ no: string; text: string; kind: string | null }> {
  const no = await row.locator(`td.diff-no[data-nr-side="${which}"]`).textContent();
  const cell = row.locator(`td.diff-text[data-nr-side="${which}"]`);
  const text = (await cell.textContent()) ?? "";
  return {
    no: no ?? "",
    text: text.slice(1).replace(/\xa0/g, ""),
    kind: await cell.getAttribute("data-nr-kind"),
  };
}

/** Runs a command of the palette by typing its name. */
async function runFromPalette(page: Page, name: string, label = "Command palette"): Promise<void> {
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  const box = palette(page).getByRole("combobox", { name: label, exact: true });
  await box.fill(name);
  await expect(palette(page).getByRole("option").first()).toContainText(name);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
}

const WORK: TabSeed[] = [
  {
    id: "i1",
    title: "work",
    panes: [{ id: "t1", kind: "terminal", cwd: REPO }, diffPane("d1", REPO)],
  },
];

test.describe("restoring a diff pane", () => {
  test("shows the files of the diff and the first one side by side, with the folder on top and no shell of its own", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await start(page, WORK);

    await expect(shown(page)).toHaveCount(1);
    await expect(shown(page)).toHaveAttribute("aria-label", "Git diff");
    await expect(shown(page).locator('[data-nr-part="diff-path"]')).toContainText(REPO);

    // The files, in the order git printed them, each with its letter, its status and its counts.
    await expect(fileButtons(page)).toHaveCount(SAMPLE_FILES.length);
    for (const [index, file] of SAMPLE_FILES.entries()) {
      const button = fileButtons(page).nth(index);
      await expect(button).toHaveAttribute("data-nr-path", file.path);
      await expect(button).toHaveAttribute("data-nr-status", file.status);
      await expect(button.locator(".diff-letter")).toHaveText(file.letter);
      await expect(button.locator(".diff-counts")).toHaveText(file.counts);
      await expect(button.locator(".diff-file-name")).toHaveText(file.path);
    }
    // Untracked files are not in `git diff`, so they are not in the list.
    await expect(shown(page)).not.toContainText("untracked.txt");

    // The first file is picked, and its changes are set side by side.
    await expect(fileButton(page, "README.md")).toHaveAttribute("aria-current", "true");
    await expect(fileButton(page, "docs/guide.md")).not.toHaveAttribute("aria-current", "true");
    await expect(content(page).locator('[data-nr-part="diff-file-title"]')).toHaveText("README.md");
    await expect(rows(page)).toHaveCount(4);
    await expect(rows(page).nth(0)).toHaveAttribute("data-nr-row", "hunk");
    await expect(rows(page).nth(0)).toHaveText("@@ -1,3 +1,3 @@");
    const change = changeRows(page);
    await expect(change).toHaveCount(1);
    expect(await side(change, "old")).toEqual({ no: "3", text: "A small project.", kind: "del" });
    expect(await side(change, "new")).toEqual({
      no: "3",
      text: "A small project that shows a diff.",
      kind: "add",
    });
    // The two sides are two columns of the same row: the old file is on the left.
    const left = await change.locator('td.diff-text[data-nr-side="old"]').boundingBox();
    const right = await change.locator('td.diff-text[data-nr-side="new"]').boundingBox();
    if (left === null || right === null) throw new Error("a cell is not on screen");
    expect(right.x).toBeGreaterThan(left.x + left.width - 1);
    expect(Math.abs(right.y - left.y)).toBeLessThanOrEqual(1);
    // The headings of the two columns.
    await expect(content(page).locator("thead th")).toHaveText(["Last commit", "Working tree"]);

    // One shell, the one of the terminal; the folder was asked of git once, and nothing left the app.
    expect(await shells(page)).toBe(1);
    expect(await reads(page)).toEqual([REPO]);
    expect(errors).toEqual([]);
    const origin = new URL(page.url()).origin;
    // The Worker of the example plugin is a blob made by the page itself (NOR-F18-01c).
    const own = (url: string) =>
      url.startsWith(origin) || url.startsWith(`blob:${origin}/`) || url.startsWith("data:");
    expect(requests.filter((url) => !own(url))).toEqual([]);
  });

  test("each kind of change shows what it is", async ({ page }) => {
    await start(page, WORK);
    await expect(fileButtons(page)).toHaveCount(SAMPLE_FILES.length);

    // A changed file with two hunks: both, with their headings, numbered on both sides.
    await pick(page, "src/greeting.ts");
    await expect(content(page).locator('tr[data-nr-row="hunk"]')).toHaveText([
      "@@ -3,10 +3,10 @@ export function greet(name: string): string {",
      "@@ -16,4 +16,5 @@ export function pad(text: string, width: number): string {",
    ]);
    await expect(changeRows(page)).toHaveCount(4);
    expect(await side(changeRows(page).nth(0), "old")).toEqual({
      no: "6",
      text: "  return greet(name).toUpperCase();",
      kind: "del",
    });
    expect(await side(changeRows(page).nth(0), "new")).toEqual({
      no: "6",
      text: "  return greet(name).toUpperCase() + '!';",
      kind: "add",
    });
    // The line that was only added has nothing across from it.
    const last = changeRows(page).nth(3);
    expect(await side(last, "new")).toEqual({
      no: "20",
      text: "export const GREETING_COUNT = 3;",
      kind: "add",
    });
    expect(await side(last, "old")).toEqual({ no: "", text: "", kind: "empty" });
    // Lines that did not change sit on both sides, with the number each file gives them.
    const context = content(page).locator('tr[data-nr-row="context"]').first();
    expect(await side(context, "old")).toMatchObject({ no: "3", text: "}", kind: "context" });
    expect(await side(context, "new")).toMatchObject({ no: "3", text: "}", kind: "context" });

    // A deleted file: its lines on the old side only.
    await pick(page, "legacy.txt");
    await expect(content(page).locator('[data-nr-part="diff-file-head"]')).toContainText("Deleted");
    await expect(changeRows(page)).toHaveCount(2);
    for (const [index, text] of ["old line one", "old line two"].entries()) {
      expect(await side(changeRows(page).nth(index), "old")).toEqual({
        no: String(index + 1),
        text,
        kind: "del",
      });
      expect((await side(changeRows(page).nth(index), "new")).kind).toBe("empty");
    }

    // An added file: its lines on the new side only.
    await pick(page, "src/added.ts");
    await expect(content(page).locator('[data-nr-part="diff-file-head"]')).toContainText("Added");
    await expect(changeRows(page)).toHaveCount(2);
    expect(await side(changeRows(page).nth(1), "new")).toEqual({
      no: "2",
      text: "export const COUNT = 2;",
      kind: "add",
    });
    expect((await side(changeRows(page).nth(1), "old")).kind).toBe("empty");

    // A renamed file says what it was called and how alike it is.
    await pick(page, "docs/guide.md");
    await expect(content(page).locator('[data-nr-part="diff-file-title"]')).toHaveText(
      "docs/old-guide.md → docs/guide.md",
    );
    await expect(content(page).locator('[data-nr-part="diff-file-head"]')).toContainText(
      "91% alike",
    );
    expect(await side(changeRows(page), "new")).toMatchObject({ text: "guide line eight" });

    // A binary file has no lines.
    await pick(page, "logo.bin");
    await expect(content(page).locator('[data-nr-part="diff-note"]')).toHaveText(
      "Git does not show the lines of a binary file.",
    );
    await expect(content(page).locator("table")).toHaveCount(0);

    // A change of mode alone has no lines either, and says what changed.
    await pick(page, "scripts/run.sh");
    await expect(content(page).locator('[data-nr-part="diff-note"]')).toHaveText(
      "The file mode changed from 100644 to 100755.",
    );

    // A file with no line break at the end says so on the lines it applies to.
    await pick(page, "no-newline.txt");
    await expect(content(page).locator('[data-nr-part="diff-noeol"]')).toHaveText([
      "no newline at end of file",
      "no newline at end of file",
    ]);
    expect(await side(changeRows(page), "old")).toMatchObject({
      text: "twono newline at end of file",
    });

    // A name outside ASCII (git quoted it in the fixture) is read back as it is written.
    await pick(page, "notes/café.txt");
    await expect(content(page).locator('[data-nr-part="diff-file-title"]')).toHaveText(
      "notes/café.txt",
    );
    expect(await side(changeRows(page), "new")).toMatchObject({ no: "3", text: "três" });
  });

  test("the file list can be used with the keyboard", async ({ page }) => {
    await start(page, WORK);
    await expect(fileButtons(page)).toHaveCount(SAMPLE_FILES.length);
    await fileButton(page, "legacy.txt").focus();
    await page.keyboard.press("Enter");
    await expect(fileButton(page, "legacy.txt")).toHaveAttribute("aria-current", "true");
    await expect(fileButton(page, "README.md")).not.toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Tab");
    await expect(fileButton(page, "logo.bin")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(fileButton(page, "logo.bin")).toHaveAttribute("aria-current", "true");
  });

  test("a clean repository says nothing changed and that files git does not track are not listed", async ({
    page,
  }) => {
    await start(page, [{ id: "i1", title: "clean", panes: [diffPane("d1", "/work/clean")] }], {
      diffs: { "/work/clean": "" },
    });
    await expect(shown(page).locator('[data-nr-part="diff-clean"]')).toHaveText(
      "No changes: the working tree and the index match the last commit. Files git does not track yet are not listed.",
    );
    await expect(fileButtons(page)).toHaveCount(0);
    expect(await shells(page)).toBe(0);
  });

  test("a folder git refuses says why, keeps the folder and the refresh button, and recovers on refresh", async ({
    page,
  }) => {
    await start(
      page,
      [
        { id: "i1", title: "plain", panes: [diffPane("p1", "/work/plain")] },
        { id: "i2", title: "nogit", panes: [diffPane("p2", "/work/nogit")] },
        { id: "i3", title: "big", panes: [diffPane("p3", "/work/big")] },
        { id: "i4", title: "broken", panes: [diffPane("p4", "/work/broken")] },
        { id: "i5", title: "gone", panes: [diffPane("p5", "/work/gone")] },
      ],
      {
        diffs: {
          "/work/nogit": { reason: "git-missing" },
          "/work/big": { reason: "too-large" },
          "/work/broken": { reason: "failed", detail: "fatal: bad object HEAD" },
          "/work/gone": { reason: "missing" },
        },
      },
    );
    const cases: [string, string, string][] = [
      ["plain", "not-a-repository", "This folder is not in a git repository."],
      [
        "nogit",
        "git-missing",
        "Git could not be started. Install git and make sure it is on the PATH.",
      ],
      ["big", "too-large", "The diff is larger than 2 MiB, so it is not shown."],
      ["broken", "failed", "Git refused to give the changes: fatal: bad object HEAD"],
      ["gone", "missing", "This folder is not there, or it is not a folder."],
    ];
    for (const [name, reason, text] of cases) {
      await tabRow(page, name).click();
      await expect(problem(page)).toHaveText(text);
      await expect(problem(page)).toHaveAttribute("data-nr-reason", reason);
      await expect(problem(page)).toHaveAttribute("role", "alert");
      await expect(shown(page).locator('[data-nr-part="diff-path"]')).toContainText(
        `/work/${name}`,
      );
      await expect(shown(page).locator('[data-nr-part="diff-refresh"]')).toBeVisible();
      await expect(fileButtons(page)).toHaveCount(0);
    }

    // The repository is made right and the refresh button reads it again.
    await tabRow(page, "gone").click();
    await page.evaluate(
      ([folder, diff]) =>
        (window as HookWindow).__norenTest?.setGitDiff(folder ?? "", diff ?? null),
      ["/work/gone", SAMPLE],
    );
    await shown(page).locator('[data-nr-part="diff-refresh"]').click();
    await expect(fileButtons(page)).toHaveCount(SAMPLE_FILES.length);
    await expect(problem(page)).toHaveCount(0);
    expect(await shells(page)).toBe(0);
  });
});

test.describe("when the diff is read", () => {
  const TWO: TabSeed[] = [
    { id: "i1", title: "shell", panes: [{ id: "t1", kind: "terminal", cwd: REPO }] },
    { id: "i2", title: "changes", panes: [diffPane("d2", REPO)] },
  ];

  test("a diff pane in a tab nobody opened reads nothing, and reads again each time its tab comes back", async ({
    page,
  }) => {
    await start(page, TWO);
    await expect(page.locator('[data-nr-part="diff-pane"]')).toHaveCount(1);
    expect(await reads(page)).toEqual([]);

    await tabRow(page, "changes").click();
    await expect(fileButtons(page)).toHaveCount(SAMPLE_FILES.length);
    expect(await reads(page)).toEqual([REPO]);

    await tabRow(page, "shell").click();
    await expect(shown(page)).toHaveCount(0);
    expect(await reads(page)).toEqual([REPO]);

    // Changes made meanwhile are there when the person looks again.
    await page.evaluate(
      ([folder, diff]) =>
        (window as HookWindow).__norenTest?.setGitDiff(folder ?? "", diff ?? null),
      [REPO, SAMPLE.slice(0, SAMPLE.indexOf("diff --git a/docs"))],
    );
    await tabRow(page, "changes").click();
    await expect(fileButtons(page)).toHaveCount(1);
    expect(await reads(page)).toEqual([REPO, REPO]);
    // No shell was started for any of it beyond the one terminal.
    expect(await shells(page)).toBe(1);
  });

  test("the refresh button reads again, shows the new files and keeps the file picked while it is there", async ({
    page,
  }) => {
    await start(page, WORK);
    await expect(fileButtons(page)).toHaveCount(SAMPLE_FILES.length);
    await pick(page, "legacy.txt");
    expect(await reads(page)).toEqual([REPO]);

    // Still the same diff: the same file stays picked.
    await shown(page).locator('[data-nr-part="diff-refresh"]').click();
    await expect.poll(() => reads(page)).toEqual([REPO, REPO]);
    await expect(fileButton(page, "legacy.txt")).toHaveAttribute("aria-current", "true");

    // Someone fixed everything: the list is empty and says so.
    await page.evaluate(
      (folder) => (window as HookWindow).__norenTest?.setGitDiff(folder, ""),
      REPO,
    );
    await shown(page).locator('[data-nr-part="diff-refresh"]').click();
    await expect(shown(page).locator('[data-nr-part="diff-clean"]')).toBeVisible();
    await expect(fileButtons(page)).toHaveCount(0);
    expect(await reads(page)).toEqual([REPO, REPO, REPO]);
    expect(await shells(page)).toBe(1);
  });
});

test.describe("opening a diff from the palette", () => {
  const OPEN = "Show git diff beside this pane";
  const TERMINAL: TabSeed[] = [
    { id: "i1", title: "work", panes: [{ id: "t1", kind: "terminal", cwd: REPO }] },
  ];

  test("opens the diff of the folder of the focused terminal beside it, with no new shell, the folder in state.json and the keyboard where it was", async ({
    page,
  }) => {
    await start(page, TERMINAL);
    expect(await shells(page)).toBe(1);
    await runFromPalette(page, OPEN);

    await expect.poll(async () => (await paneIds(page)).length).toBe(2);
    await expect(shown(page)).toHaveCount(1);
    await expect(fileButtons(page)).toHaveCount(SAMPLE_FILES.length);
    await expect(shown(page).locator('[data-nr-part="diff-path"]')).toContainText(REPO);
    expect(await reads(page)).toEqual([REPO]);

    // Beside the terminal, to its right, and the terminal still has the keyboard.
    const terminal = page.locator('[data-pane-id="t1"]');
    const [, newId] = await paneIds(page);
    const diff = page.locator(`[data-pane-id="${newId}"]`);
    const a = await terminal.boundingBox();
    const b = await diff.boundingBox();
    if (a === null || b === null) throw new Error("a pane is not on screen");
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
    expect(await focusedPaneId(page)).toBe("t1");
    await expect(terminal).toHaveAttribute("data-nr-focused", "true");

    // No new shell, and state.json has the diff pane with its folder and without a session.
    expect(await shells(page)).toBe(1);
    await expect
      .poll(async () => (await savedPanes(page)).find((p) => p.type === "diff"))
      .toMatchObject({ id: newId, type: "diff", cwd: REPO });
    const panes = await savedPanes(page);
    const saved = panes.find((p) => p.type === "diff");
    expect(saved?.sessionId).toBeUndefined();
    expect(saved?.path).toBeUndefined();
    expect(saved?.url).toBeUndefined();
    expect(panes.map((p) => p.type)).toEqual(["terminal", "diff"]);

    // After a reload the pane is back with the same folder and the same files.
    await page.reload();
    await expect.poll(async () => (await paneIds(page)).length).toBe(2);
    await expect(fileButtons(page)).toHaveCount(SAMPLE_FILES.length);
    await expect(shown(page).locator('[data-nr-part="diff-path"]')).toContainText(REPO);
    expect((await savedPanes(page)).filter((p) => p.type === "diff")).toHaveLength(1);
    expect(await shells(page)).toBe(1);
  });

  test("uses the start folder of the space when the pane has reported none", async ({ page }) => {
    await start(page, [{ id: "i1", title: "work", panes: [{ id: "t1", kind: "terminal" }] }], {
      spaceCwd: REPO,
    });
    await runFromPalette(page, OPEN);
    await expect.poll(async () => (await paneIds(page)).length).toBe(2);
    await expect(fileButtons(page)).toHaveCount(SAMPLE_FILES.length);
    await expect
      .poll(async () => (await savedPanes(page)).find((p) => p.type === "diff")?.cwd)
      .toBe(REPO);
  });

  test("a folder in no repository opens the pane, which says so", async ({ page }) => {
    await start(page, [
      { id: "i1", title: "work", panes: [{ id: "t1", kind: "terminal", cwd: "/tmp/plain" }] },
    ]);
    await runFromPalette(page, OPEN);
    await expect.poll(async () => (await paneIds(page)).length).toBe(2);
    await expect(problem(page)).toHaveText("This folder is not in a git repository.");
    expect(await shells(page)).toBe(1);
  });

  test("says so and makes no pane when the pane has no folder", async ({ page }) => {
    await start(page, [{ id: "i1", title: "work", panes: [{ id: "t1", kind: "terminal" }] }]);
    await runFromPalette(page, OPEN);
    await expect(notice(page)).toHaveText(
      "This pane has no known folder, so there is no diff to show.",
    );
    await page.waitForTimeout(300);
    expect(await paneIds(page)).toEqual(["t1"]);
    expect((await savedPanes(page)).map((p) => p.type)).toEqual(["terminal"]);
    expect(await reads(page)).toEqual([]);
    expect(await shells(page)).toBe(1);
    expect(await focusedPaneId(page)).toBe("t1");
  });

  test("says so and makes no pane when the folder is one git is not run in", async ({ page }) => {
    await start(page, [
      {
        id: "i1",
        title: "work",
        panes: [{ id: "t1", kind: "terminal", cwd: "\\\\server\\share\\repo" }],
      },
    ]);
    await runFromPalette(page, OPEN);
    await expect(notice(page)).toHaveText(
      "The folder of this pane is not one a diff can be read in.",
    );
    await page.waitForTimeout(300);
    expect(await paneIds(page)).toEqual(["t1"]);
    expect(await reads(page)).toEqual([]);
  });

  test("says so and makes no pane when the tab is full", async ({ page }) => {
    // The limit of the settings (`terminal.maxPanes`) is four here; the default is eight.
    await seedConfig(page, '{ "terminal": { "maxPanes": 4 } }');
    await start(page, [
      {
        id: "i1",
        title: "work",
        panes: [
          { id: "t1", kind: "terminal", cwd: REPO },
          diffPane("d2", REPO),
          diffPane("d3", REPO),
          diffPane("d4", REPO),
        ],
      },
    ]);
    expect(await paneIds(page)).toHaveLength(4);
    await runFromPalette(page, OPEN);
    await expect(notice(page)).toHaveText(
      "A tab holds at most 4 panes, so the diff was not opened.",
    );
    await page.waitForTimeout(300);
    expect(await paneIds(page)).toHaveLength(4);
    expect(await shells(page)).toBe(1);
  });
});

test.describe("in a split", () => {
  const LONG = addedFileDiff("long.txt", 150);
  const HUGE = addedFileDiff("huge.txt", 2100);
  const SPLIT: TabSeed[] = [
    {
      id: "i1",
      title: "work",
      panes: [{ id: "t1", kind: "terminal", cwd: "/srv/proj" }, diffPane("d1", "/work/long")],
    },
  ];
  const diffs = { "/work/long": LONG, "/work/huge": HUGE, [REPO]: SAMPLE };

  /** Whether the element at the middle of `locator` is inside it (nothing is laid over it). */
  const onTop = (locator: Locator): Promise<boolean> =>
    locator.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit !== null && el.contains(hit);
    });

  test("sits beside the terminal, is on top where it is drawn, and takes the focus when clicked", async ({
    page,
  }) => {
    await start(page, SPLIT, { diffs });
    await setPaneHeaders(page, true);
    const terminal = page.locator('[data-pane-id="t1"]');
    const diff = page.locator('[data-pane-id="d1"]');
    await expect(diff.locator('[data-nr-part="diff-content"]')).toBeVisible();

    const a = await terminal.boundingBox();
    const b = await diff.boundingBox();
    if (a === null || b === null) throw new Error("a pane is not on screen");
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
    expect(b.width).toBeGreaterThan(100);

    expect(await onTop(diff.locator('[data-nr-part="diff-content"]'))).toBe(true);
    expect(await onTop(diff.locator('[data-nr-part="diff-head"]'))).toBe(true);
    // The header names the folder it shows.
    await expect(diff.locator('[data-nr-part="pane-header"]')).toContainText("Changes in long");

    await expect(terminal).toHaveAttribute("data-nr-focused", "true");
    await diff.locator('[data-nr-part="diff-content"]').click();
    await expect(diff).toHaveAttribute("data-nr-focused", "true");
    await expect(terminal).toHaveAttribute("data-nr-focused", "false");
    expect(await shells(page)).toBe(1);
  });

  test("zooms to fill the tab and back, still on top", async ({ page }) => {
    await start(page, SPLIT, { diffs });
    await setPaneHeaders(page, true);
    const terminal = page.locator('[data-pane-id="t1"]');
    const diff = page.locator('[data-pane-id="d1"]');
    const slot = page.locator('[data-nr-part="item-view"]:visible');
    const normal = await diff.boundingBox();

    await diff.getByRole("button", { name: "Zoom pane", exact: true }).click();
    await expect(diff).toHaveAttribute("data-nr-zoom", "zoomed");
    await expect(terminal).toHaveAttribute("data-nr-zoom", "hidden");
    const zoomed = await diff.boundingBox();
    const area = await slot.boundingBox();
    if (normal === null || zoomed === null || area === null) throw new Error("no box");
    expect(zoomed.width).toBeGreaterThan(normal.width);
    expect(Math.abs(zoomed.width - area.width)).toBeLessThanOrEqual(2);
    expect(await onTop(diff.locator('[data-nr-part="diff-content"]'))).toBe(true);

    await diff.getByRole("button", { name: "Restore pane", exact: true }).click();
    await expect(diff).not.toHaveAttribute("data-nr-zoom", "zoomed");
    await expect(terminal).not.toHaveAttribute("data-nr-zoom", "hidden");
    expect(await onTop(diff.locator('[data-nr-part="diff-content"]'))).toBe(true);
  });

  test("scrolls by keyboard, because the lines take the focus", async ({ page }) => {
    await start(page, SPLIT, { diffs });
    const lines = page.locator('[data-pane-id="d1"] [data-nr-part="diff-content"]');
    await expect(lines).toBeVisible();
    await expect(lines.locator('tr[data-nr-row="change"]')).toHaveCount(150);
    expect(await lines.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await lines.evaluate((el) => el.scrollTop)).toBe(0);
    await lines.focus();
    await page.keyboard.press("PageDown");
    await expect.poll(() => lines.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press("End");
    await expect
      .poll(() => lines.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1))
      .toBe(true);
  });

  test("draws the first rows of a very long file and the rest on request", async ({ page }) => {
    await start(page, [{ id: "i1", title: "huge", panes: [diffPane("d1", "/work/huge")] }], {
      diffs,
    });
    // The hunk row counts toward the 2000 rows drawn.
    await expect(changeRows(page)).toHaveCount(1999);
    await expect(content(page).locator('[data-nr-part="diff-more"]')).toContainText(
      "Showing the first 2000 of 2101 rows.",
    );
    await content(page).getByRole("button", { name: "Show all rows", exact: true }).click();
    await expect(changeRows(page)).toHaveCount(2100);
    await expect(content(page).locator('[data-nr-part="diff-more"]')).toHaveCount(0);
  });

  test("a tab keeps the title its terminal gives it while the diff pane has the keyboard", async ({
    page,
  }) => {
    await start(
      page,
      [
        {
          id: "i1",
          panes: [{ id: "t1", kind: "terminal", cwd: "/srv/proj" }, diffPane("d1", REPO)],
        },
      ],
      { diffs },
    );
    const title = page.locator('[data-nr-part="item"] [data-nr-part="item-title"]');
    // The title is the folder of the terminal, not the folder the diff is of.
    await expect(title).toHaveText("proj");
    await page.locator('[data-pane-id="d1"] [data-nr-part="diff-content"]').click();
    await expect(page.locator('[data-pane-id="d1"]')).toHaveAttribute("data-nr-focused", "true");
    await expect(title).toHaveText("proj");
    // The sidebar words the pane for what it is.
    const entry = page.locator('[data-nr-part="item-pane"][data-nr-pane="d1"]');
    await expect(entry.locator('[data-nr-part="item-pane-status"]')).toHaveText("git diff");
    await expect(entry).toContainText("Changes in repo");
  });

  test("a tab left with only the diff pane is named after its folder", async ({ page }) => {
    await start(
      page,
      [
        {
          id: "i1",
          panes: [{ id: "t1", kind: "terminal", cwd: "/srv/proj" }, diffPane("d1", REPO)],
        },
      ],
      { diffs },
    );
    await setPaneHeaders(page, true);
    const title = page.locator('[data-nr-part="item"] [data-nr-part="item-title"]');
    await expect(title).toHaveText("proj");
    await page
      .locator('[data-pane-id="t1"]')
      .getByRole("button", { name: "Close pane", exact: true })
      .click();
    await expect.poll(() => paneIds(page)).toEqual(["d1"]);
    await expect(title).toHaveText("repo");
  });
});

test.describe("for people who use a keyboard or a screen reader", () => {
  test("axe: no violation on a diff, a one-sided change, a binary file, a clean repository and a refusal", async ({
    page,
  }) => {
    await start(
      page,
      [
        { id: "i1", title: "changes", panes: [diffPane("d1", REPO)] },
        { id: "i2", title: "clean", panes: [diffPane("d2", "/work/clean")] },
        { id: "i3", title: "plain", panes: [diffPane("d3", "/work/plain")] },
      ],
      { diffs: { [REPO]: SAMPLE, "/work/clean": "" } },
    );
    const check = (what: string): Promise<void> => expectNoAxeViolations(page, what);
    await expect(fileButtons(page)).toHaveCount(SAMPLE_FILES.length);
    await check("a modified file");
    await pick(page, "src/added.ts");
    await check("an added file");
    await pick(page, "logo.bin");
    await check("a binary file");
    await tabRow(page, "clean").click();
    await expect(shown(page).locator('[data-nr-part="diff-clean"]')).toBeVisible();
    await check("a clean repository");
    await tabRow(page, "plain").click();
    await expect(problem(page)).toBeVisible();
    await check("a refusal");
  });
});

test.describe("in Portuguese", () => {
  test.use({ locale: "pt-BR" });
  const PALETTE = "Paleta de comandos";
  const OPEN = "Mostrar o diff do git ao lado deste painel";

  test("says the pane, the columns, the statuses and the notes in the language", async ({
    page,
  }) => {
    await start(page, WORK);
    await expect(shown(page)).toHaveAttribute("aria-label", "Diff do git");
    await expect(shown(page).locator('[data-nr-part="diff-refresh"]')).toHaveAttribute(
      "aria-label",
      "Atualizar o diff",
    );
    await expect(shown(page).getByRole("list", { name: "Arquivos alterados" })).toBeVisible();
    await expect(content(page).locator("thead th")).toHaveText([
      "Último commit",
      "Árvore de trabalho",
    ]);
    await expect(fileButton(page, "README.md")).toContainText("Modificado");
    await expect(fileButton(page, "legacy.txt")).toContainText("Removido");
    await expect(fileButton(page, "logo.bin").locator(".diff-counts")).toHaveText("binário");
    await pick(page, "logo.bin");
    await expect(content(page).locator('[data-nr-part="diff-note"]')).toHaveText(
      "O git não mostra as linhas de um arquivo binário.",
    );
    await pick(page, "scripts/run.sh");
    await expect(content(page).locator('[data-nr-part="diff-note"]')).toHaveText(
      "O modo do arquivo mudou de 100644 para 100755.",
    );
    await pick(page, "docs/guide.md");
    await expect(content(page).locator('[data-nr-part="diff-file-head"]')).toContainText(
      "91% parecido",
    );
    await pick(page, "no-newline.txt");
    await expect(content(page).locator('[data-nr-part="diff-noeol"]').first()).toHaveText(
      "sem quebra de linha no fim do arquivo",
    );
  });

  test("says why a folder has no diff", async ({ page }) => {
    await start(
      page,
      [
        { id: "i1", title: "plain", panes: [diffPane("p1", "/work/plain")] },
        { id: "i2", title: "nogit", panes: [diffPane("p2", "/work/nogit")] },
        { id: "i3", title: "clean", panes: [diffPane("p3", "/work/clean")] },
      ],
      { diffs: { "/work/nogit": { reason: "git-missing" }, "/work/clean": "" } },
    );
    await expect(problem(page)).toHaveText("Esta pasta não está em um repositório git.");
    await tabRow(page, "nogit").click();
    await expect(problem(page)).toHaveText(
      "Não foi possível iniciar o git. Instale o git e confirme que ele está no PATH.",
    );
    await tabRow(page, "clean").click();
    await expect(shown(page).locator('[data-nr-part="diff-clean"]')).toContainText(
      "Nenhuma mudança: a árvore de trabalho e o índice são iguais ao último commit.",
    );
  });

  test("opens the diff from the palette, and says why it did not when there is no folder or no room", async ({
    page,
  }) => {
    await start(page, [
      { id: "i1", title: "work", panes: [{ id: "t1", kind: "terminal", cwd: REPO }] },
    ]);
    await runFromPalette(page, OPEN, PALETTE);
    await expect.poll(async () => (await paneIds(page)).length).toBe(2);
    await expect(fileButtons(page)).toHaveCount(SAMPLE_FILES.length);
    expect(await shells(page)).toBe(1);
  });

  test("tells a pane with no folder that there is no diff to show", async ({ page }) => {
    await start(page, [{ id: "i1", title: "work", panes: [{ id: "t1", kind: "terminal" }] }]);
    await runFromPalette(page, OPEN, PALETTE);
    await expect(notice(page)).toHaveText(
      "Este painel não tem uma pasta conhecida, então não há diff para mostrar.",
    );
    await page.waitForTimeout(300);
    expect(await paneIds(page)).toEqual(["t1"]);
  });

  test("tells a full tab that the diff was not opened", async ({ page }) => {
    // The limit of the settings (`terminal.maxPanes`) is four here; the default is eight.
    await seedConfig(page, '{ "terminal": { "maxPanes": 4 } }');
    await start(page, [
      {
        id: "i1",
        title: "work",
        panes: [
          { id: "t1", kind: "terminal", cwd: REPO },
          diffPane("d2", REPO),
          diffPane("d3", REPO),
          diffPane("d4", REPO),
        ],
      },
    ]);
    await runFromPalette(page, OPEN, PALETTE);
    await expect(notice(page)).toHaveText(
      "Uma aba tem no máximo 4 painéis, então o diff não foi aberto.",
    );
    await page.waitForTimeout(300);
    expect(await paneIds(page)).toHaveLength(4);
  });

  test("tells a folder git is not run in that no diff can be read there", async ({ page }) => {
    await start(page, [
      {
        id: "i1",
        title: "work",
        panes: [{ id: "t1", kind: "terminal", cwd: "\\\\server\\share\\repo" }],
      },
    ]);
    await runFromPalette(page, OPEN, PALETTE);
    await expect(notice(page)).toHaveText(
      "A pasta deste painel não é uma em que um diff possa ser lido.",
    );
    expect(await paneIds(page)).toEqual(["t1"]);
  });
});
