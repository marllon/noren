import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { clicksReachThePage } from "./sidebar-fixture";

// The preview and diff panes in a window besides the main one (NOR-F15-04d). A tab with one of
// them goes to a window by dragging it out or by "Move tab to new window", and the page of the
// window draws the pane. That page can read no file and run no git (its capability has no such
// command), so it asks the main window (`window-read`), which checks that the pane is one of the
// window's and that the path or folder is the pane's own, reads it through the backend and answers
// that window (`window-read-result`). A browser has no second window, so `/?window-preview` draws
// each one as a panel beside the app on the same fake backend and the same events, with a backend
// for the panel that refuses the two reads as the real window does (see window-drag.spec.ts); what
// the panels cannot say is in `noren --smoke-window`.
//
// The seeded main window ("Main"), the first tab on screen:
//   plain     a terminal
//   notes     a terminal and a preview of notes.md
//   picture   a terminal and a preview of a picture
//   changes   a terminal and a diff of /work/repo
//   lost      a terminal and a preview of a file that is not there
//   norepo    a terminal and a diff of a folder that is in no repository
//   web       a terminal and a browser pane
//   mixed     a terminal, a preview and a browser pane

interface Hook {
  paneIds(): string[];
  sessionStarts(): unknown[];
  previewReads(): string[];
  gitDiffReads(): string[];
  setGitDiff(folder: string, entry: string | { kind: "refused"; reason: string } | null): void;
}
interface WindowsHook {
  windows(): string[];
  closeByPerson(windowId: string): void;
  read(windowId: string, body: unknown): void;
  replies(): unknown[];
}
type HookWindow = Window & { __norenTest?: Hook; __norenWindows?: WindowsHook };

const WEB_STATE_KEY = "noren.web.state";
const WEB_FILES_KEY = "noren.web.files";
const WEB_GIT_DIFFS_KEY = "noren.web.git-diffs";
const FOLDER = "/fixtures/preview";
const NOTES_PATH = `${FOLDER}/notes.md`;
const PICTURE_PATH = `${FOLDER}/pixel.png`;
const GONE_PATH = `${FOLDER}/gone.md`;
const REPO = "/work/repo";
const NO_REPO = "/work/plain-folder";

const NOTES = readFileSync(new URL("./fixtures/preview/notes.md", import.meta.url));
const PICTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));
const SAMPLE = readFileSync(new URL("./fixtures/diff/sample.diff", import.meta.url), "utf8");
const SAMPLE_FILE_COUNT = 9;

/** The diff of one new file, for the refresh. */
const SMALL_DIFF = [
  "diff --git a/fresh.txt b/fresh.txt",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/fresh.txt",
  "@@ -0,0 +1,1 @@",
  "+fresh line",
  "",
].join("\n");

type PaneSeed =
  | { id: string; kind: "terminal" }
  | { id: string; kind: "preview"; path: string }
  | { id: string; kind: "diff"; cwd: string }
  | { id: string; kind: "browser"; url: string };

interface TabSeed {
  id: string;
  title: string;
  panes: PaneSeed[];
}

const terminal = (id: string): PaneSeed => ({ id, kind: "terminal" });
const TABS: TabSeed[] = [
  { id: "i1", title: "plain", panes: [terminal("p1")] },
  {
    id: "i2",
    title: "notes",
    panes: [terminal("p2"), { id: "p3", kind: "preview", path: NOTES_PATH }],
  },
  {
    id: "i3",
    title: "picture",
    panes: [terminal("p4"), { id: "p5", kind: "preview", path: PICTURE_PATH }],
  },
  {
    id: "i4",
    title: "changes",
    panes: [terminal("p6"), { id: "p7", kind: "diff", cwd: REPO }],
  },
  {
    id: "i5",
    title: "lost",
    panes: [terminal("p8"), { id: "p9", kind: "preview", path: GONE_PATH }],
  },
  {
    id: "i6",
    title: "norepo",
    panes: [terminal("p10"), { id: "p11", kind: "diff", cwd: NO_REPO }],
  },
  {
    id: "i7",
    title: "web",
    panes: [terminal("p12"), { id: "p13", kind: "browser", url: "https://example.com/" }],
  },
  {
    id: "i8",
    title: "mixed",
    panes: [
      terminal("p14"),
      { id: "p15", kind: "preview", path: NOTES_PATH },
      { id: "p16", kind: "browser", url: "https://example.com/" },
    ],
  },
];

function paneJson(seed: PaneSeed): Record<string, unknown> {
  const common = { id: seed.id, profileId: "default", status: "idle", unread: false, bell: false };
  switch (seed.kind) {
    case "terminal":
      return { ...common, type: "terminal" };
    case "preview":
      return { ...common, type: "preview", path: seed.path };
    case "diff":
      return { ...common, type: "diff", cwd: seed.cwd };
    case "browser":
      return { ...common, type: "browser", url: seed.url };
  }
}

function savedState(): string {
  const items = Object.fromEntries(
    TABS.map((tab) => {
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
          title: tab.title,
          titleLocked: true,
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
        defaults: { env: {} },
        aiEnabled: true,
        saveScrollback: false,
        pinned: [],
        tree: TABS.map((tab) => ({ kind: "item", id: tab.id })),
        items,
        activeItemId: "i1",
      },
    ],
  });
}

/** Puts the saved workspace, the files and the diffs in the browser storage before the page loads (once). */
async function seed(page: Page): Promise<void> {
  await page.addInitScript(
    ({ stateKey, state, filesKey, files, diffsKey, diffs }) => {
      if (window.localStorage.getItem(stateKey) !== null) return;
      window.localStorage.setItem(stateKey, state);
      window.localStorage.setItem(filesKey, JSON.stringify(files));
      window.localStorage.setItem(diffsKey, JSON.stringify(diffs));
    },
    {
      stateKey: WEB_STATE_KEY,
      state: savedState(),
      filesKey: WEB_FILES_KEY,
      files: {
        [NOTES_PATH]: NOTES.toString("base64"),
        [PICTURE_PATH]: PICTURE.toString("base64"),
      },
      diffsKey: WEB_GIT_DIFFS_KEY,
      diffs: { [REPO]: SAMPLE },
    },
  );
}

// The sidebar of the main window: a window panel has a tree with the same name of its own.
const list = (page: Page) =>
  page.locator('[data-nr-part="sidebar"]').getByRole("tree", { name: "Tabs", exact: true });
const row = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const panels = (page: Page): Locator => page.locator('[data-nr-part="window-preview"]');
const panelRow = (panel: Locator, name: string): Locator =>
  panel.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem", {
    name,
    exact: true,
  });
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');

const previewReads = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.previewReads() ?? []);
const gitDiffReads = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.gitDiffReads() ?? []);
const windowIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenWindows?.windows() ?? []);
const replies = (page: Page): Promise<{ windowId: string; request: number; kind?: string }[]> =>
  page.evaluate(
    () =>
      ((window as HookWindow).__norenWindows?.replies() ?? []) as {
        windowId: string;
        request: number;
        kind?: string;
      }[],
  );
const askToRead = (page: Page, windowId: string, body: unknown): Promise<void> =>
  page.evaluate(([id, fields]) => (window as HookWindow).__norenWindows?.read(id, fields), [
    windowId,
    body,
  ] as const);

/** Presses on a tab of the main sidebar, drags it out of the page and lets go there. */
async function dragOut(page: Page, name: string): Promise<void> {
  // Eight tabs with their panes do not all fit: the list scrolls, and a drag that starts under the
  // title bar grabs nothing.
  await row(page, name).scrollIntoViewIfNeeded();
  const from = await row(page, name).boundingBox();
  if (!from) throw new Error(`${name} is not on screen`);
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 10, { steps: 3 });
  await page.mouse.move(-60, start.y + 20, { steps: 20 });
  await page.mouse.up();
  await clicksReachThePage(page);
}

async function open(page: Page): Promise<void> {
  await seed(page);
  await page.goto("/?window-preview");
  await expect(row(page, "plain")).toBeVisible();
  await expect
    .poll(
      async () =>
        await page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0),
    )
    .toBeGreaterThan(0);
}

/** Drags a tab out and waits for the panel of its window. */
async function dragToPanel(page: Page, name: string): Promise<Locator> {
  const before = await panels(page).count();
  await dragOut(page, name);
  await expect(panels(page)).toHaveCount(before + 1);
  return panels(page).nth(before);
}

const markdownIn = (panel: Locator): Locator => panel.locator('[data-nr-part="preview-markdown"]');
const diffFilesIn = (panel: Locator): Locator => panel.locator('[data-nr-part="diff-file"]');

test("a tab with a preview pane dragged out shows the file in the window, read by the main window", async ({
  page,
}) => {
  await open(page);
  const before = (await previewReads(page)).filter((path) => path === NOTES_PATH).length;
  const panel = await dragToPanel(page, "notes");
  await expect(markdownIn(panel)).toContainText("Some bold words and inline code in a paragraph."); // The path is on top, as in the main window, and the tab left the main sidebar.
  await expect(panel.locator('[data-nr-part="preview-path"]')).toHaveText(
    new RegExp(`${NOTES_PATH}$`),
  );
  await expect(row(page, "notes")).toHaveCount(0);
  // One read for the window, made by the main window (a panel's own backend refuses the read),
  // and one answer sent to that window.
  await expect
    .poll(async () => (await previewReads(page)).filter((path) => path === NOTES_PATH).length)
    .toBe(before + 1);
  const answers = (await replies(page)).filter((reply) => reply.kind === "preview");
  expect(answers).toHaveLength(1);
  expect(answers[0]?.windowId).toBe((await windowIds(page))[0]);
  // The terminal of the tab is in the window too, next to the file.
  await expect(panel.locator('[data-nr-part="window-terminal"] .xterm')).toHaveCount(1);
  await expect(panel.locator('[data-nr-part="window-pane-elsewhere"]')).toHaveCount(0);
});

test("Move tab to new window does the same for a tab with a diff pane: the files and the rows are drawn in the window", async ({
  page,
}) => {
  await open(page);
  await row(page, "changes").click();
  await expect(row(page, "changes")).toHaveAttribute("aria-current", "true");
  const before = (await gitDiffReads(page)).length;
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("Move tab to new");
  await page.keyboard.press("Enter");
  await expect(panels(page)).toHaveCount(1);
  const panel = panels(page).first();
  await expect(diffFilesIn(panel)).toHaveCount(SAMPLE_FILE_COUNT);
  await expect(diffFilesIn(panel).first()).toHaveAttribute("data-nr-path", "README.md");
  // The first file's rows, side by side.
  await expect(
    panel.locator('[data-nr-part="diff-table"] [data-nr-row="change"]').first(),
  ).toBeVisible();
  // Picking another file draws it (the page holds the diff, it does not ask again).
  const reads = (await gitDiffReads(page)).length;
  await diffFilesIn(panel).nth(1).click();
  await expect(panel.locator('[data-nr-part="diff-file-title"]')).toContainText("guide.md");
  expect((await gitDiffReads(page)).length).toBe(reads);
  // The folder the pane holds was the one read, once for the window.
  expect((await gitDiffReads(page)).slice(before).filter((folder) => folder === REPO)).toHaveLength(
    1,
  );
  await expect(row(page, "changes")).toHaveCount(0);
});

test("a picture reaches the window as the picture it is", async ({ page }) => {
  await open(page);
  const panel = await dragToPanel(page, "picture");
  const image = panel.locator('[data-nr-part="preview-image"]');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
});

test("a file that is not there, and a folder that is in no repository, are said in the window", async ({
  page,
}) => {
  await open(page);
  const lost = await dragToPanel(page, "lost");
  const problem = lost.locator('[data-nr-part="preview-problem"]');
  await expect(problem).toHaveText("There is no file at this path.");
  await expect(problem).toHaveAttribute("data-nr-reason", "missing");
  const norepo = await dragToPanel(page, "norepo");
  const noDiff = norepo.locator('[data-nr-part="diff-problem"]');
  await expect(noDiff).toHaveText("This folder is not in a git repository.");
  await expect(noDiff).toHaveAttribute("data-nr-reason", "not-a-repository");
  // The refusals are answers of the main window, not a failure of the page.
  expect((await replies(page)).map((reply) => reply.kind).sort()).toEqual(["diff", "preview"]);
});

test("refreshing the diff of a window reads again through the main window", async ({ page }) => {
  await open(page);
  const panel = await dragToPanel(page, "changes");
  await expect(diffFilesIn(panel)).toHaveCount(SAMPLE_FILE_COUNT);
  const reads = (await gitDiffReads(page)).length;
  await page.evaluate(
    ([folder, text]) =>
      (window as HookWindow).__norenTest?.setGitDiff(folder as string, text as string),
    [REPO, SMALL_DIFF] as const,
  );
  await panel.getByRole("button", { name: "Refresh the diff" }).click();
  await expect(diffFilesIn(panel)).toHaveCount(1);
  await expect(diffFilesIn(panel).first()).toHaveAttribute("data-nr-path", "fresh.txt");
  expect((await gitDiffReads(page)).slice(reads)).toEqual([REPO]);
  expect((await replies(page)).filter((reply) => reply.kind === "diff")).toHaveLength(2);
});

test("a diff pane of a tab that is not on screen in the window reads when the tab is shown, not before", async ({
  page,
}) => {
  await open(page);
  const panel = await dragToPanel(page, "changes");
  await expect(diffFilesIn(panel)).toHaveCount(SAMPLE_FILE_COUNT);
  const reads = (await gitDiffReads(page)).length;
  // A new tab takes the screen; the diff tab is hidden and does not read.
  await panel.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(panel.locator('[data-nr-part="window-terminal"] .xterm')).toHaveCount(2);
  await expect(panelRow(panel, "changes")).not.toHaveAttribute("aria-current", "true");
  expect((await gitDiffReads(page)).length).toBe(reads);
  // Showing it again reads again, as the main window does when a tab comes back.
  await panelRow(panel, "changes").click();
  await expect(panelRow(panel, "changes")).toHaveAttribute("aria-current", "true");
  await expect.poll(async () => (await gitDiffReads(page)).length).toBe(reads + 1);
  await expect(diffFilesIn(panel)).toHaveCount(SAMPLE_FILE_COUNT);
});

test("a read that is not the window's own is ignored: another window, another space, another path", async ({
  page,
}) => {
  await open(page);
  const notes = await dragToPanel(page, "notes");
  await expect(markdownIn(notes)).toBeVisible();
  const changes = await dragToPanel(page, "changes");
  await expect(diffFilesIn(changes)).toHaveCount(SAMPLE_FILE_COUNT);
  const [first, second] = await windowIds(page);
  if (first === undefined || second === undefined) throw new Error("two windows were expected");
  const previews = (await previewReads(page)).length;
  const diffs = (await gitDiffReads(page)).length;
  const answered = (await replies(page)).length;

  const ownPreview = {
    request: 7001,
    kind: "preview",
    itemId: "i2",
    paneId: "p3",
    path: NOTES_PATH,
  };
  const ownDiff = { request: 7002, kind: "diff", itemId: "i4", paneId: "p7", cwd: REPO };
  for (const [windowId, body] of [
    // A pane of the other window's space.
    [first, { ...ownDiff }],
    [second, { ...ownPreview }],
    // A pane of the main window's space (a tab that stayed there).
    [first, { request: 7003, kind: "preview", itemId: "i5", paneId: "p9", path: GONE_PATH }],
    [second, { request: 7004, kind: "diff", itemId: "i6", paneId: "p11", cwd: NO_REPO }],
    // The window's own pane, with a path or folder that is not the pane's.
    [first, { ...ownPreview, path: "/etc/passwd" }],
    [first, { ...ownPreview, path: PICTURE_PATH }],
    [second, { ...ownDiff, cwd: "/" }],
    [second, { ...ownDiff, cwd: `${REPO}/sub` }],
    // A pane of the right tab that is the wrong kind, a terminal, a pane that does not exist.
    [first, { ...ownPreview, paneId: "p2" }],
    [first, { ...ownPreview, kind: "diff", cwd: NOTES_PATH }],
    [second, { ...ownDiff, paneId: "p6" }],
    [second, { ...ownDiff, paneId: "ghost" }],
    // A window that is not one, and a number that is not a request.
    ["main", { ...ownPreview }],
    ["window-ghost", { ...ownPreview }],
    [first, { ...ownPreview, request: 0 }],
    [first, { ...ownPreview, request: "7" }],
  ] as const) {
    await askToRead(page, windowId, body);
  }
  // The right ones, last: when they are answered the wrong ones before them were heard and passed over.
  await askToRead(page, first, ownPreview);
  await askToRead(page, second, ownDiff);
  await expect.poll(async () => (await replies(page)).length).toBe(answered + 2);
  const sent = (await replies(page)).slice(answered);
  expect(sent.map((reply) => [reply.windowId, reply.request, reply.kind])).toEqual([
    [first, 7001, "preview"],
    [second, 7002, "diff"],
  ]);
  expect((await previewReads(page)).slice(previews)).toEqual([NOTES_PATH]);
  expect((await gitDiffReads(page)).slice(diffs)).toEqual([REPO]);
});

test("a tab with a browser pane still stays in the main window, even beside a preview", async ({
  page,
}) => {
  await open(page);
  for (const name of ["web", "mixed"]) {
    await dragOut(page, name);
    await expect(notice(page)).toHaveText("A tab with a browser pane stays in the main window.");
    await expect(panels(page)).toHaveCount(0);
    await expect(row(page, name)).toBeVisible();
  }
  // And one with a preview or a diff and no browser goes, with the others still where they are.
  await dragOut(page, "notes");
  await expect(panels(page)).toHaveCount(1);
  await expect(row(page, "web")).toBeVisible();
  await expect(row(page, "mixed")).toBeVisible();
});

test("the panes come back with the window after a reload, and with the tab when the window is closed", async ({
  page,
}) => {
  await open(page);
  const panel = await dragToPanel(page, "notes");
  await expect(markdownIn(panel)).toBeVisible();
  await expect(diffFilesIn(await dragToPanel(page, "changes"))).toHaveCount(SAMPLE_FILE_COUNT);
  await page.reload();
  await expect(row(page, "plain")).toBeVisible();
  await expect(panels(page)).toHaveCount(2);
  await expect(markdownIn(panels(page).first())).toContainText("Some bold words");
  await expect(diffFilesIn(panels(page).nth(1))).toHaveCount(SAMPLE_FILE_COUNT);
  // The person closes the window of the notes: the tab is back in the main window with its file.
  const [windowId] = await windowIds(page);
  await page.evaluate(
    (id) => (window as HookWindow).__norenWindows?.closeByPerson(id as string),
    windowId,
  );
  await expect(panels(page)).toHaveCount(1);
  await expect(row(page, "notes")).toBeVisible();
  await row(page, "notes").click();
  await expect(row(page, "notes")).toHaveAttribute("aria-current", "true");
  // (The main window keeps the preview of every tab, the ones that are not on screen hidden.)
  await expect(
    page.locator('[data-nr-part="item-view"]:not([hidden]) [data-nr-part="preview-markdown"]'),
  ).toContainText("Some bold words");
});
