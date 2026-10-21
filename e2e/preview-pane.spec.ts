import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { expectNoAxeViolations } from "./axe-fixture";
import { setPaneHeaders } from "./settings-fixture";

// The preview pane (NOR-F15-02a): a pane that shows a file. The state is restored with panes of
// type "preview" and the files they name live in the fake computer of web mode (seeded in the
// browser storage before the page loads, like the picture files of a background), so these tests
// show what each kind of file turns into on screen: markdown, a picture, text, JSON that parses and
// JSON that does not, and a file that is refused. They hold that no shell is started for a
// preview pane, that the files are read once and not again at every render, that the pane is
// where it is drawn (nothing lies over it: composition is checked with `elementFromPoint`, since
// the unit tests render no layout), that it scrolls by keyboard, that nothing the file holds is
// loaded or run, and that it all works under the Content Security Policy of the app. The pane
// after a reload is the same pane. What the real files do through the real command is in the Rust
// tests (`preview.rs`, `bridge.rs`).

interface Hook {
  paneIds(): string[];
  sessionStarts(): unknown[];
  previewReads(): string[];
}
type HookWindow = Window & { __norenTest?: Hook; __previewScript?: number };

const WEB_STATE_KEY = "noren.web.state";
const WEB_FILES_KEY = "noren.web.files";
const FOLDER = "/fixtures/preview";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/preview/${name}`, import.meta.url));
const NOTES = fixture("notes.md");
const LOG = fixture("log.txt");
const DATA = fixture("data.json");
const BROKEN = fixture("broken-json.txt");
const PICTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));
// A one pixel gif.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const BINARY = Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02, 0x03]);
const LONG = Buffer.from(Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n"));
const TOO_LARGE = Buffer.alloc(1024 * 1024 + 1, 0x61);

/** A file of the fake computer: its bytes, or `null` for a folder. */
type FileSeed = Buffer | null;

const PATHS = {
  markdown: `${FOLDER}/notes.md`,
  image: `${FOLDER}/pixel.png`,
  gif: `${FOLDER}/dot.gif`,
  text: `${FOLDER}/log.txt`,
  json: `${FOLDER}/data.json`,
  broken: `${FOLDER}/broken.json`,
  binary: `${FOLDER}/blob.bin`,
  missing: `${FOLDER}/gone.md`,
  folder: `${FOLDER}/sub`,
  large: `${FOLDER}/huge.txt`,
  empty: `${FOLDER}/empty.txt`,
  long: `${FOLDER}/long.txt`,
} as const;

const FILES: Record<string, FileSeed> = {
  [PATHS.markdown]: NOTES,
  [PATHS.image]: PICTURE,
  [PATHS.gif]: GIF,
  [PATHS.text]: LOG,
  [PATHS.json]: DATA,
  [PATHS.broken]: BROKEN,
  [PATHS.binary]: BINARY,
  [PATHS.folder]: null,
  [PATHS.large]: TOO_LARGE,
  [PATHS.empty]: Buffer.alloc(0),
  [PATHS.long]: LONG,
};

/** A pane of a seeded tab: a preview of a file, or a terminal in a folder. */
type PaneSeed =
  { id: string; kind: "preview"; path: string } | { id: string; kind: "terminal"; cwd: string };

interface TabSeed {
  id: string;
  /** What the tab is called. It is locked, so the shell of a split tab cannot rename it. */
  title: string;
  panes: PaneSeed[];
}

const preview = (id: string, path: string): PaneSeed => ({ id, kind: "preview", path });

function paneJson(seed: PaneSeed): Record<string, unknown> {
  const common = { id: seed.id, profileId: "default", status: "idle", unread: false, bell: false };
  return seed.kind === "preview"
    ? { ...common, type: "preview", path: seed.path }
    : { ...common, type: "terminal", cwd: seed.cwd };
}

/** The state file of one space whose tabs are `tabs`, the first one on screen. */
function savedState(tabs: TabSeed[]): string {
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
        tree: tabs.map((tab) => ({ kind: "item", id: tab.id })),
        items,
        activeItemId: tabs[0]?.id,
      },
    ],
  });
}

/** Puts the saved workspace and the files in the browser storage before the page loads (once). */
async function seed(page: Page, tabs: TabSeed[], files: Record<string, FileSeed>): Promise<void> {
  const encoded = Object.fromEntries(
    Object.entries(files).map(([path, bytes]) => [
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
    { stateKey: WEB_STATE_KEY, state: savedState(tabs), filesKey: WEB_FILES_KEY, stored: encoded },
  );
}

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const shells = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts().length ?? 0);
const reads = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.previewReads() ?? []);
const savedText = (page: Page): Promise<string> =>
  page.evaluate((key) => window.localStorage.getItem(key) ?? "", WEB_STATE_KEY);

/** Seeds and opens the app; waits until the panes of the tab on screen (the first) are known. */
async function start(
  page: Page,
  tabs: TabSeed[],
  files: Record<string, FileSeed> = FILES,
): Promise<void> {
  await seed(page, tabs, files);
  await page.goto("/");
  await expect.poll(() => paneIds(page)).toEqual(tabs[0]?.panes.map((pane) => pane.id));
}

/** The tabs of the sidebar: the one tree of the window, called "Tabs" or "Abas". */
const tabList = (page: Page) => page.getByRole("tree");
const tabRow = (page: Page, name: string): Locator =>
  tabList(page).getByRole("treeitem", { name, exact: true });
/** The preview pane on screen (the panes of the other tabs are mounted and hidden). */
const shown = (page: Page): Locator => page.locator('[data-nr-part="preview-pane"]:visible');
const body = (page: Page): Locator => shown(page).locator('[data-nr-part="preview-body"]');

async function goTo(page: Page, name: string): Promise<void> {
  await tabRow(page, name).click();
  await expect(shown(page).first()).toBeVisible();
}

const text = (bytes: Buffer): string => bytes.toString("utf8").replace(/\r\n/g, "\n");
/** The text of an element as the file wrote it (the page may draw CRLF as it came). */
const textOf = async (locator: Locator): Promise<string> =>
  ((await locator.textContent()) ?? "").replace(/\r\n/g, "\n");

const FORMATTED_DATA = [
  "{",
  '  "name": "noren",',
  '  "list": [',
  "    1,",
  "    2,",
  "    {",
  '      "deep": true',
  "    }",
  "  ],",
  '  "big": 12345678901234567890,',
  '  "empty": {}',
  "}",
].join("\n");

const SIX: TabSeed[] = [
  { id: "i1", title: "notes", panes: [preview("p1", PATHS.markdown)] },
  { id: "i2", title: "picture", panes: [preview("p2", PATHS.image)] },
  { id: "i3", title: "log", panes: [preview("p3", PATHS.text)] },
  { id: "i4", title: "data", panes: [preview("p4", PATHS.json)] },
  { id: "i5", title: "broken", panes: [preview("p5", PATHS.broken)] },
  { id: "i6", title: "binary", panes: [preview("p6", PATHS.binary)] },
  {
    id: "i7",
    title: "split",
    panes: [{ id: "t7", kind: "terminal", cwd: "/srv/proj" }, preview("p7", PATHS.text)],
  },
];

test.describe("restoring preview panes", () => {
  test("each kind of file shows what it is, with its path on top and no shell of its own", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await start(page, SIX);

    // The first tab is the one on screen, and only its preview pane is.
    await expect(tabRow(page, "notes")).toHaveAttribute("aria-selected", "true");
    await expect(shown(page)).toHaveCount(1);

    // Markdown: formatted by the same parser as the answers of the AI, with its path on top.
    await expect(shown(page).locator('[data-nr-part="preview-path"]')).toContainText(
      PATHS.markdown,
    );
    const markdown = body(page);
    await expect(markdown.locator("h3")).toHaveText("Notes");
    await expect(markdown.locator("strong")).toHaveText("bold");
    await expect(markdown.locator("p code")).toHaveText("inline code");
    await expect(markdown.locator("li")).toHaveText(["first item", "second item"]);
    await expect(markdown.locator("pre code")).toHaveText("echo hello");
    // What the file says about a picture, a link and a tag is text, not an element.
    await expect(markdown).toContainText("![tracker](https://tracker.invalid/pixel.png)");
    await expect(markdown).toContainText('<img src="https://tracker.invalid/other.png"');
    await expect(markdown.locator("img, a, script, iframe, link, svg, button")).toHaveCount(0);

    // A picture: an element over an address in memory, which decoded.
    await goTo(page, "picture");
    await expect(shown(page).locator('[data-nr-part="preview-path"]')).toContainText(PATHS.image);
    const image = body(page).locator("img.preview-image");
    await expect(image).toHaveAttribute("src", /^blob:/);
    await expect(image).toHaveAttribute("alt", "pixel.png");
    await expect
      .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);

    // Plain text: monospaced, as written, markup in it is not markup.
    await goTo(page, "log");
    const plain = body(page).locator("pre.preview-text");
    expect(await textOf(plain)).toBe(text(LOG));
    expect(await plain.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i);
    await expect(body(page).locator("b")).toHaveCount(0);

    // JSON that parses: written out, nothing rounded, no warning.
    await goTo(page, "data");
    expect(await textOf(body(page).locator("pre.preview-text"))).toBe(FORMATTED_DATA);
    await expect(shown(page).locator('[data-nr-part="preview-warning"]')).toHaveCount(0);

    // JSON that does not: as it is, with a warning.
    await goTo(page, "broken");
    expect(await textOf(body(page).locator("pre.preview-text"))).toBe(text(BROKEN));
    await expect(shown(page).locator('[data-nr-part="preview-warning"]')).toHaveText(
      "This file is not valid JSON. It is shown as plain text.",
    );

    // A file that is refused: the reason, as an alert.
    await goTo(page, "binary");
    const refused = shown(page).locator('[data-nr-part="preview-problem"]');
    await expect(refused).toHaveText("This looks like a binary file, so it is not previewed.");
    await expect(refused).toHaveAttribute("role", "alert");
    await expect(refused).toHaveAttribute("data-nr-reason", "binary");

    // A tab with a terminal and a file side by side: both panes, and the sidebar lists the file by
    // its name and says it is a preview.
    await goTo(page, "split");
    await expect(page.locator('[data-nr-part="preview-pane"]:visible')).toHaveCount(1);
    await expect(page.locator(".xterm:visible")).toHaveCount(1);
    await expect(
      tabList(page).getByRole("treeitem", { name: "log.txt file preview" }),
    ).toBeVisible();

    // One shell, the terminal of the split tab: none for the seven preview panes.
    expect(await shells(page)).toBe(1);
    // Each file was read once (the seventh pane shows the log again), not at every render.
    expect((await reads(page)).sort()).toEqual(
      [
        PATHS.markdown,
        PATHS.image,
        PATHS.text,
        PATHS.json,
        PATHS.broken,
        PATHS.binary,
        PATHS.text,
      ].sort(),
    );
    // Nothing the files hold was loaded or run: no request outside the app, no script, no error.
    const app = new URL(page.url()).origin;
    expect(requests.filter((url) => url.startsWith("http") && !url.startsWith(app))).toEqual([]);
    expect(requests.filter((url) => url.includes("tracker.invalid"))).toEqual([]);
    expect(await page.evaluate(() => (window as HookWindow).__previewScript)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test("the panes come back after a reload, with their files", async ({ page }) => {
    await start(page, SIX);
    await goTo(page, "data");
    // The tab on screen is part of the saved state; wait until the app has written it.
    await expect.poll(() => savedText(page)).toContain('"activeItemId":"i4"');
    const before = await savedText(page);
    expect(before).toContain('"type":"preview"');
    expect(before).toContain(`"path":"${PATHS.json}"`);

    await page.reload();
    await expect.poll(() => paneIds(page)).toEqual(["p4"]);
    await expect(shown(page)).toHaveCount(1);
    expect(await textOf(body(page).locator("pre.preview-text"))).toBe(FORMATTED_DATA);
    // The other kinds are back too.
    await goTo(page, "picture");
    await expect(body(page).locator("img.preview-image")).toHaveAttribute("src", /^blob:/);
    await goTo(page, "binary");
    await expect(shown(page).locator('[data-nr-part="preview-problem"]')).toHaveAttribute(
      "data-nr-reason",
      "binary",
    );
    await goTo(page, "notes");
    await expect(body(page).locator("h3")).toHaveText("Notes");
    // Still one shell on this page too, and the state file kept every preview pane as it was.
    expect(await shells(page)).toBe(1);
    expect((await savedText(page)).match(/"type":"preview"/g)).toHaveLength(7);
  });

  test("a file that is not shown says why: a missing one, a folder, one too large and an empty one", async ({
    page,
  }) => {
    await start(page, [
      { id: "i1", title: "missing", panes: [preview("p1", PATHS.missing)] },
      { id: "i2", title: "folder", panes: [preview("p2", PATHS.folder)] },
      { id: "i3", title: "large", panes: [preview("p3", PATHS.large)] },
      { id: "i4", title: "empty", panes: [preview("p4", PATHS.empty)] },
      { id: "i5", title: "gif", panes: [preview("p5", PATHS.gif)] },
    ]);
    const problem = shown(page).locator('[data-nr-part="preview-problem"]');

    await expect(problem).toHaveText("There is no file at this path.");
    await expect(problem).toHaveAttribute("data-nr-reason", "missing");

    await goTo(page, "folder");
    await expect(problem).toHaveText("This is a folder, not a file.");
    await expect(problem).toHaveAttribute("data-nr-reason", "directory");

    await goTo(page, "large");
    await expect(problem).toHaveText(
      "This file is 1.1 MiB. A preview shows text up to 1 MiB and pictures up to 10 MiB.",
    );
    await expect(problem).toHaveAttribute("data-nr-reason", "too-large");

    await goTo(page, "empty");
    await expect(body(page)).toHaveText("This file is empty.");

    // A picture is told by its bytes, whatever kind it is.
    await goTo(page, "gif");
    await expect(body(page).locator("img.preview-image")).toHaveAttribute("src", /^blob:/);
    expect(await shells(page)).toBe(0);
  });
});

test.describe("in a split", () => {
  const SPLIT: TabSeed[] = [
    {
      id: "i1",
      title: "work",
      panes: [{ id: "t1", kind: "terminal", cwd: "/srv/proj" }, preview("p1", PATHS.long)],
    },
  ];

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
    await start(page, SPLIT);
    await setPaneHeaders(page, true);
    const terminal = page.locator('[data-pane-id="t1"]');
    const file = page.locator('[data-pane-id="p1"]');
    await expect(file.locator('[data-nr-part="preview-body"]')).toBeVisible();

    const a = await terminal.boundingBox();
    const b = await file.boundingBox();
    if (a === null || b === null) throw new Error("a pane is not on screen");
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
    expect(b.width).toBeGreaterThan(100);

    expect(await onTop(file.locator('[data-nr-part="preview-body"]'))).toBe(true);
    expect(await onTop(file.locator('[data-nr-part="preview-path"]'))).toBe(true);
    // The header names the file and the sidebar words what the pane is.
    await expect(file.locator('[data-nr-part="pane-header"]')).toContainText("long.txt");

    // The terminal has the keyboard until the file is clicked.
    await expect(terminal).toHaveAttribute("data-nr-focused", "true");
    await file.locator('[data-nr-part="preview-body"]').click();
    await expect(file).toHaveAttribute("data-nr-focused", "true");
    await expect(terminal).toHaveAttribute("data-nr-focused", "false");
    expect(await shells(page)).toBe(1);
  });

  test("zooms to fill the tab and back, still on top", async ({ page }) => {
    await start(page, SPLIT);
    await setPaneHeaders(page, true);
    const terminal = page.locator('[data-pane-id="t1"]');
    const file = page.locator('[data-pane-id="p1"]');
    const slot = page.locator('[data-nr-part="item-view"]:visible');
    const normal = await file.boundingBox();

    await file.getByRole("button", { name: "Zoom pane", exact: true }).click();
    await expect(file).toHaveAttribute("data-nr-zoom", "zoomed");
    await expect(terminal).toHaveAttribute("data-nr-zoom", "hidden");
    const zoomed = await file.boundingBox();
    const area = await slot.boundingBox();
    if (normal === null || zoomed === null || area === null) throw new Error("no box");
    expect(zoomed.width).toBeGreaterThan(normal.width);
    expect(Math.abs(zoomed.width - area.width)).toBeLessThanOrEqual(2);
    expect(await onTop(file.locator('[data-nr-part="preview-body"]'))).toBe(true);

    await file.getByRole("button", { name: "Restore pane", exact: true }).click();
    await expect(file).not.toHaveAttribute("data-nr-zoom", "zoomed");
    await expect(terminal).not.toHaveAttribute("data-nr-zoom", "hidden");
    expect(await onTop(file.locator('[data-nr-part="preview-body"]'))).toBe(true);
  });

  test("scrolls by keyboard, because the body takes the focus", async ({ page }) => {
    await start(page, SPLIT);
    const content = page.locator('[data-pane-id="p1"] [data-nr-part="preview-body"]');
    await expect(content).toBeVisible();
    expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await content.evaluate((el) => el.scrollTop)).toBe(0);
    await content.focus();
    await page.keyboard.press("PageDown");
    await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press("End");
    await expect
      .poll(() => content.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1))
      .toBe(true);
  });
});

test.describe("under the policy of the app", () => {
  // The policy of the desktop app (apps/desktop/src-tauri/tauri.conf.json) applied to the web build,
  // as e2e/csp.spec.ts does: a picture from memory must show, and nothing a file holds may be fetched.
  const conf = JSON.parse(
    readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ) as { app: { security: { csp: Record<string, string> } } };
  const POLICY = Object.entries(conf.app.security.csp)
    .map(([directive, sources]) => `${directive} ${sources}`)
    .join("; ");

  test("a picture shows from memory and a markdown file loads nothing, with no violation", async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/content security policy|refused to/i.test(message.text())) {
        violations.push(message.text());
      }
    });
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": POLICY },
      });
    });
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __violations: string[] }).__violations = seen;
      document.addEventListener("securitypolicyviolation", (event) => {
        seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
      });
    });
    await start(page, SIX);
    expect(POLICY).toContain("img-src 'self' blob:");

    await expect(body(page).locator("h3")).toHaveText("Notes");
    await goTo(page, "picture");
    const image = body(page).locator("img.preview-image");
    await expect(image).toHaveAttribute("src", /^blob:/);
    await expect
      .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await goTo(page, "notes");

    const seen = await page.evaluate(
      () => (window as unknown as { __violations: string[] }).__violations,
    );
    expect(seen).toEqual([]);
    expect(violations).toEqual([]);
  });
});

test.describe("for people who use a keyboard or a screen reader", () => {
  test("axe: no violation on a text, a markdown, a picture and a refused file", async ({
    page,
  }) => {
    await start(page, SIX);
    for (const name of ["notes", "picture", "log", "data", "broken", "binary", "split"]) {
      await goTo(page, name);
      await expectNoAxeViolations(page, name);
    }
  });
});

test.describe("in Portuguese", () => {
  test.use({ locale: "pt-BR" });

  test("says the pane, the reason a file is refused and the warning of JSON in the language", async ({
    page,
  }) => {
    await start(page, SIX);
    await goTo(page, "binary");
    await expect(shown(page)).toHaveAttribute("aria-label", "Prévia de arquivo");
    await expect(shown(page).locator('[data-nr-part="preview-problem"]')).toHaveText(
      "Parece um arquivo binário, por isso não tem prévia.",
    );
    await goTo(page, "broken");
    await expect(shown(page).locator('[data-nr-part="preview-warning"]')).toHaveText(
      "Este arquivo não é um JSON válido. Ele está sendo mostrado como texto simples.",
    );
    await expect(body(page)).toHaveAttribute("aria-label", "Conteúdo de broken.json");
  });
});
