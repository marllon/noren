import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { AGENT_STATES, LONG, THEME, start } from "./glass-sidebar-fixture";
import type { Mode, StartOptions } from "./glass-sidebar-fixture";
import { closeSettings, openSettings } from "./settings-fixture";
import { SPLIT_FIXTURE } from "./sidebar-fixture";

// The main window of the dense style (NOR-F20-21a), as in the approved design (`denso-janela`): the
// title bar with the brand, where you are and the button of the palette; the bar of the favorites and the
// project actions under it; the sidebar with the spaces as tabs, rows of one line, the agents and the
// settings; panes one pixel apart with a header of their own; and the status bar at the foot. What each
// part does is what it did: the specs of those run under the glass style (the default) and are not
// repeated here. The glass style does not change, and a test says so. Everything runs on the
// `FakeBackend` of web mode.

interface Hook {
  paneIds(): string[];
  focusedPaneId(): string | undefined;
  sendOutput(paneId: string, text: string): boolean;
}
type HookWindow = Window & { __norenTest?: Hook };

/** The folders of the two panes of the split tab of the fixture and their branches. */
const REPOS = { "/srv/api": "main", "/srv/web": "feat/login-form" };
const [FIRST, SECOND] = [SPLIT_FIXTURE.first, SPLIT_FIXTURE.second];

/** The shell tells the line (OSC 633 E) and that it starts (133 C), and later how it ended (133 D). */
const RUN = (line: string): string => `\x1b]633;E;${line}\x07\x1b]133;C\x07`;
const END = (code: number): string => `\x1b]133;D;${code}\x07`;

const side = (page: Page): Locator => page.locator('[data-nr-part="sidebar"]');
const toolbar = (page: Page): Locator => page.locator('[data-nr-part="dense-toolbar"]');
const status = (page: Page): Locator => page.locator('[data-nr-part="status-bar"]');
const crumbs = (page: Page): Locator => page.locator('[data-nr-part="titlebar-crumbs"]');
const frame = (page: Page, id: string): Locator => page.locator(`[data-pane-id="${id}"]`);
const bar = (page: Page, id: string): Locator =>
  frame(page, id).locator('[data-nr-part="pane-bar"]');
const part = (page: Page, id: string, name: string): Locator =>
  bar(page, id).locator(`[data-nr-part="${name}"]`);
const row = (page: Page, title: string): Locator =>
  side(page).getByRole("treeitem", { name: title, exact: true });
const tabs = (page: Page): Locator => page.getByRole("tree", { name: /^(Tabs|Abas)$/ });

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not on screen");
  return found;
};

/** One computed property of an element, or of its pseudo-element (`::after`). */
const style = (locator: Locator, property: string, pseudo?: string): Promise<string> =>
  locator.evaluate(
    (element, arg) => getComputedStyle(element, arg.pseudo ?? null).getPropertyValue(arg.property),
    { property, pseudo },
  );

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/** `#rrggbb` as the `rgb(r, g, b)` a computed style gives. */
function rgbOf(hexColor: string): string {
  const n = (from: number) => parseInt(hexColor.slice(from, from + 2), 16);
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
}

// The space "Main" of the fixture is blue.
const SPACE = rgbOf("#6b8afd");

type Options = Omit<StartOptions, "style" | "repos">;

/** The page as it starts under the dense style: the tab "api" of the group "Work", one pane. */
async function openDense(page: Page, options: Options = {}): Promise<void> {
  await start(page, { style: "dense", repos: REPOS, ...options });
  await expect(frame(page, "p2")).toBeVisible();
  await still(page);
}

/** Lets the animations that end end (the list of tabs slides in for 160 ms): what is measured next is at rest. */
async function still(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** The color a value of CSS (a variable, a mix) comes to in the page, as the computed style writes it. */
function colorOf(page: Page, value: string): Promise<string> {
  return page.evaluate((css) => {
    const probe = document.createElement("span");
    probe.style.color = css;
    document.body.append(probe);
    const found = getComputedStyle(probe).color;
    probe.remove();
    return found;
  }, value);
}

/** The same page with the split tab of the fixture on screen: `/srv/api` (focused) and `/srv/web`. */
async function openSplit(page: Page, options: Options = {}): Promise<void> {
  await openDense(page, options);
  await tabs(page).getByRole("treeitem", { name: SPLIT_FIXTURE.title, exact: true }).click();
  await expect(frame(page, SECOND)).toBeVisible();
  await expect(frame(page, FIRST)).toBeVisible();
}

const send = (page: Page, id: string, text: string): Promise<boolean> =>
  page.evaluate(({ pane, out }) => (window as HookWindow).__norenTest?.sendOutput(pane, out), {
    pane: id,
    out: text,
  }) as Promise<boolean>;

test.describe("the title bar", () => {
  test("is a strip of 32 px with the brand, where you are and the button of the palette, then the window buttons", async ({
    page,
  }) => {
    await openDense(page);
    const title = page.locator(".titlebar");
    expect((await box(title)).height).toBe(32);
    expect(await style(title, "border-bottom-width")).toBe("1px");
    const brand = title.getByRole("heading", { name: "Noren", exact: true });
    await expect(brand).toBeVisible();
    await expect(brand.locator("svg")).toHaveCount(1);
    expect(await style(brand, "text-transform")).toBe("uppercase");
    expect(await style(brand, "font-weight")).toBe("700");
    // The brand, then the breadcrumb, then (at the right) the palette button and the window buttons.
    const at = {
      brand: await box(brand),
      crumbs: await box(crumbs(page)),
      palette: await box(page.locator('[data-nr-part="titlebar-palette"]')),
      minimize: await box(title.getByRole("button", { name: "Minimize", exact: true })),
    };
    expect(at.crumbs.x).toBeGreaterThanOrEqual(at.brand.x + at.brand.width);
    expect(at.palette.x).toBeGreaterThan(at.crumbs.x + at.crumbs.width);
    expect(at.minimize.x).toBeGreaterThanOrEqual(at.palette.x + at.palette.width);
    expect(at.minimize.width).toBe(44);
    expect(at.palette.height).toBe(22);
  });

  test("says where you are: the space, the group and the tab, and follows the tab on screen", async ({
    page,
  }) => {
    await openDense(page);
    const items = crumbs(page).getByRole("listitem");
    await expect(items).toHaveText(["Main", "/Work", "/api"]);
    await expect(crumbs(page)).toHaveAccessibleName("Where you are");
    await expect(items.last()).toHaveAttribute("aria-current", "location");
    // The space in capitals, the tab in the text color, the rest muted.
    expect(await style(items.first(), "text-transform")).toBe("uppercase");
    const text = await rootVar(page, "--nr-text");
    expect(await style(items.last(), "color")).toBe(rgbOf(text));
    // A tab that is in no group has two: the space and the tab.
    await row(page, "deploy").click();
    await expect(items).toHaveText(["Main", "/deploy"]);
    // The title of a tab that was renamed.
    await row(page, "deploy").dblclick();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("shipping");
    await page.keyboard.press("Enter");
    await expect(items).toHaveText(["Main", "/shipping"]);
  });

  test("the button of the palette opens it, says its shortcut and names it", async ({ page }) => {
    await openDense(page);
    const button = page.locator('[data-nr-part="titlebar-palette"]');
    await expect(button).toHaveAccessibleName("commands");
    await expect(button).toHaveAttribute("aria-keyshortcuts", "Control+Shift+P");
    await expect(button.locator('[data-nr-part="keycap"]')).toHaveText("ctrl+⇧+p");
    await button.click();
    await expect(page.locator('[data-nr-part="palette"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-nr-part="palette"]')).toBeHidden();
  });

  test("has the settings button only when the sidebar is not docked (compact mode, top tabs)", async ({
    page,
  }) => {
    await openDense(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(1);
    await expect(
      page.locator(".titlebar").getByRole("button", { name: "Settings", exact: true }),
    ).toHaveCount(0);
  });

  test("in the language of the interface", async ({ page }) => {
    await openDense(page, { lang: "pt-BR" });
    await expect(crumbs(page)).toHaveAccessibleName("Onde você está");
    await expect(page.locator('[data-nr-part="titlebar-palette"]')).toHaveAccessibleName(
      "comandos",
    );
    await expect(status(page)).toHaveAccessibleName("Barra de status");
  });
});

test.describe("the bar of the favorites and the actions", () => {
  test("is under the title bar, the width of the window, with the favorites as chips of 22 px", async ({
    page,
  }) => {
    await openDense(page, { bar: true });
    const bar = toolbar(page);
    await expect(bar).toBeVisible();
    const at = await box(bar);
    const win = page.viewportSize();
    expect(at.x).toBe(0);
    expect(at.width).toBe(win?.width);
    expect(at.height).toBe(30);
    expect(await style(bar, "border-bottom-width")).toBe("1px");
    const title = await box(page.locator(".titlebar"));
    expect(at.y).toBe(title.y + title.height);
    // It is above the sidebar and the panes: they start where the bar ends.
    expect((await box(side(page))).y).toBeGreaterThanOrEqual(at.y + at.height);
    const chips = bar.locator('[data-nr-part="favorite"]');
    await expect(chips).toHaveCount(5);
    for (const chip of await chips.all()) expect((await box(chip)).height).toBe(22);
    await expect(bar.locator('[data-nr-part="favorite-label"]')).toHaveText([
      "scratch",
      "deploy",
      "PowerShell",
      "Dev server",
      "Loop",
    ]);
    // The project actions are not here: they are the Projects section of the sidebar.
    await expect(bar.getByRole("region", { name: "Projects", exact: true })).toHaveCount(0);
  });

  test("the chips are named by what they do, say their state with a square, and open what they did before", async ({
    page,
  }) => {
    await openDense(page, { bar: true, agents: AGENT_STATES });
    const chip = (name: string) => toolbar(page).getByRole("button", { name, exact: true });
    await expect(chip("PowerShell")).toHaveCount(0);
    await expect(chip("New tab with PowerShell")).toHaveCount(0);
    // The tab "deploy" has an agent that waits (amber square), "scratch" one that works (green).
    const dot = (name: string) => chip(name).locator('[data-nr-part="favorite-dot"]');
    await expect(dot("deploy")).toHaveAttribute("data-nr-dot", "waiting");
    await expect(dot("scratch")).toHaveAttribute("data-nr-dot", "running");
    expect(await style(dot("deploy"), "background-color")).toBe(
      rgbOf(await rootVar(page, "--nr-state-waiting")),
    );
    expect(await style(dot("scratch"), "background-color")).toBe(
      rgbOf(await rootVar(page, "--nr-state-running")),
    );
    const size = await box(dot("deploy"));
    expect(size.width).toBeCloseTo(6, 1);
    expect(size.height).toBeCloseTo(6, 1);
    expect(await style(dot("deploy"), "border-top-left-radius")).toBe("0px");
    // The dot is before the name.
    expect((await box(dot("deploy"))).x).toBeLessThan(
      (await box(chip("deploy").locator('[data-nr-part="favorite-label"]'))).x,
    );
    // A click shows the tab, as it did.
    await chip("deploy").click();
    await expect(row(page, "deploy")).toHaveAttribute("aria-current", "true");
    await expect(chip("deploy")).toHaveAttribute("aria-current", "true");
    expect(await style(chip("deploy"), "border-top-color")).toBe(
      rgbOf(await rootVar(page, "--nr-space-color")),
    );
  });

  test("with no favorite it says how to add one, in one line", async ({ page }) => {
    await openDense(page);
    const hint = toolbar(page).locator('[data-nr-part="favorites-hint"]');
    await expect(hint).toBeVisible();
    expect(await style(hint, "border-top-style")).toBe("dashed");
    expect((await box(hint)).height).toBe(22);
    expect(await style(hint, "text-overflow")).toBe("ellipsis");
    expect(await style(hint, "white-space")).toBe("nowrap");
  });

  test("has the project actions in the sidebar, not in the bar, with a start button of the style", async ({
    page,
  }) => {
    await openDense(page);
    await expect(toolbar(page).getByRole("button", { name: /^Start Loop/ })).toHaveCount(0);
    const projects = side(page).locator('[data-nr-part="projects"]');
    const loop = projects.getByRole("button", { name: /^Start Loop in / });
    await expect(loop).toBeVisible();
    // The mark is a filled triangle: a start; the border is the one of the style.
    expect(await style(loop.locator("svg"), "fill")).not.toBe("none");
    expect(await style(loop, "border-top-width")).toBe("1px");
    expect(await style(loop, "border-top-left-radius")).toBe("3px");
    await expect(projects.locator(".projects-title")).toHaveText("Projects");
  });

  test("a space with no actions file has no Projects section, and the tiles of its actions are kept, dimmed", async ({
    page,
  }) => {
    await openDense(page, { bar: true, actions: false });
    await expect(page.locator('[data-nr-part="projects"]')).toHaveCount(0);
    await expect(toolbar(page).locator('[data-nr-part="favorite"]')).toHaveCount(5);
    const gone = toolbar(page).locator('[data-nr-part="favorite"][data-nr-state="unavailable"]');
    await expect(gone).toHaveCount(2);
    expect(await style(gone.first(), "opacity")).toBe("0.4");
  });

  test("wraps in a narrow window and nothing leaves it", async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 600 });
    await openDense(page, { bar: true });
    const at = await box(toolbar(page));
    expect(at.height).toBeGreaterThan(30);
    expect(at.width).toBe(520);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  });

  test("the setting of the place of the favorites is for the glass style: under dense they are always here", async ({
    page,
  }) => {
    await openDense(page, { bar: true, appearance: '"favorites": "top"' });
    await expect(toolbar(page).locator('[data-nr-part="favorite"]')).toHaveCount(5);
    await expect(page.locator('[data-nr-part="favorites"]')).toHaveCount(1);
  });
});

test.describe("the sidebar", () => {
  test("has the spaces as tabs along its top, the active one with a line of the color of the space under it", async ({
    page,
  }) => {
    await openDense(page, { secondSpace: true });
    const spaces = side(page).locator('[data-nr-part="space-switcher"]');
    const at = await box(spaces);
    expect(at.height).toBe(30);
    expect(Math.abs(at.y - (await box(side(page))).y)).toBeLessThanOrEqual(1);
    const main = spaces.getByRole("button", { name: "Main", exact: true });
    const other = spaces.getByRole("button", { name: "Other", exact: true });
    await expect(main).toHaveAttribute("aria-current", "true");
    await expect(main.locator(".space-label")).toHaveText("Main");
    expect(await style(main.locator(".space-label"), "text-transform")).toBe("uppercase");
    expect(await style(main, "border-bottom-width")).toBe("2px");
    expect(await style(main, "border-bottom-color")).toBe(SPACE);
    expect(await style(other, "border-bottom-color")).toBe("rgba(0, 0, 0, 0)");
    // The square before the name is the color of the space.
    expect(await style(main.locator(".space-swatch"), "background-color")).toBe(SPACE);
    expect(await style(other.locator(".space-swatch"), "background-color")).toBe(rgbOf("#e0a458"));
    // Both are at the same height, side by side.
    expect(Math.abs((await box(main)).y - (await box(other)).y)).toBeLessThan(1);
    expect((await box(other)).x).toBeGreaterThan((await box(main)).x);
    // A click switches, as before; the rest of the window follows (the status bar says the space).
    await other.click();
    await expect(other).toHaveAttribute("aria-current", "true");
    await expect(status(page).locator('[data-nr-part="status-space"]')).toHaveText("Other");
    expect(
      await style(status(page).locator('[data-nr-part="status-space"]'), "background-color"),
    ).toBe(rgbOf("#e0a458"));
    await expect(crumbs(page).getByRole("listitem").first()).toHaveText("Other");
  });

  test("keeps the buttons of a new space and of the options of the space, in the row of tabs", async ({
    page,
  }) => {
    await openDense(page);
    const spaces = side(page).locator('[data-nr-part="space-switcher"]');
    const add = spaces.getByRole("button", { name: "New space", exact: true });
    const more = spaces.getByRole("button", { name: "Space options", exact: true });
    await expect(add).toBeVisible();
    await expect(more).toBeVisible();
    expect((await box(add)).width).toBe(28);
    await more.click();
    await expect(page.getByRole("menu")).toBeVisible();
  });

  test("the tree is rows of 24 px: a square state at the start, the title, the branch at the end", async ({
    page,
  }) => {
    await openDense(page, { agents: AGENT_STATES });
    for (const title of ["notes", "api", "build", "deploy", "servers", "scratch"]) {
      const target = row(page, title);
      expect((await box(target)).height, title).toBe(24);
      expect(await style(target, "border-top-left-radius")).toBe("0px");
      const dot = target.locator('[data-nr-part="item-dot"]');
      const small = await box(dot);
      expect(small.width, title).toBeCloseTo(6, 1);
      expect(small.height, title).toBeCloseTo(6, 1);
    }
    // The branch is at the right end of its row, muted, without its icon.
    const api = row(page, "api");
    const branch = api.locator('[data-nr-part="item-branch"]');
    await expect(branch).toHaveText("main");
    expect((await box(branch)).x).toBeGreaterThan((await box(api)).x + (await box(api)).width / 2);
    // Running or working is green, waiting amber, rest a hollow square.
    const dotOf = (title: string) => row(page, title).locator('[data-nr-part="item-dot"]');
    expect(await style(dotOf("api"), "background-color")).toBe(
      rgbOf(await rootVar(page, "--nr-state-running")),
    );
    expect(await style(dotOf("deploy"), "background-color")).toBe(
      rgbOf(await rootVar(page, "--nr-state-waiting")),
    );
    expect(await style(dotOf("build"), "background-color")).toBe("rgba(0, 0, 0, 0)");
    expect(await style(dotOf("build"), "border-top-width")).toBe("1px");
  });

  test("a tab whose agent waits says so in a word, in place of the branch", async ({ page }) => {
    await openDense(page, { agents: AGENT_STATES });
    const deploy = row(page, "deploy");
    await expect(deploy.locator('[data-nr-part="item-waiting"]')).toHaveText("waiting");
    await expect(deploy.locator('[data-nr-part="item-branch"]')).toBeHidden();
    // The other tabs have no such word and keep their branch.
    await expect(row(page, "scratch").locator('[data-nr-part="item-waiting"]')).toHaveCount(0);
    await expect(row(page, "api").locator('[data-nr-part="item-branch"]')).toBeVisible();
  });

  test("the chevron of a split tab has a place of its own at the end of the row: it covers neither the branch nor the word that says an agent waits", async ({
    page,
  }) => {
    await openDense(page, { agents: [[SECOND, "shall i continue"]] });
    const servers = row(page, SPLIT_FIXTURE.title);
    const toggle = side(page).locator('[data-nr-part="item-panes-toggle"]').first();
    await expect(servers.locator('[data-nr-part="item-waiting"]')).toBeVisible();
    const wait = await box(servers.locator('[data-nr-part="item-waiting"]'));
    const chevron = await box(toggle);
    const at = await box(servers);
    expect(wait.x + wait.width).toBeLessThanOrEqual(chevron.x + 0.5);
    expect(chevron.x + chevron.width).toBeLessThanOrEqual(at.x + at.width + 0.5);
    expect(chevron.y).toBeGreaterThanOrEqual(at.y);
    expect(chevron.y + chevron.height).toBeLessThanOrEqual(at.y + at.height + 0.5);
  });

  test("the active tab is a row tinted with the highlight, and the one the pointer is on is lighter", async ({
    page,
  }) => {
    await openDense(page);
    const active = row(page, "api");
    await expect(active).toHaveAttribute("aria-current", "true");
    const tint = await style(active, "background-color");
    expect(tint).not.toBe("rgba(0, 0, 0, 0)");
    // A tab that is not active has no tint until the pointer is on it.
    const other = row(page, "build");
    expect(await style(other, "background-color")).toBe("rgba(0, 0, 0, 0)");
    await other.hover();
    expect(await style(other, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("a group is a quiet row with its count at the right end", async ({ page }) => {
    await openDense(page);
    const group = side(page).locator('[data-nr-part="group"]').first();
    expect((await box(group)).height).toBe(24);
    await expect(group.locator('[data-nr-part="group-count"]')).toHaveText("3");
    const at = await box(group);
    const count = await box(group.locator('[data-nr-part="group-count"]'));
    expect(at.x + at.width - (count.x + count.width)).toBeLessThanOrEqual(12);
  });

  test("New tab is a row with a plus, its word and its shortcut at the end, right under the tree", async ({
    page,
  }) => {
    await openDense(page);
    const newTab = side(page).getByRole("button", { name: "New tab", exact: true });
    await expect(newTab.locator("svg")).toHaveCount(1);
    await expect(newTab.locator(".keycap")).toHaveText("ctrl+⇧+t");
    expect((await box(newTab)).height).toBe(24);
    const before = await side(page).locator('[data-nr-part="item"]').count();
    await newTab.click();
    await expect(side(page).locator('[data-nr-part="item"]')).toHaveCount(before + 1);
  });

  test("lists the agents of every space at the foot, the one that waits first, and a click goes to it", async ({
    page,
  }) => {
    await openDense(page, { agents: AGENT_STATES });
    const agents = side(page).locator('[data-nr-part="sidebar-agents"]');
    await expect(agents).toBeVisible();
    await expect(agents).toHaveAccessibleName("Agents");
    const rows = agents.locator('[data-nr-part="sidebar-agent"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toHaveAttribute("data-nr-agent-state", "waiting");
    await expect(rows.first().locator(".sidebar-agent-name")).toHaveText("helper");
    await expect(rows.first().locator(".sidebar-agent-state")).toContainText("waiting");
    await expect(rows.first()).toHaveAccessibleName(
      /^helper waiting \S+, deploy in Main\. Go to it\.$/,
    );
    expect(await style(rows.first().locator(".sidebar-agent-state"), "color")).not.toBe(
      await style(rows.last().locator(".sidebar-agent-state"), "color"),
    );
    // It is at the foot of the sidebar, over the settings row.
    const settings = side(page).locator('[data-nr-part="sidebar-settings"]');
    const at = await box(agents);
    expect(at.y + at.height).toBeLessThanOrEqual((await box(settings)).y + 1);
    await rows.first().click();
    await expect(row(page, "deploy")).toHaveAttribute("aria-current", "true");
  });

  test("has no agents section while no agent runs", async ({ page }) => {
    await openDense(page);
    await expect(side(page).locator('[data-nr-part="sidebar-agents"]')).toHaveCount(0);
  });

  test("the settings are the last row, with a line over it, and open the settings", async ({
    page,
  }) => {
    await openDense(page);
    const settings = side(page).getByRole("button", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    await expect(settings).toHaveText("settings");
    expect((await box(settings)).height).toBe(28);
    expect(await style(settings, "border-top-width")).toBe("1px");
    const sidebar = await box(side(page));
    const at = await box(settings);
    expect(Math.abs(sidebar.y + sidebar.height - (at.y + at.height))).toBeLessThanOrEqual(1);
    await settings.click();
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  });

  test("nothing of the glass sidebar is drawn", async ({ page }) => {
    await openDense(page, { bar: true });
    for (const name of ["sidebar-head", "sidebar-search", "sidebar-base", "sidebar-brand"]) {
      await expect(page.locator(`[data-nr-part="${name}"]`)).toHaveCount(0);
    }
    await expect(page.locator('[data-nr-part="space-header"]')).toHaveCount(0);
  });
});

test.describe("the sidebar cuts what does not fit inside its own box", () => {
  /** What nothing in the sidebar may do: leave it, or have a row wider than it. */
  async function expectNothingLeaves(page: Page, label: string): Promise<void> {
    const report = await side(page).evaluate((aside) => {
      const edge = aside.getBoundingClientRect();
      const outside: string[] = [];
      for (const element of aside.querySelectorAll("*")) {
        if (element.closest(".sr-only, [hidden], .sidebar-resize, .drop-zones") !== null) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > edge.right + 0.5 || rect.left < edge.left - 0.5) {
          outside.push(`${element.className || element.tagName} ${rect.left}-${rect.right}`);
        }
      }
      const wide: string[] = [];
      for (const element of aside.querySelectorAll<HTMLElement>(
        ".tab-button, .group-button, .item-pane, .new-tab, .sidebar-settings, .sidebar-agent, .space-button, .space-switcher",
      )) {
        if (element.scrollWidth - element.clientWidth > 1) {
          wide.push(`${element.className} ${element.scrollWidth - element.clientWidth}`);
        }
      }
      // The list of tabs, the one box of the sidebar that scrolls, does not scroll sideways.
      const list = aside.querySelector<HTMLElement>(".tab-list");
      return { outside, wide, sidebar: list === null ? 0 : list.scrollWidth - list.clientWidth };
    });
    expect(report.outside, `${label}: leaves the sidebar`).toEqual([]);
    expect(report.wide, `${label}: wider than its row`).toEqual([]);
    expect(report.sidebar, `${label}: the list of tabs scrolls sideways`).toBeLessThanOrEqual(0);
  }

  for (const width of [180, 200, 264, 320, 480]) {
    test(`at ${width} px, with the names far too long, none is cut by the edge`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openDense(page, {
        longNames: true,
        agents: AGENT_STATES,
        appearance: `"sidebar": { "width": ${width} }`,
      });
      await expectNothingLeaves(page, `${width}px`);
      // The title of the tab is cut by an ellipsis in its own box, and the row keeps its height.
      const title = row(page, LONG.title).locator('[data-nr-part="item-title"]');
      expect(await style(title, "text-overflow")).toBe("ellipsis");
      expect(await title.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      expect((await box(row(page, LONG.title))).height).toBe(24);
      // So is the name of the space in its tab.
      const label = side(page).locator(".space-label").first();
      expect(await style(label, "text-overflow")).toBe("ellipsis");
    });
  }

  test("at 200 px the tabs of the fixture show whole: the title and the branch of a row do not overlap", async ({
    page,
  }) => {
    await openDense(page, { agents: AGENT_STATES });
    for (const title of ["api", "deploy", "servers", "scratch"]) {
      const target = row(page, title);
      const name = await box(target.locator('[data-nr-part="item-title"]'));
      const rest = target.locator('[data-nr-part="item-branch"], [data-nr-part="item-waiting"]');
      if ((await rest.count()) > 0 && (await rest.first().isVisible())) {
        expect(name.x + name.width, title).toBeLessThanOrEqual((await box(rest.first())).x + 0.5);
      }
      expect(
        await target
          .locator('[data-nr-part="item-title"]')
          .evaluate((node) => node.scrollWidth > node.clientWidth),
        `${title} is cut`,
      ).toBe(false);
    }
  });

  test("in Portuguese too", async ({ page }) => {
    await openDense(page, { lang: "pt-BR", longNames: true, agents: AGENT_STATES });
    await expectNothingLeaves(page, "pt-BR");
  });
});

test.describe("the panes", () => {
  test("are one pixel apart, with square corners, and the line between two is a line of the style", async ({
    page,
  }) => {
    await openSplit(page);
    const [a, b] = await Promise.all([box(frame(page, FIRST)), box(frame(page, SECOND))]);
    expect(b.x - (a.x + a.width)).toBe(1);
    expect(await style(frame(page, FIRST), "border-top-left-radius")).toBe("0px");
    const separator = page.locator(".split-separator").first();
    expect((await box(separator)).width).toBe(1);
    expect(await style(side(page), "border-top-left-radius")).toBe("0px");
  });

  test("the one in focus has a ring of the highlight, the color of the space", async ({ page }) => {
    await openSplit(page);
    expect(await style(frame(page, FIRST), "border-top-color", "::after")).toBe(SPACE);
    await frame(page, SECOND).click();
    await expect(frame(page, SECOND)).toHaveAttribute("data-nr-focused", "true");
    expect(await style(frame(page, SECOND), "border-top-color", "::after")).toBe(SPACE);
    expect(await style(frame(page, FIRST), "border-top-width", "::after")).toBe("0px");
  });

  test("have a header of 24 px with the number of the pane, what runs and its folder", async ({
    page,
  }) => {
    await openSplit(page);
    for (const [id, n, folder] of [
      [FIRST, "1", "/srv/api"],
      [SECOND, "2", "/srv/web"],
    ] as const) {
      expect((await box(bar(page, id))).height).toBe(24);
      await expect(part(page, id, "pane-number")).toHaveText(n);
      await expect(part(page, id, "pane-folder")).toHaveText(folder);
      await expect(part(page, id, "pane-folder")).toHaveAttribute("title", folder);
      // With no command the shell is a Terminal.
      await expect(part(page, id, "pane-command")).toContainText("Terminal");
      // The terminal starts under the header.
      const strip = await box(bar(page, id));
      const terminal = await box(frame(page, id).locator(".terminal-view"));
      expect(terminal.y).toBeGreaterThanOrEqual(strip.y + strip.height - 0.5);
    }
    // The number of the focused pane is lit with the highlight (pulled toward the text), the other is muted.
    expect(await style(part(page, FIRST, "pane-number"), "color")).not.toBe(
      await style(part(page, SECOND, "pane-number"), "color"),
    );
  });

  test("say the command that runs with a green dot and 'running', and how a failed one ended", async ({
    page,
  }) => {
    await openSplit(page);
    await send(page, FIRST, RUN("pnpm dev"));
    await expect(part(page, FIRST, "pane-command")).toContainText("pnpm dev");
    await expect(part(page, FIRST, "pane-command")).toHaveAttribute("data-nr-state", "running");
    const state = part(page, FIRST, "pane-state");
    await expect(state).toHaveText("running");
    await expect(state).toHaveAttribute("data-nr-state", "running");
    expect(await style(state, "color")).not.toBe(
      await style(part(page, FIRST, "pane-folder"), "color"),
    );
    // The words are for assistive technology.
    await expect(part(page, FIRST, "pane-command").locator(".sr-only")).toHaveText(
      "Running pnpm dev",
    );
    await send(page, FIRST, END(0));
    await expect(part(page, FIRST, "pane-command")).toHaveAttribute("data-nr-state", "done");
    await expect(part(page, FIRST, "pane-state")).toHaveCount(0);
    await send(page, SECOND, RUN("make"));
    await send(page, SECOND, END(2));
    await expect(part(page, SECOND, "pane-state")).toHaveText("exit 2");
    await expect(part(page, SECOND, "pane-state")).toHaveAttribute("data-nr-state", "failed");
    expect((await box(bar(page, SECOND))).height).toBe(24);
  });

  test("an agent that waits tints the header in amber and says so, and the pane has an amber ring", async ({
    page,
  }) => {
    await openSplit(page, { agents: [[SECOND, "shall i continue"]] });
    const badge = part(page, SECOND, "pane-agent-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("Agent waiting for you");
    await expect(part(page, FIRST, "pane-agent-badge")).toHaveCount(0);
    const tinted = await style(bar(page, SECOND), "background-color");
    expect(tinted).not.toBe(await style(bar(page, FIRST), "background-color"));
    await expect(frame(page, SECOND)).toHaveAttribute("data-nr-agent-state", "waiting");
    expect(await style(frame(page, SECOND).locator(".pane-agent-ring"), "border-top-color")).toBe(
      rgbOf(await rootVar(page, "--nr-state-waiting")),
    );
  });

  test("the buttons are at the right end, always in sight, and split, zoom and close", async ({
    page,
  }) => {
    await openSplit(page);
    await page.mouse.move(2, 2);
    const button = (id: string, name: string) =>
      frame(page, id).getByRole("button", { name, exact: true });
    for (const id of [FIRST, SECOND]) {
      for (const name of ["Split right", "Split down", "Zoom pane", "Close pane"]) {
        await expect(button(id, name), `${name} of ${id}`).toBeVisible();
      }
      const at = await box(button(id, "Split right"));
      expect([at.width, at.height]).toEqual([22, 20]);
    }
    await expect(button(FIRST, "Split right")).toHaveAttribute("title", /^Split right \(Ctrl\+/);
    // Zoom shows only that pane; the button says Restore.
    await button(FIRST, "Zoom pane").click();
    await expect(button(FIRST, "Restore pane")).toBeVisible();
    await expect(frame(page, SECOND)).toBeHidden();
    await button(FIRST, "Restore pane").click();
    await expect(frame(page, SECOND)).toBeVisible();
    // Split down adds a pane under this one.
    await button(SECOND, "Split down").click();
    await expect(page.locator('[data-nr-part="pane"]:visible')).toHaveCount(3);
    // Close takes the pane away, and the tab stays.
    const ids = await page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
    const extra = ids.find((id) => id !== FIRST && id !== SECOND);
    if (extra === undefined) throw new Error("no new pane");
    await button(extra, "Close pane").click();
    await expect(page.locator('[data-nr-part="pane"]:visible')).toHaveCount(2);
    await expect(row(page, SPLIT_FIXTURE.title)).toBeVisible();
  });

  test("a tab of one pane has the header too, with no zoom and no close (closing it would close the tab)", async ({
    page,
  }) => {
    await openDense(page);
    await expect(bar(page, "p2")).toHaveCount(1);
    await expect(part(page, "p2", "pane-number")).toHaveText("1");
    await expect(part(page, "p2", "pane-folder")).toHaveText("~/projects/noren");
    await expect(frame(page, "p2").getByRole("button", { name: "Zoom pane" })).toHaveCount(0);
    await expect(frame(page, "p2").getByRole("button", { name: "Close pane" })).toHaveCount(0);
    await expect(frame(page, "p2").getByRole("button", { name: "Split right" })).toBeVisible();
  });

  test("a narrow pane gives up its folder, then its state, then everything but the buttons", async ({
    page,
  }) => {
    await openSplit(page);
    await send(page, FIRST, RUN("pnpm dev"));
    await expect(part(page, FIRST, "pane-state")).toBeVisible();
    // The two panes share what the sidebar (200 px) leaves: about 400 px each at 1000 px of window.
    const nothingLeaves = async () => {
      for (const id of [FIRST, SECOND]) {
        const strip = await box(bar(page, id));
        const pane = await box(frame(page, id));
        expect(strip.x + strip.width).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
        expect(
          await bar(page, id).evaluate((node) => node.scrollWidth - node.clientWidth),
        ).toBeLessThanOrEqual(0);
      }
    };
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect(part(page, FIRST, "pane-folder")).toBeVisible();
    await expect(part(page, FIRST, "pane-state")).toBeVisible();
    await nothingLeaves();
    // About 290 px: the folder is the first to go.
    await page.setViewportSize({ width: 780, height: 700 });
    await expect(part(page, FIRST, "pane-folder")).toBeHidden();
    await expect(part(page, FIRST, "pane-state")).toBeVisible();
    await nothingLeaves();
    // About 225 px: the state goes too; the number, the command and the buttons stay.
    await page.setViewportSize({ width: 650, height: 700 });
    await expect(part(page, FIRST, "pane-state")).toBeHidden();
    await expect(part(page, FIRST, "pane-number")).toBeVisible();
    await expect(part(page, FIRST, "pane-command")).toBeVisible();
    await nothingLeaves();
    // About 140 px: only the buttons, with Zoom and Close still there.
    await page.setViewportSize({ width: 480, height: 700 });
    await expect(part(page, FIRST, "pane-number")).toBeHidden();
    await expect(
      frame(page, FIRST).getByRole("button", { name: "Close pane", exact: true }),
    ).toBeVisible();
    await expect(
      frame(page, FIRST).getByRole("button", { name: "Split right", exact: true }),
    ).toBeVisible();
    await nothingLeaves();
  });

  test("a folder, a command far too long are cut inside the header, which keeps its height", async ({
    page,
  }) => {
    await openSplit(page, { longPane: true });
    await send(page, FIRST, RUN(`pnpm ${"very-long-command-".repeat(8)}end`));
    await expect(part(page, FIRST, "pane-command")).toContainText("pnpm very-long-command");
    expect((await box(bar(page, FIRST))).height).toBe(24);
    const strip = await box(bar(page, FIRST));
    const buttons = await box(part(page, FIRST, "pane-bar-actions"));
    expect(buttons.x + buttons.width).toBeLessThanOrEqual(strip.x + strip.width + 0.5);
    const title = part(page, FIRST, "pane-command");
    expect(await style(title, "text-overflow")).toBe("ellipsis");
  });
});

test.describe("the status bar", () => {
  test("is a strip at the foot of the window, the width of it, with the space in its color first", async ({
    page,
  }) => {
    await openDense(page);
    const at = await box(status(page));
    const win = page.viewportSize();
    expect(at.x).toBe(0);
    expect(at.width).toBe(win?.width);
    expect(at.y + at.height).toBe(win?.height);
    expect(at.height).toBeGreaterThanOrEqual(24);
    expect(at.height).toBeLessThanOrEqual(25);
    expect(await style(status(page), "border-top-width")).toBe("1px");
    const space = status(page).locator('[data-nr-part="status-space"]');
    await expect(space).toHaveText("Main");
    expect(await style(space, "background-color")).toBe(SPACE);
    expect(await style(space, "text-transform")).toBe("uppercase");
    expect(await style(space, "font-weight")).toBe("700");
    expect(await style(space, "color")).toBe(rgbOf(await rootVar(page, "--nr-on-highlight")));
    // The panes and the sidebar end where the bar starts.
    expect((await box(side(page))).y + (await box(side(page))).height).toBeLessThanOrEqual(at.y);
  });

  test("says the folder and the branch of the pane in focus, and the number of panes of the tab", async ({
    page,
  }) => {
    await openDense(page);
    await expect(status(page).locator('[data-nr-part="status-folder"]')).toHaveText(
      "~/projects/noren",
    );
    await expect(status(page).locator('[data-nr-part="status-branch"]')).toHaveText("main");
    await expect(status(page).locator('[data-nr-part="status-panes"]')).toHaveText("1 pane");
    await expect(status(page).locator('[data-nr-part="status-agents"]')).toHaveCount(0);
    // The tab with two panes, the first in focus; then the second.
    await row(page, SPLIT_FIXTURE.title).click();
    await expect(status(page).locator('[data-nr-part="status-folder"]')).toHaveText("/srv/api");
    await expect(status(page).locator('[data-nr-part="status-branch"]')).toHaveText("main");
    await expect(status(page).locator('[data-nr-part="status-panes"]')).toHaveText("2 panes");
    await frame(page, SECOND).click();
    await expect(status(page).locator('[data-nr-part="status-folder"]')).toHaveText("/srv/web");
    await expect(status(page).locator('[data-nr-part="status-branch"]')).toHaveText(
      "feat/login-form",
    );
    // A pane that gets another folder is followed.
    await send(page, SECOND, "\x1b]7;file://localhost/srv/elsewhere\x07");
    await expect(status(page).locator('[data-nr-part="status-folder"]')).toHaveText(
      "/srv/elsewhere",
    );
  });

  test("a tab with no git folder has no branch cell", async ({ page }) => {
    await openDense(page);
    await row(page, "scratch").click();
    await expect(status(page).locator('[data-nr-part="status-branch"]')).toHaveCount(0);
  });

  test("counts the agents that wait for you, in amber, and says nothing when none does", async ({
    page,
  }) => {
    await openDense(page, { agents: AGENT_STATES });
    const agents = status(page).locator('[data-nr-part="status-agents"]');
    await expect(agents).toHaveText(/1 agent waiting/);
    expect(await style(agents, "color")).toBe(await colorOf(page, "var(--nr-waiting-text)"));
    await send(page, "p6", "shall i continue\r\n");
    await expect(agents).toHaveText(/2 agents waiting/);
  });

  test("never has what the app does not know: no load of the machine, no clock, no version of a runtime", async ({
    page,
  }) => {
    await openDense(page, { agents: AGENT_STATES });
    const text = (await status(page).innerText()).toLowerCase();
    for (const word of ["cpu", "mem", "node"]) expect(text).not.toContain(word);
    expect(text).not.toMatch(/\b\d{1,2}:\d{2}\b/);
  });

  test("wraps in a narrow window, and nothing leaves it", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 600 });
    await openDense(page, { agents: AGENT_STATES });
    await expect(status(page)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
    const at = await box(status(page));
    expect(at.x + at.width).toBeLessThanOrEqual(420);
  });
});

test.describe("the other ways of laying the window out", () => {
  test("with the tabs on top: the bar of tabs of 30 px, no sidebar, the settings in the title bar, and the status bar at the foot", async ({
    page,
  }) => {
    await openDense(page, { bar: true, appearance: '"tabs": "top"' });
    const tabBar = page.locator(".tab-bar");
    await expect(tabBar).toBeVisible();
    expect((await box(tabBar)).height).toBe(31);
    expect(await style(tabBar, "border-bottom-width")).toBe("1px");
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(1);
    await expect(
      page.locator(".titlebar").getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(toolbar(page)).toBeVisible();
    await expect(status(page)).toBeVisible();
    // The toolbar is above the bar of tabs.
    expect((await box(toolbar(page))).y).toBeLessThan((await box(tabBar)).y);
    const active = tabBar.locator('[data-nr-part="item"][data-nr-state="active"]');
    expect(await style(active, "border-bottom-width")).toBe("2px");
    expect(await style(active, "border-bottom-color")).toBe(SPACE);
    expect(await style(active, "border-top-left-radius")).toBe("0px");
  });

  test("in compact mode the sidebar hides, the bars stay, and the settings button is in the title bar", async ({
    page,
  }) => {
    await openDense(page, { bar: true, appearance: '"sidebar": { "compact": true }' });
    await expect(toolbar(page)).toBeVisible();
    await expect(status(page)).toBeVisible();
    await expect(
      page.locator(".titlebar").getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible();
    // The sidebar slides in over the window at the edge, under the toolbar and over the panes.
    await page.mouse.move(1, 300);
    await expect(side(page)).toHaveAttribute("data-nr-state", "revealed");
    const at = await box(side(page));
    expect(at.y).toBeGreaterThanOrEqual(
      (await box(toolbar(page))).y + (await box(toolbar(page))).height,
    );
    expect(at.y + at.height).toBeLessThanOrEqual((await box(status(page))).y);
  });

  test("with the sidebar on the right the bars and the sidebar still read as one window", async ({
    page,
  }) => {
    await openDense(page, { bar: true, appearance: '"sidebar": { "position": "right" }' });
    const at = await box(side(page));
    const win = page.viewportSize();
    expect(Math.round(at.x + at.width)).toBe(win?.width);
    expect(await style(side(page), "border-left-width")).toBe("1px");
    await expect(toolbar(page)).toBeVisible();
    await expect(status(page)).toBeVisible();
  });
});

test.describe("the style of the interface is switched at once", () => {
  test("from glass to dense: the bars, the header of the panes and the sidebar change with the screen still open, and back", async ({
    page,
  }) => {
    await start(page, { style: "glass", repos: REPOS, bar: true, agents: AGENT_STATES });
    await expect(page.locator('[data-nr-part="sidebar-head"]')).toBeVisible();
    await expect(toolbar(page)).toHaveCount(0);
    await expect(status(page)).toHaveCount(0);
    await expect(crumbs(page)).toHaveCount(0);
    await expect(bar(page, "p2")).not.toHaveAttribute("data-nr-style", "dense");

    const screen = await openSettings(page);
    const group = screen.getByRole("group", { name: "Interface style", exact: true });
    await group.scrollIntoViewIfNeeded();
    await group.getByRole("radio", { name: "Dense technical", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "dense");
    // At once, behind the open screen.
    await expect(toolbar(page)).toBeVisible();
    await expect(status(page)).toBeVisible();
    await expect(crumbs(page)).toBeVisible();
    await expect(bar(page, "p2")).toHaveAttribute("data-nr-style", "dense");
    await expect(page.locator('[data-nr-part="sidebar-head"]')).toHaveCount(0);
    await expect(side(page).locator('[data-nr-part="sidebar-agents"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(1);
    await expect(side(page).getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    expect(await style(page.locator("body"), "font-family")).toContain("JetBrains Mono");

    await group.getByRole("radio", { name: "Glass", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "glass");
    await expect(toolbar(page)).toHaveCount(0);
    await expect(status(page)).toHaveCount(0);
    await expect(crumbs(page)).toHaveCount(0);
    await closeSettings(page);
    await expect(page.locator('[data-nr-part="sidebar-head"]')).toBeVisible();
    await expect(side(page).locator('[data-nr-part="sidebar-agents"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(1);
  });

  test("the highlight stays the color of the space across the switch, in both directions (the theme sets the accent again when the style changes)", async ({
    page,
  }) => {
    await start(page, { style: "glass", repos: REPOS });
    await expect(frame(page, "p2")).toBeVisible();
    const color = async () => ({
      space: await rootVar(page, "--nr-space-color"),
      accent: await rootVar(page, "--nr-accent"),
    });
    expect((await color()).space).toBe("#6b8afd");
    expect((await color()).accent).not.toBe("#6b8afd");
    const screen = await openSettings(page);
    const group = screen.getByRole("group", { name: "Interface style", exact: true });
    await group.scrollIntoViewIfNeeded();
    await group.getByRole("radio", { name: "Dense technical", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "dense");
    await expect.poll(async () => (await color()).space).toBe("#6b8afd");
    await group.getByRole("radio", { name: "Glass", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "glass");
    await expect.poll(async () => (await color()).space).toBe("#6b8afd");
    await closeSettings(page);
  });

  test("the ring of the pane in focus is still the color of the space after the style is switched at run time", async ({
    page,
  }) => {
    await start(page, { style: "glass", repos: REPOS });
    await tabs(page).getByRole("treeitem", { name: SPLIT_FIXTURE.title, exact: true }).click();
    await expect(frame(page, FIRST)).toBeVisible();
    const screen = await openSettings(page);
    const group = screen.getByRole("group", { name: "Interface style", exact: true });
    await group.scrollIntoViewIfNeeded();
    await group.getByRole("radio", { name: "Dense technical", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-nr-style", "dense");
    await closeSettings(page);
    await expect.poll(() => style(frame(page, FIRST), "border-top-color", "::after")).toBe(SPACE);
    const main = side(page).getByRole("button", { name: "Main", exact: true });
    expect(await style(main, "border-bottom-color")).toBe(SPACE);
    expect(
      await style(status(page).locator('[data-nr-part="status-space"]'), "background-color"),
    ).toBe(SPACE);
  });

  test("the tabs, the panes and what runs in them are the same after the switch (nothing is rebuilt)", async ({
    page,
  }) => {
    await start(page, { style: "glass", repos: REPOS });
    await tabs(page).getByRole("treeitem", { name: SPLIT_FIXTURE.title, exact: true }).click();
    await send(page, FIRST, RUN("pnpm dev"));
    await expect(page.locator('[data-nr-part="pane-command"]').first()).toContainText("pnpm dev");
    const before = await page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
    const screen = await openSettings(page);
    const group = screen.getByRole("group", { name: "Interface style", exact: true });
    await group.scrollIntoViewIfNeeded();
    await group.getByRole("radio", { name: "Dense technical", exact: true }).check();
    await expect(part(page, FIRST, "pane-state")).toHaveText("running");
    expect(await page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? [])).toEqual(
      before,
    );
    await expect(part(page, FIRST, "pane-command")).toContainText("pnpm dev");
  });
});

test.describe("the dense tokens are what the window is drawn with", () => {
  test("JetBrains Mono, the state colors, corners of 0 and a line of 1 px", async ({ page }) => {
    await openDense(page, { bar: true });
    for (const target of [
      page.locator("body"),
      side(page),
      toolbar(page),
      status(page),
      bar(page, "p2"),
    ]) {
      expect(await style(target, "font-family")).toMatch(/^"JetBrains Mono"/);
    }
    expect(await rootVar(page, "--nr-style-accent")).toBe("#2ee6d6");
    expect(await rootVar(page, "--nr-gap")).toBe("1px");
    for (const target of [side(page), toolbar(page), status(page), bar(page, "p2")]) {
      expect(await style(target, "border-top-left-radius")).toBe("0px");
    }
    expect(await style(side(page), "border-right-width")).toBe("1px");
    expect(await style(side(page), "border-right-color")).toBe(
      await style(toolbar(page), "border-bottom-color"),
    );
  });

  test("the four highlight colors of the design can be a space's color, the first of them (#2EE6D6) being the style's own", async ({
    page,
  }) => {
    await openDense(page);
    await side(page).getByRole("button", { name: "New space", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New space", exact: true });
    const radios = dialog.locator('input[name="space-color"]');
    await expect(radios).toHaveCount(16);
    for (const name of ["Cyan", "Lime", "Apricot", "Fuchsia"]) {
      await expect(dialog.getByRole("radio", { name, exact: true })).toBeVisible();
    }
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Teal");
    await dialog.getByRole("radio", { name: "Cyan", exact: true }).check();
    await dialog.getByRole("button", { name: "Create space", exact: true }).click();
    await expect(dialog).toBeHidden();
    const chip = status(page).locator('[data-nr-part="status-space"]');
    await expect(chip).toHaveText("Teal");
    expect(await style(chip, "background-color")).toBe(rgbOf("#2ee6d6"));
    // The ring of the pane and the line of the space tab are that color too.
    expect(
      await style(
        side(page).getByRole("button", { name: "Teal", exact: true }),
        "border-bottom-color",
      ),
    ).toBe(rgbOf("#2ee6d6"));
  });
});

test.describe("the glass window does not change", () => {
  test("none of the dense parts is drawn, and the glass ones are", async ({ page }) => {
    await start(page, { style: "glass", repos: REPOS, bar: true, agents: AGENT_STATES });
    await expect(page.locator('[data-nr-part="sidebar-head"]')).toBeVisible();
    await expect(page.locator('[data-nr-part="sidebar-search"]')).toBeVisible();
    await expect(page.locator('[data-nr-part="sidebar-base"]')).toBeVisible();
    for (const name of [
      "dense-toolbar",
      "status-bar",
      "titlebar-crumbs",
      "titlebar-palette",
      "sidebar-agents",
      "sidebar-agent",
      "pane-number",
      "item-waiting",
      "favorite-label",
      "space-swatch",
    ]) {
      await expect(page.locator(`[data-nr-part="${name}"]`), name).toHaveCount(0);
    }
    // The pane has the header of the glass: 38 px, its branch chip.
    expect((await box(bar(page, "p2"))).height).toBe(38);
    await expect(part(page, "p2", "pane-branch")).toBeVisible();
    // The favorites are in the sidebar, as a grid, and the settings button is at its foot.
    await expect(side(page).locator('[data-nr-part="favorites"]')).toHaveCount(1);
    await expect(
      side(page).locator('[data-nr-part="sidebar-base"]').getByRole("button", { name: "Settings" }),
    ).toBeVisible();
  });
});

test.describe("the window has no accessibility violation (axe)", () => {
  const LANGS = [
    ["en", "en"],
    ["pt-BR", "pt-BR"],
  ] as const;
  for (const mode of ["dark", "light"] as const satisfies readonly Mode[]) {
    for (const [lang] of LANGS) {
      test(`the dense window with its bars, an agent that waits and a split tab (${mode}, ${lang})`, async ({
        page,
      }) => {
        await openSplit(page, {
          mode,
          lang,
          bar: true,
          agents: [...AGENT_STATES, [SECOND, "shall i continue"]],
        });
        await send(page, FIRST, RUN("pnpm dev"));
        await expect(part(page, FIRST, "pane-state")).toBeVisible();
        await send(page, "p6", "thinking\r\n");
        await expectNoAxeViolations(page, `the dense window, ${mode}, ${lang}`);
        expect(THEME[mode].id.length).toBeGreaterThan(0);
      });
    }
  }

  test("the dense window with the tabs on top and the settings in the title bar (light, pt-BR)", async ({
    page,
  }) => {
    await openDense(page, {
      mode: "light",
      lang: "pt-BR",
      bar: true,
      agents: AGENT_STATES,
      appearance: '"tabs": "top"',
    });
    await expectNoAxeViolations(page, "the dense window with the tabs on top");
  });

  test("the dense window with the names too long for the sidebar (dark, en)", async ({ page }) => {
    await openDense(page, { longNames: true, bar: true, agents: AGENT_STATES });
    await expectNoAxeViolations(page, "the dense window with long names");
  });
});
