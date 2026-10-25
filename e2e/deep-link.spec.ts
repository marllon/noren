import { expect, test } from "./test";
import type { Page } from "@playwright/test";
import {
  ACTIONS_CWD,
  ACTIONS_TEXT,
  changeActionsFile,
  seedActionsFile,
  seedSidebarState,
} from "./sidebar-fixture";

interface Hook {
  commandRuns(): { cwd: string; command: string }[];
  sessionStarts(): { cwd?: string }[];
  writeCalls(): number;
  lines(): string[];
  openUrl(url: string): Promise<void>;
}
type HookWindow = Window & {
  __norenTest?: Hook;
  __norenHandleDeepLink?: (url: unknown) => Promise<void>;
};

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const space = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Spaces", exact: true }).getByRole("button", {
    name,
    exact: true,
  });
const header = (page: Page) => page.getByRole("region", { name: "Projects", exact: true });
/** The block of a space in the Projects section. */
const blockOf = (page: Page, name: string) =>
  header(page).locator(".project-name-text", { hasText: name });
const button = (page: Page, name: string) =>
  header(page).getByRole("button", { name, exact: true });
const confirm = (page: Page) =>
  page.getByRole("alertdialog", { name: "Run project action", exact: true });
const notice = (page: Page) => page.locator('[data-nr-part="pane-notice"]');

/** Space "Main" has the folder `ACTIONS_CWD` and its file; "Other" has no folder. */
async function openApp(page: Page): Promise<void> {
  await seedSidebarState(page, { cwd: ACTIONS_CWD, secondSpace: true });
  await seedActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
}

const openUrl = (page: Page, url: string) =>
  page.evaluate((link) => (window as HookWindow).__norenTest?.openUrl(link), url);

/** Nothing ran: no short command, no text typed into a session, no dialog. */
async function expectNothingRan(page: Page, writesBefore: number): Promise<void> {
  expect(await page.evaluate(() => (window as HookWindow).__norenTest?.commandRuns())).toEqual([]);
  expect(await page.evaluate(() => (window as HookWindow).__norenTest?.writeCalls())).toBe(
    writesBefore,
  );
  await expect(confirm(page)).toHaveCount(0);
}

const writes = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.writeCalls() ?? 0);

test("open on the folder of an existing space focuses that space", async ({ page }) => {
  await openApp(page);
  await space(page, "Other").click();
  await expect(space(page, "Other")).toHaveAttribute("data-nr-state", "active");
  await expect(tab(page, "elsewhere")).toBeVisible();

  // Another spelling of the same folder: a trailing slash.
  await openUrl(page, `noren://open?path=${encodeURIComponent(`${ACTIONS_CWD}/`)}`);
  await expect(space(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await expect(tab(page, "api")).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Main|Other)$/ })).toHaveCount(2);
  await expect(notice(page)).toHaveText("");
});

test("open on a new folder makes a space there, named after the folder", async ({ page }) => {
  await openApp(page);
  await openUrl(page, "noren://open?path=/srv/new%20dir");
  await expect(space(page, "new dir")).toHaveAttribute("data-nr-state", "active");
  await expect(blockOf(page, "new dir")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts().map((s) => s.cwd)),
    )
    .toContain("/srv/new dir");

  // The same link again focuses it instead of making another.
  await space(page, "Main").click();
  await openUrl(page, "noren://open?path=/srv/new%20dir/");
  await expect(space(page, "new dir")).toHaveAttribute("data-nr-state", "active");
  await expect(space(page, "new dir")).toHaveCount(1);
});

test("a folder with a space and an accent opens a space with that exact folder", async ({
  page,
}) => {
  await openApp(page);
  const folder = "/home/joão/meus projetos";
  await openUrl(page, `noren://open?path=${encodeURIComponent(folder)}`);
  await expect(space(page, "meus projetos")).toHaveAttribute("data-nr-state", "active");
  await expect
    .poll(() =>
      page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts().map((s) => s.cwd)),
    )
    .toContain(folder);
});

test("action asks once, then runs the declared command and the header shows Stop", async ({
  page,
}) => {
  await openApp(page);
  await space(page, "Other").click();
  await expect(blockOf(page, "Other")).toHaveCount(0);

  await openUrl(page, `noren://action?path=${ACTIONS_CWD}&id=dev`);
  const dialog = confirm(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("pre")).toHaveText("pnpm dev");
  await expect(space(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await expect(tab(page, "dev")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(tab(page, "dev")).toBeVisible();
  // The link brought "Main" on screen; its block lists "Dev server" once it is opened.
  await header(page).getByRole("button", { name: "Main", exact: true }).click();
  await expect(button(page, "Stop Dev server in Main")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.lines().join("\n") ?? ""))
    .toContain("pnpm dev");

  // Confirmed once: the same link after a stop runs without asking.
  await button(page, "Stop Dev server in Main").click();
  await expect(button(page, "Start Dev server in Main")).toBeVisible();
  await openUrl(page, `noren://action?path=${ACTIONS_CWD}&id=dev`);
  await expect(button(page, "Stop Dev server in Main")).toBeVisible();
  await expect(confirm(page)).toHaveCount(0);
});

test("cancelling the question runs nothing", async ({ page }) => {
  await openApp(page);
  const before = await writes(page);
  await openUrl(page, `noren://action?path=${ACTIONS_CWD}&id=loop`);
  await confirm(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm(page)).toBeHidden();
  await expect(tab(page, "loop")).toHaveCount(0);
  await expectNothingRan(page, before);
});

test("action on a folder with no space makes the space, reads its file and asks", async ({
  page,
}) => {
  await openApp(page);
  await changeActionsFile(page, "/srv/fresh", ACTIONS_TEXT);
  await openUrl(page, "noren://action?path=/srv/fresh&id=loop");
  await expect(space(page, "fresh")).toHaveAttribute("data-nr-state", "active");
  const dialog = confirm(page);
  await expect(dialog.locator("pre")).toHaveText("loop\nloop parar");
  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect(button(page, "Stop Loop in fresh")).toBeVisible();
});

test("an id the file does not declare shows the notice and nothing runs", async ({ page }) => {
  await openApp(page);
  const before = await writes(page);
  await openUrl(page, `noren://action?path=${ACTIONS_CWD}&id=nope`);
  await expect(notice(page)).toContainText('There is no action "nope"');
  await expectNothingRan(page, before);
  await expect(tab(page, "nope")).toHaveCount(0);
});

test("a folder with no actions file shows the notice and makes no space", async ({ page }) => {
  await openApp(page);
  const before = await writes(page);
  await openUrl(page, "noren://action?path=/srv/empty&id=loop");
  await expect(notice(page)).toContainText("There is no .noren/actions.json in /srv/empty");
  await expect(space(page, "empty")).toHaveCount(0);
  await expectNothingRan(page, before);
});

test("an invalid actions file shows the reason and nothing runs", async ({ page }) => {
  await openApp(page);
  await changeActionsFile(page, "/srv/broken", '{ "actions": [ { "id": "a" } ] }');
  const before = await writes(page);
  await openUrl(page, "noren://action?path=/srv/broken&id=a");
  await expect(notice(page)).toContainText("is invalid");
  await expect(space(page, "broken")).toHaveCount(0);
  await expectNothingRan(page, before);
});

for (const url of [
  `noren://action?path=${ACTIONS_CWD}&id=dev&command=rm%20-rf%20%2F`,
  `noren://action?path=${ACTIONS_CWD}&command=pnpm%20dev`,
  `noren://open?path=${ACTIONS_CWD}&cmd=calc`,
  "noren://run?path=/srv/proj",
  "noren://open?path=/srv/../etc",
  "noren://open?path=relative",
]) {
  test(`${url} is refused with the notice and nothing runs`, async ({ page }) => {
    await openApp(page);
    const before = await writes(page);
    await openUrl(page, url);
    await expect(notice(page)).toContainText("Link refused");
    await expect(page.getByRole("button", { name: /^(Main|Other)$/ })).toHaveCount(2);
    await expect(space(page, "Main")).toHaveAttribute("data-nr-state", "active");
    await expectNothingRan(page, before);
  });
}

test("the entry point the desktop shell calls is on the window and takes the raw text", async ({
  page,
}) => {
  await openApp(page);
  await space(page, "Other").click();
  await page.evaluate(
    (link) => (window as HookWindow).__norenHandleDeepLink?.(link),
    `noren://open?path=${ACTIONS_CWD}`,
  );
  await expect(space(page, "Main")).toHaveAttribute("data-nr-state", "active");
  // Something that is not text is ignored, not a crash.
  await page.evaluate(() => (window as HookWindow).__norenHandleDeepLink?.(42));
  await expect(space(page, "Main")).toHaveAttribute("data-nr-state", "active");
});
