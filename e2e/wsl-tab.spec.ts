import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { seedGitRepos } from "./sidebar-fixture";
import { openCommandPalette } from "./palette-fixture";

// A tab of a WSL profile (NOR-F20-13). The shell inside the distro is the bash of the distro with the
// integration script, and what it writes reaches the window like any other shell's: the folder as
// Windows names it (`//wsl.localhost/<distro>/...` for the files of the distro, `D:/...` for a drive
// seen from inside, in the path of the file URI of OSC 7), the prompt marks and the command line
// (OSC 633;E, 133;C, 133;D). In web mode the page plays that shell: `sendOutput` writes what the
// script writes into the session of the tab, as it would arrive from `wsl.exe`. The process tree of
// Windows has nothing under `wsl.exe` (no `setPaneAgent` here), so the Agents panel can only know
// what runs from the line of the command.

const WEB_STATE_KEY = "noren.web.state";
const DISTRO_PROJ = "//wsl.localhost/Ubuntu/home/ada/proj";
const PROFILES = [
  { id: "fake", name: "Fake shell", default: true },
  { id: "wsl-Ubuntu", name: "WSL: Ubuntu", default: false },
];

interface Hook {
  focusedPaneId(): string | undefined;
  paneIds(): string[];
  sendOutput(paneId: string, text: string): boolean;
  sessionStarts(): { profileId?: string; cwd?: string }[];
}
type HookWindow = Window & { __norenTest?: Hook };

const ESC = "\u001b";
const BEL = "\u0007";
const osc = (body: string): string => `${ESC}]${body}${BEL}`;
/** The prompt `noren.bash` writes inside the distro: the folder, the start and the end of the prompt. */
const prompt = (path: string): string =>
  osc(`7;file://DESKTOP${path}`) + osc("133;A") + "ada@box:~$ " + osc("133;B");

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const tabs = (page: Page): Locator => list(page).locator('[data-nr-part="item"]');
/** The tab of the distro: the second one, opened from the palette. */
const wslTab = (page: Page): Locator => tabs(page).nth(1);
const titleOf = (page: Page): Locator => wslTab(page).locator('[data-nr-part="item-title"]');
const cwdOf = (page: Page): Locator => wslTab(page).locator('[data-nr-part="item-cwd"]');
const branchOf = (page: Page): Locator => wslTab(page).locator('[data-nr-part="item-branch"]');
const commandOf = (page: Page): Locator => wslTab(page).locator('[data-nr-part="item-command"]');
const commandPart = (page: Page, name: string): Locator =>
  commandOf(page).locator(`[data-nr-part="item-command-${name}"]`);

const panel = (page: Page): Locator => page.locator('[data-nr-part="agents"]');
const rows = (page: Page): Locator => panel(page).locator('[data-nr-part="agents-row"]');

const focusedPane = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const id = (window as HookWindow).__norenTest?.focusedPaneId();
    if (id === undefined) throw new Error("no pane has the keyboard");
    return id;
  });

/** Writes into the session of a pane what the shell inside the distro would write. */
async function speak(page: Page, paneId: string, text: string): Promise<void> {
  const written = await page.evaluate(
    ({ pane, output }) => (window as HookWindow).__norenTest?.sendOutput(pane, output) ?? false,
    { pane: paneId, output: text },
  );
  expect(written).toBe(true);
}

/** Opens the tab of the distro from the palette and returns the pane that holds the keyboard. */
async function openWslTab(page: Page): Promise<string> {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await openCommandPalette(page);
  const palette = page.locator('[data-nr-part="palette"]');
  await expect(palette).toBeVisible();
  await page.keyboard.type(">new wsl: ubuntu");
  const entry = palette.getByRole("option").filter({ hasText: "New WSL: Ubuntu tab" });
  await expect(entry).toHaveCount(1);
  await entry.click();
  await expect(palette).toBeHidden();
  await expect(tabs(page)).toHaveCount(2);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as HookWindow).__norenTest?.sessionStarts().map((s) => s.profileId),
      ),
    )
    .toContain("wsl-Ubuntu");
  return focusedPane(page);
}

interface SavedPane {
  profileId?: string;
  cwd?: string;
  gitBranch?: string;
}

/** The panes of the saved state, from the browser storage of web mode. */
function savedPanes(page: Page): Promise<SavedPane[]> {
  return page.evaluate((key) => {
    type Layout = { kind: "pane"; pane: SavedPane } | { kind: "split"; children: Layout[] };
    const flatten = (layout: Layout): SavedPane[] =>
      layout.kind === "pane" ? [layout.pane] : layout.children.flatMap(flatten);
    const text = window.localStorage.getItem(key) ?? "";
    if (text === "") return [];
    const state = JSON.parse(text) as { spaces: { items: Record<string, { layout: Layout }> }[] };
    return state.spaces.flatMap((space) =>
      Object.values(space.items).flatMap((item) => flatten(item.layout)),
    );
  }, WEB_STATE_KEY);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((profiles) => {
    window.localStorage.setItem("noren.web.profiles", JSON.stringify(profiles));
  }, PROFILES);
  await seedGitRepos(page, {
    [DISTRO_PROJ]: "main",
    "D:/Projetos/noren": "dev",
  });
});

test("the folder of a shell in the distro shows in the sidebar as the distro knows it, with its branch", async ({
  page,
}) => {
  const pane = await openWslTab(page);

  // The shell moves to its home folder in the distro: the tab is named after it.
  await speak(page, pane, prompt("/home/ada"));
  await expect(titleOf(page)).toHaveText("ada");

  // Into a repository of the distro: the folder (as Linux writes it) and the branch of it.
  await speak(page, pane, prompt(DISTRO_PROJ));
  await expect(titleOf(page)).toHaveText("proj");
  await expect(cwdOf(page)).toHaveText("\u2026/ada/proj");
  // The tooltip has the whole path, the one Windows opens.
  await expect(cwdOf(page)).toHaveAttribute("title", DISTRO_PROJ);
  await expect(branchOf(page)).toHaveText("main");

  // A folder below it is in the same repository.
  await speak(page, pane, prompt(`${DISTRO_PROJ}/src`));
  await expect(cwdOf(page)).toHaveText("\u2026/proj/src");
  await expect(branchOf(page)).toHaveText("main");

  // A folder on a drive, seen from inside as /mnt/d/..., is the drive folder, and has its branch.
  await speak(page, pane, prompt("/D:/Projetos/noren"));
  await expect(titleOf(page)).toHaveText("noren");
  await expect(cwdOf(page)).toHaveText("D:/Projetos/noren");
  await expect(cwdOf(page)).toHaveAttribute("title", "D:/Projetos/noren");
  await expect(branchOf(page)).toHaveText("dev");

  // The root of the distro, and a folder outside any repository: no branch.
  await speak(page, pane, prompt("//wsl.localhost/Ubuntu/"));
  await expect(cwdOf(page)).toHaveText("/");
  await expect(branchOf(page)).toHaveCount(0);
  await speak(page, pane, prompt("//wsl.localhost/Ubuntu/etc"));
  await expect(cwdOf(page)).toHaveText("/etc");
  await expect(branchOf(page)).toHaveCount(0);

  // A distro with a space in its name (the script writes it as %20).
  await speak(page, pane, prompt("//wsl.localhost/Ubuntu%2022.04/srv/api"));
  await expect(cwdOf(page)).toHaveText("/srv/api");
  await expect(titleOf(page)).toHaveText("api");
});

test("the command that runs in the distro shows in the sidebar, then the last one with its exit code", async ({
  page,
}) => {
  const pane = await openWslTab(page);
  await speak(page, pane, prompt(DISTRO_PROJ));
  await expect(branchOf(page)).toHaveText("main");

  // Nothing ran in the distro yet.
  await expect(commandOf(page)).toHaveCount(0);

  // What the script writes for a typed line: E (the line), C (it starts).
  await speak(page, pane, osc("633;E;npm run build") + osc("133;C"));
  await expect(commandOf(page)).toHaveAttribute("data-nr-state", "running");
  await expect(commandPart(page, "text")).toHaveText("npm run build");
  await expect(commandPart(page, "code")).toHaveText("running");
  await expect(wslTab(page).locator('[data-nr-indicator="running"]')).toHaveCount(1);
  await expect(titleOf(page)).toHaveText("proj \u00b7 npm");

  // D with the exit code, then the next prompt (which reads the branch again).
  await speak(page, pane, `built\r\n${osc("133;D;2")}${prompt(DISTRO_PROJ)}`);
  await expect(commandOf(page)).toHaveAttribute("data-nr-state", "failed");
  await expect(commandPart(page, "text")).toHaveText("npm run build");
  await expect(commandPart(page, "code")).toHaveText("exit 2");
  await expect(wslTab(page).locator('[data-nr-indicator="running"]')).toHaveCount(0);
  await expect(titleOf(page)).toHaveText("proj");
  await expect(branchOf(page)).toHaveText("main");
});

test("the Agents panel sees claude in the distro by its command alone, and loses it when the command ends", async ({
  page,
}) => {
  const pane = await openWslTab(page);
  await speak(page, pane, prompt(DISTRO_PROJ));
  await expect(branchOf(page)).toHaveText("main");

  await page.keyboard.press("Control+Shift+Alt+G");
  await expect(panel(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(0);

  // A command that is not an agent changes nothing.
  await speak(page, pane, osc("633;E;ls -la") + osc("133;C"));
  await expect(commandPart(page, "text")).toHaveText("ls -la");
  await expect(rows(page)).toHaveCount(0);
  await speak(page, pane, osc("133;D;0") + prompt(DISTRO_PROJ));

  // claude starts: nothing is under wsl.exe in the process tree, only the line says it runs.
  await speak(page, pane, osc("633;E;claude --continue") + osc("133;C"));
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().locator('[data-nr-part="agents-name"]')).toHaveText("claude");
  await expect(wslTab(page).locator('[data-nr-indicator="agent"]')).toHaveCount(1);
  await expect(titleOf(page)).toHaveText("proj \u00b7 claude");

  // Another agent of the catalog, started with a path and variables in front, is seen the same way.
  await speak(page, pane, `${osc("133;D;0")}${prompt(DISTRO_PROJ)}`);
  await expect(rows(page)).toHaveCount(0);
  await speak(page, pane, osc("633;E;CI=1 /usr/local/bin/codex exec fix") + osc("133;C"));
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().locator('[data-nr-part="agents-name"]')).toHaveText("codex");

  // The command ends: the agent is gone from the panel and from the tab.
  await speak(page, pane, `${osc("133;D;0")}${prompt(DISTRO_PROJ)}`);
  await expect(rows(page)).toHaveCount(0);
  await expect(wslTab(page).locator('[data-nr-indicator="agent"]')).toHaveCount(0);
});

test("a tab of the distro restored after a reload starts its shell in the folder it was last in", async ({
  page,
}) => {
  const pane = await openWslTab(page);
  await speak(page, pane, prompt("/home/ada"));
  await speak(page, pane, prompt(DISTRO_PROJ));
  await expect(branchOf(page)).toHaveText("main");
  // The folder and the branch are saved with the tab, in the profile of the distro.
  await expect
    .poll(async () => (await savedPanes(page)).find((saved) => saved.profileId === "wsl-Ubuntu"))
    .toMatchObject({ profileId: "wsl-Ubuntu", cwd: DISTRO_PROJ, gitBranch: "main" });

  await page.reload();
  await expect(tabs(page)).toHaveCount(2);
  // The session of the restored tab is asked for with the profile and the folder as they were
  // saved; the app machinery turns the folder into `wsl.exe --cd` (noren-core).
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts()))
    .toContainEqual({ profileId: "wsl-Ubuntu", cwd: DISTRO_PROJ });
  // The shell comes up in that folder (the fake shell reports the folder it was started in) and the
  // branch of it is read again.
  await expect(cwdOf(page)).toHaveText("\u2026/ada/proj");
  await expect(branchOf(page)).toHaveText("main");
  await expect(titleOf(page)).toHaveText("proj");
});

test("the window with a tab of the distro has no axe violation", async ({ page }) => {
  const pane = await openWslTab(page);
  await speak(page, pane, prompt(DISTRO_PROJ));
  await speak(page, pane, osc("633;E;claude") + osc("133;C"));
  await expect(branchOf(page)).toHaveText("main");
  await expect(commandOf(page)).toHaveAttribute("data-nr-state", "running");
  await expectNoAxeViolations(page, "the window with a tab of a WSL distro");
});
