import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SIDEBAR_REPOS, SPLIT_FIXTURE, seedGitRepos, seedSidebarState } from "./sidebar-fixture";

// The shell of a pane reports its folder (OSC 7) and its prompts (OSC 133); the app reads the git
// branch of that folder from `.git/HEAD` and shows both in the sidebar. In web mode the fake
// backend answers from the repositories seeded under `noren.web.git`.

const list = (page: Page) => page.getByRole("list", { name: "Tabs", exact: true });
// Without a name, the one tab of the page: the shell names a tab after its folder, so a test that
// moves around cannot look the tab up by its number.
const tab = (page: Page, name?: string) =>
  name === undefined
    ? list(page).locator('[data-nr-part="item"]')
    : list(page).getByRole("button", { name, exact: true });
const meta = (page: Page, name?: string) => tab(page, name).locator('[data-nr-part="item-meta"]');
const cwdOf = (page: Page, name?: string) => meta(page, name).locator('[data-nr-part="item-cwd"]');
const branchOf = (page: Page, name?: string) =>
  meta(page, name).locator('[data-nr-part="item-branch"]');

async function run(page: Page, line: string): Promise<void> {
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

interface SavedPane {
  id: string;
  cwd?: string;
  gitBranch?: string;
}

/** The panes of the saved state, from the browser storage of web mode. */
function savedPanes(page: Page): Promise<SavedPane[]> {
  return page.evaluate(() => {
    type Layout = { kind: "pane"; pane: SavedPane } | { kind: "split"; children: Layout[] };
    const flatten = (layout: Layout): SavedPane[] =>
      layout.kind === "pane" ? [layout.pane] : layout.children.flatMap(flatten);
    const text = window.localStorage.getItem("noren.web.state") ?? "";
    if (text === "") return [];
    const state = JSON.parse(text) as { spaces: { items: Record<string, { layout: Layout }> }[] };
    return state.spaces.flatMap((space) =>
      Object.values(space.items).flatMap((item) => flatten(item.layout)),
    );
  });
}

test("a cd into a repository shows the folder and the branch, and a cd out takes the branch away", async ({
  page,
}) => {
  await seedGitRepos(page, { "/proj": "main" });
  await page.goto("/");
  await expect(tab(page)).toBeVisible();
  // The folder the shell starts in is not one the tab went to: there is nothing to show yet.
  await expect(meta(page)).toHaveCount(0);

  await run(page, "cd /proj");
  await expect(cwdOf(page)).toHaveText("/proj");
  await expect(branchOf(page)).toHaveText("main");

  // A subfolder is in the same repository.
  await run(page, "cd src");
  await expect(cwdOf(page)).toHaveText("/proj/src");
  await expect(branchOf(page)).toHaveText("main");
  await expect(cwdOf(page)).toHaveAttribute("title", "/proj/src");

  // Out of the repository: the new folder, and no branch.
  await run(page, "cd /tmp");
  await expect(cwdOf(page)).toHaveText("/tmp");
  await expect(branchOf(page)).toHaveCount(0);

  // Back to the folder the shell started in: it is a place the tab went to now.
  await run(page, "cd ~");
  await expect(cwdOf(page)).toHaveText("~");
  await expect(branchOf(page)).toHaveCount(0);

  // The words read by assistive technology follow.
  await run(page, "cd /proj");
  await expect(branchOf(page)).toHaveText("main");
  const describedBy = await tab(page).getAttribute("aria-describedby");
  expect(describedBy).not.toBeNull();
  await expect(page.locator(`#${describedBy ?? ""}`)).toContainText("Folder /proj");
  await expect(page.locator(`#${describedBy ?? ""}`)).toContainText("Branch main");
});

test("a branch that changes under the shell shows at the next prompt, and a detached head shows the short commit", async ({
  page,
}) => {
  await seedGitRepos(page, { "/proj": "main" });
  await page.goto("/");
  await expect(tab(page)).toBeVisible();
  await run(page, "cd /proj");
  await expect(branchOf(page)).toHaveText("main");

  // Something outside the terminal (an editor, another shell) switches the branch.
  await page.evaluate(() =>
    window.localStorage.setItem("noren.web.git", JSON.stringify({ "/proj": "feature/x" })),
  );
  await expect(branchOf(page)).toHaveText("main");
  await run(page, "true");
  await expect(branchOf(page)).toHaveText("feature/x");

  await page.evaluate(() =>
    window.localStorage.setItem(
      "noren.web.git",
      JSON.stringify({ "/proj": { branch: "0123abc", detached: true } }),
    ),
  );
  await run(page, "false");
  await expect(branchOf(page)).toHaveText("0123abc");
});

test("the folder and branch are saved with the tab and are back after a reload", async ({
  page,
}) => {
  await seedGitRepos(page, { "/proj": "main" });
  await page.goto("/");
  await expect(tab(page)).toBeVisible();
  await run(page, "cd /proj");
  await expect(branchOf(page)).toHaveText("main");
  await expect.poll(() => savedPanes(page)).toMatchObject([{ cwd: "/proj", gitBranch: "main" }]);

  await page.reload();
  await expect(tab(page)).toBeVisible();
  // The new shell starts in /proj, and the branch is read again for it at its first prompt.
  await expect(cwdOf(page)).toHaveText("/proj");
  await expect(branchOf(page)).toHaveText("main");
});

test("each pane of a split tab follows its own shell", async ({ page }) => {
  // The branch of the second pane is not in the saved state: its shell finds it at the first prompt.
  await seedGitRepos(page, { ...SIDEBAR_REPOS, "/srv/web": "web-branch" });
  await seedSidebarState(page, { split: true });
  await page.goto("/");
  await expect(tab(page, SPLIT_FIXTURE.title)).toBeVisible();

  const pane = async (id: string) => (await savedPanes(page)).find((p) => p.id === id);
  await expect.poll(async () => (await pane(SPLIT_FIXTURE.second))?.gitBranch).toBe("web-branch");
  expect(await pane(SPLIT_FIXTURE.second)).toMatchObject({ cwd: "/srv/web" });
  // The first pane is in a folder that is no repository, and keeps its own folder.
  const first = await pane(SPLIT_FIXTURE.first);
  expect(first).toMatchObject({ cwd: "/srv/api" });
  expect(first).not.toHaveProperty("gitBranch");
});

test("a tab restored with a branch keeps it while its repository is there, and loses it when the repository is gone", async ({
  page,
}) => {
  await seedSidebarState(page);
  await page.goto("/");
  await expect(branchOf(page, "api")).toHaveText("main");
  await expect(branchOf(page, "deploy")).toHaveText("feature/long-branch-name");

  // The repository of "api" disappears; after a reload its fresh shell finds no branch to show.
  await page.evaluate(() =>
    window.localStorage.setItem(
      "noren.web.git",
      JSON.stringify({ "C:\\Users\\ada\\dev\\site": "feature/long-branch-name" }),
    ),
  );
  await page.reload();
  await expect(branchOf(page, "deploy")).toHaveText("feature/long-branch-name");
  await expect(branchOf(page, "api")).toHaveCount(0);
  await expect(cwdOf(page, "api")).toHaveText("~/projects/noren");
});
