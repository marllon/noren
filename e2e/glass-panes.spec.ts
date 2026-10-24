import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { contrastRatio } from "../packages/model/src/theme";
import { expectNoAxeViolations } from "./axe-fixture";
import { LONG, THEME, start } from "./glass-sidebar-fixture";
import type { Mode, StartOptions } from "./glass-sidebar-fixture";
import { readPixels } from "./png-pixels";
import { SPLIT_FIXTURE } from "./sidebar-fixture";

// The pane of the glass style (NOR-F20-18c, D23), as in the design of the window (`vidro-janela`): the
// header of a terminal pane with its folder, the git branch, the command and the buttons that split and
// zoom it; the ring in the color of the space on the pane in focus; and the ring and the badge "Agent
// waiting for you" of an agent that waits. What the pane does (focus, keyboard, mouse, split, zoom,
// drag, what is saved) is what it did: the specs of those run under this style and are not repeated
// here, except where the buttons moved (the hover corner of the dense style is the header's buttons now).
// The dense style does not change, and a test says so. Everything runs on the `FakeBackend` of web mode.

interface Hook {
  paneIds(): string[];
  focusedPaneId(): string | undefined;
  sendOutput(paneId: string, text: string): boolean;
  setPaneAgent(paneId: string, agentId: string | undefined): Promise<boolean>;
}
type HookWindow = Window & { __norenTest?: Hook };

/** The folders of the two panes of the split tab of the fixture (`/srv/api`, `/srv/web`) and their branches. */
const REPOS = { "/srv/api": "main", "/srv/web": "feat/login-form" };
const [FIRST, SECOND] = [SPLIT_FIXTURE.first, SPLIT_FIXTURE.second];

/** The shell tells the line (OSC 633 E) and that it starts (133 C), and later how it ended (133 D). */
const RUN = (line: string): string => `\x1b]633;E;${line}\x07\x1b]133;C\x07`;
const END = (code: number): string => `\x1b]133;D;${code}\x07`;

const frame = (page: Page, id: string): Locator => page.locator(`[data-pane-id="${id}"]`);
const bar = (page: Page, id: string): Locator =>
  frame(page, id).locator('[data-nr-part="pane-bar"]');
const part = (page: Page, id: string, name: string): Locator =>
  bar(page, id).locator(`[data-nr-part="${name}"]`);
const button = (page: Page, id: string, name: string): Locator =>
  frame(page, id).getByRole("button", { name, exact: true });
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

interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A computed color as 0 to 255 channels and an alpha, whichever form the browser writes it in. */
function parseColor(css: string): Color {
  const value = css.trim();
  const srgb = /^color\(srgb ([0-9.]+) ([0-9.]+) ([0-9.]+)(?: \/ ([0-9.]+))?\)$/.exec(value);
  if (srgb !== null) {
    const [, r, g, b, a] = srgb;
    return { r: Number(r) * 255, g: Number(g) * 255, b: Number(b) * 255, a: a ? Number(a) : 1 };
  }
  const parts = /^rgba?\(([^)]+)\)$/
    .exec(value)?.[1]
    ?.split(/[\s,/]+/)
    .filter((p) => p !== "");
  if (parts === undefined || parts.length < 3) throw new Error(`not a color: ${css}`);
  return {
    r: Number(parts[0]),
    g: Number(parts[1]),
    b: Number(parts[2]),
    a: parts.length === 4 ? Number(parts[3]) : 1,
  };
}

const hexOf = (color: { r: number; g: number; b: number }): string =>
  `#${[color.r, color.g, color.b]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;

/** The color of a property, within a step of rounding of a `#rrggbb` at an alpha. */
async function expectColor(
  locator: Locator,
  property: string,
  want: string,
  alpha: number,
  label: string,
  pseudo?: string,
): Promise<void> {
  const actual = parseColor(await style(locator, property, pseudo));
  const n = (from: number) => parseInt(want.slice(from, from + 2), 16);
  expect(actual.r, `${label} red`).toBeCloseTo(n(1), -0.5);
  expect(actual.g, `${label} green`).toBeCloseTo(n(3), -0.5);
  expect(actual.b, `${label} blue`).toBeCloseTo(n(5), -0.5);
  expect(actual.a, `${label} alpha`).toBeCloseTo(alpha, 2);
}

// The state colors of style-tokens.css: the dark theme's, and the darker ones of the light scheme.
const STATE: Record<Mode, { running: string; waiting: string }> = {
  dark: { running: "#7ee2a8", waiting: "#f5b84b" },
  light: { running: "#1e8f5a", waiting: "#b7791f" },
};
// The space "Main" of the fixture is blue.
const SPACE = "#6b8afd";

type Options = Omit<StartOptions, "repos">;

/** The page with the split tab of the fixture on screen: `/srv/api` (focused) and `/srv/web`, side by side. */
async function openSplit(
  page: Page,
  options: Options = {},
  repos: Record<string, string> = REPOS,
): Promise<void> {
  await start(page, { repos, ...options });
  await tabs(page).getByRole("treeitem", { name: SPLIT_FIXTURE.title, exact: true }).click();
  await expect(frame(page, SECOND)).toBeVisible();
  await expect(frame(page, FIRST)).toBeVisible();
}

/** The page as it starts: the tab "api", one pane in `~/projects/noren` on the branch `main`. */
async function openSingle(page: Page, options: Options = {}): Promise<void> {
  await start(page, options);
  await expect(frame(page, "p2")).toBeVisible();
}

const send = (page: Page, id: string, text: string): Promise<boolean> =>
  page.evaluate(({ pane, out }) => (window as HookWindow).__norenTest?.sendOutput(pane, out), {
    pane: id,
    out: text,
  }) as Promise<boolean>;

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const focusedPane = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.focusedPaneId());

/** Waits for the page to have drawn the command the shell told. */
async function run(page: Page, id: string, line: string): Promise<void> {
  await send(page, id, RUN(line));
  await expect(part(page, id, "pane-command")).toContainText(line);
}

test.describe("the header of a terminal pane", () => {
  test("is a strip of 38 px at the top of every terminal pane, with a line under it and the terminal below", async ({
    page,
  }) => {
    await openSplit(page);
    for (const id of [FIRST, SECOND]) {
      const pane = await box(frame(page, id));
      const at = await box(bar(page, id));
      expect(at.height, `header of ${id}`).toBe(38);
      // Inside the line of the card (1 px), the whole width of the pane.
      expect(at.y - pane.y).toBe(1);
      expect(at.x - pane.x).toBe(1);
      expect(Math.abs(at.width - (pane.width - 2))).toBeLessThanOrEqual(1);
      expect(await style(bar(page, id), "border-bottom-width")).toBe("1px");
      expect(await style(bar(page, id), "padding-left")).toBe("14px");
      // The terminal starts where the header ends.
      const terminal = await box(frame(page, id).locator(".terminal-view"));
      expect(terminal.y).toBeGreaterThanOrEqual(at.y + at.height - 0.5);
    }
  });

  test("a tab of one pane has it too", async ({ page }) => {
    await openSingle(page);
    await expect(bar(page, "p2")).toHaveCount(1);
    await expect(part(page, "p2", "pane-folder")).toBeVisible();
    // One pane in the tab: the pane is the whole tab, so there is nothing to zoom.
    await expect(part(page, "p2", "pane-bar-zoom")).toHaveCount(0);
    await expect(part(page, "p2", "pane-bar-split-right")).toBeVisible();
    await expect(part(page, "p2", "pane-bar-split-down")).toBeVisible();
  });

  test("its height does not change with what it says: the terminal stays where it was", async ({
    page,
  }) => {
    await openSplit(page, { agents: [[SECOND, "shall i continue"]] });
    const before = await box(frame(page, FIRST).locator(".terminal-view"));
    await run(page, FIRST, "pnpm dev");
    await send(page, FIRST, END(0));
    await expect(part(page, FIRST, "pane-command")).toHaveAttribute("data-nr-state", "done");
    await send(page, SECOND, "thinking\r\n");
    await expect(part(page, SECOND, "pane-agent-badge")).toHaveCount(0);
    expect(await box(frame(page, FIRST).locator(".terminal-view"))).toEqual(before);
    expect((await box(bar(page, FIRST))).height).toBe(38);
    expect((await box(bar(page, SECOND))).height).toBe(38);
  });

  test("the dense style draws a header of its own (24 px, with the number of the pane), not the parts of this one, and there is no hover corner", async ({
    page,
  }) => {
    await openSplit(page, { style: "dense" });
    for (const id of [FIRST, SECOND]) {
      await expect(bar(page, id)).toHaveAttribute("data-nr-style", "dense");
      expect((await box(bar(page, id))).height).toBe(24);
      await expect(part(page, id, "pane-number")).toBeVisible();
      await expect(part(page, id, "pane-branch")).toHaveCount(0);
      await expect(bar(page, id).locator(".pane-bar-head")).toHaveCount(0);
    }
    await expect(part(page, FIRST, "pane-number")).toHaveText("1");
    await expect(part(page, SECOND, "pane-number")).toHaveText("2");
    await expect(page.locator('[data-nr-part="pane-corner"]')).toHaveCount(0);
  });
});

test.describe("the folder", () => {
  test("has the folder icon, the path muted and its last segment in the text color and heavier", async ({
    page,
  }) => {
    await openSplit(page);
    const folder = part(page, FIRST, "pane-folder");
    await expect(folder).toBeVisible();
    await expect(folder.locator("svg")).toHaveCount(1);
    const head = folder.locator(".pane-bar-head");
    const tail = folder.locator(".pane-bar-tail");
    await expect(head).toHaveText("/srv/");
    await expect(tail).toHaveText("api");
    expect(await style(tail, "font-weight")).toBe("600");
    await expectColor(tail, "color", THEME.dark.ui.text, 1, "last segment");
    // The head is the muted text pulled toward the text color, so it is not the text color itself.
    expect(hexOf(parseColor(await style(head, "color")))).not.toBe(THEME.dark.ui.text);
    // The whole folder is the tooltip.
    await expect(folder).toHaveAttribute("title", "/srv/api");
    await expect(part(page, SECOND, "pane-folder").locator(".pane-bar-tail")).toHaveText("web");
  });

  test("keeps the home folder as ~ and three segments of a long one", async ({ page }) => {
    await openSingle(page);
    const folder = part(page, "p2", "pane-folder");
    await expect(folder.locator(".pane-bar-head")).toHaveText("~/projects/");
    await expect(folder.locator(".pane-bar-tail")).toHaveText("noren");
    await expect(folder).toHaveAttribute("title", "/home/fake/projects/noren");
  });

  test("a pane that has not told its folder shows the one of the space", async ({ page }) => {
    await openSingle(page);
    // The tab "scratch" has no folder of its own; the space's default folder is the one of the actions.
    await tabs(page).getByRole("treeitem", { name: "scratch", exact: true }).click();
    const folder = part(page, "p6", "pane-folder");
    await expect(folder.locator(".pane-bar-tail")).toHaveText("proj");
    await expect(folder.locator(".pane-bar-head")).toHaveText("/srv/");
  });
});

test.describe("the branch", () => {
  test("is a chip with the branch icon and the name, said in words to assistive technology", async ({
    page,
  }) => {
    await openSplit(page);
    const chip = part(page, FIRST, "pane-branch");
    await expect(chip).toBeVisible();
    await expect(chip.locator("svg")).toHaveCount(1);
    await expect(chip.locator(".pane-bar-chip-text")).toHaveText("main");
    await expect(chip.locator(".sr-only")).toHaveText("Branch main");
    expect(await style(chip, "border-top-left-radius")).toBe("99px");
    expect((await box(chip)).height).toBeLessThan(26);
    await expect(part(page, SECOND, "pane-branch").locator(".pane-bar-chip-text")).toHaveText(
      "feat/login-form",
    );
  });

  test("is left out of a pane whose folder is not in a repository", async ({ page }) => {
    await openSplit(page, {}, { "/srv/api": "main" });
    await expect(part(page, SECOND, "pane-branch")).toHaveCount(0);
    await expect(part(page, FIRST, "pane-branch")).toHaveCount(1);
  });

  test("a tab of one pane shows its branch", async ({ page }) => {
    await openSingle(page);
    await expect(part(page, "p2", "pane-branch").locator(".pane-bar-chip-text")).toHaveText("main");
  });
});

test.describe("the command", () => {
  test("shows the command that runs with a green dot, and says it in words", async ({ page }) => {
    await openSplit(page);
    await expect(part(page, FIRST, "pane-command")).toHaveCount(0);
    await run(page, FIRST, "pnpm dev");
    const chip = part(page, FIRST, "pane-command");
    await expect(chip).toHaveAttribute("data-nr-state", "running");
    await expect(chip.locator(".pane-bar-chip-text")).toHaveText("pnpm dev");
    await expect(chip.locator(".sr-only")).toHaveText("Running pnpm dev");
    await expectColor(
      chip.locator(".pane-bar-dot"),
      "background-color",
      STATE.dark.running,
      1,
      "dot",
    );
    // The command is set in the mono font.
    expect(await style(chip, "font-family")).toContain("Geist Mono");
    // The other pane has none.
    await expect(part(page, SECOND, "pane-command")).toHaveCount(0);
  });

  test("when it ends the dot turns hollow, and a failure says its exit code", async ({ page }) => {
    await openSplit(page);
    await run(page, FIRST, "make");
    await send(page, FIRST, END(2));
    const chip = part(page, FIRST, "pane-command");
    await expect(chip).toHaveAttribute("data-nr-state", "failed");
    await expect(chip.locator(".pane-bar-code")).toHaveText("exit 2");
    await expect(chip.locator(".sr-only")).toContainText("Last command make, exit 2");
    // Hollow: no fill, a ring.
    expect(parseColor(await style(chip.locator(".pane-bar-dot"), "background-color")).a).toBe(0);
    expect(await style(chip.locator(".pane-bar-dot"), "border-top-width")).toBe("1px");

    await run(page, FIRST, "ls");
    await send(page, FIRST, END(0));
    await expect(chip).toHaveAttribute("data-nr-state", "done");
    await expect(chip.locator(".pane-bar-code")).toHaveCount(0);
    await expect(chip.locator(".pane-bar-chip-text")).toHaveText("ls");
  });

  test("a long command is cut by an ellipsis inside its chip", async ({ page }) => {
    await openSplit(page);
    const line =
      "pnpm --filter @noren/desktop exec vite build --mode demo --some-very-long-flag-name";
    await run(page, FIRST, line);
    const chip = part(page, FIRST, "pane-command");
    const text = chip.locator(".pane-bar-chip-text");
    expect(await text.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await style(text, "text-overflow")).toBe("ellipsis");
    const info = await box(frame(page, FIRST).locator(".pane-bar-info"));
    const at = await box(chip);
    expect(at.x + at.width).toBeLessThanOrEqual(info.x + info.width + 0.5);
  });
});

test.describe("an agent that waits for you", () => {
  test("has the amber badge in the header of its pane, and no other pane has one", async ({
    page,
  }) => {
    await openSplit(page, { agents: [[SECOND, "shall i continue"]] });
    const badge = part(page, SECOND, "pane-agent-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("Agent waiting for you");
    await expect(badge.locator("svg")).toHaveCount(1);
    await expect(part(page, FIRST, "pane-agent-badge")).toHaveCount(0);
    expect(await style(badge, "border-top-left-radius")).toBe("99px");
    // The amber of the state on a tint of itself (16%).
    const tint = parseColor(await style(badge, "background-color"));
    expect(hexOf(tint)).toBe(STATE.dark.waiting);
    expect(tint.a).toBeCloseTo(0.16, 2);
    // The words reach assistive technology once, from the status of the pane; the badge is for the eyes.
    await expect(badge).toHaveAttribute("aria-hidden", "true");
    await expect(frame(page, SECOND).getByRole("status")).toHaveText(
      "Agent helper is waiting for you",
    );
  });

  test("goes away when the agent works again, and comes back when it waits", async ({ page }) => {
    await openSplit(page, { agents: [[SECOND, "shall i continue"]] });
    const badge = part(page, SECOND, "pane-agent-badge");
    await expect(badge).toBeVisible();
    await send(page, SECOND, "thinking\r\n");
    await expect(badge).toHaveCount(0);
    await send(page, SECOND, "shall i continue\r\n");
    await expect(badge).toBeVisible();
  });

  test("a pane without an agent has none, and the sentence is Portuguese in Portuguese", async ({
    page,
  }) => {
    await openSplit(page, { lang: "pt-BR", agents: [[SECOND, "shall i continue"]] });
    await expect(part(page, FIRST, "pane-agent-badge")).toHaveCount(0);
    await expect(part(page, SECOND, "pane-agent-badge")).toContainText("Agente esperando você");
  });
});

test.describe("the ring", () => {
  test("is on the pane in focus, in the color of the space at 55%, and follows the corners of the card", async ({
    page,
  }) => {
    await openSplit(page);
    await expect(frame(page, FIRST)).toHaveAttribute("data-nr-focused", "true");
    await expect(frame(page, SECOND)).toHaveAttribute("data-nr-focused", "false");
    await expectColor(frame(page, FIRST), "border-top-color", SPACE, 0.55, "ring", "::after");
    expect(await style(frame(page, FIRST), "border-top-width", "::after")).toBe("1px");
    expect(await style(frame(page, FIRST), "border-top-left-radius", "::after")).toBe("12px");
    // The other pane draws none.
    expect(await style(frame(page, SECOND), "content", "::after")).toBe("none");
  });

  test("moves to the pane the mouse presses, the header included", async ({ page }) => {
    await openSplit(page);
    await part(page, SECOND, "pane-folder").click();
    await expect(frame(page, SECOND)).toHaveAttribute("data-nr-focused", "true");
    await expect(frame(page, FIRST)).toHaveAttribute("data-nr-focused", "false");
    expect(await focusedPane(page)).toBe(SECOND);
    await expectColor(frame(page, SECOND), "border-top-color", SPACE, 0.55, "ring", "::after");
  });

  test("follows the space: the pane of another space is ringed in the color of that space", async ({
    page,
  }) => {
    await openSplit(page, { secondSpace: true });
    await page
      .getByRole("navigation", { name: "Spaces", exact: true })
      .getByRole("button", { name: "Other", exact: true })
      .click();
    await expect.poll(() => rootVar(page, "--nr-highlight")).toBe("#e0a458");
    // The space has one tab of one pane; a split gives it a pane in focus, ringed in the amber of the space.
    await button(page, "q1", "Split right").click();
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(2);
    const focused = await focusedPane(page);
    if (focused === undefined) throw new Error("no focus");
    await expectColor(frame(page, focused), "border-top-color", "#e0a458", 0.55, "ring", "::after");
  });

  test("an agent that waits rings its pane in amber, a working one in green, a pane with none has no ring", async ({
    page,
  }) => {
    await openSplit(page, { agents: [[SECOND, "shall i continue"]] });
    const ring = (id: string) => frame(page, id).locator('[data-nr-part="pane-agent-ring"]');
    await expect(ring(FIRST)).toHaveCount(0);
    await expect(ring(SECOND)).toHaveCount(1);
    await expectColor(ring(SECOND), "border-top-color", STATE.dark.waiting, 0.45, "waiting ring");
    expect(await style(ring(SECOND), "border-top-width")).toBe("1px");
    expect(await style(ring(SECOND), "border-top-left-radius")).toBe("12px");

    await send(page, SECOND, "thinking\r\n");
    await expect(frame(page, SECOND)).toHaveAttribute("data-nr-agent-state", "working");
    await expectColor(ring(SECOND), "border-top-color", STATE.dark.running, 0.45, "working ring");
  });

  test("the colors of the states follow the theme: darker on a light one", async ({ page }) => {
    await openSplit(page, { mode: "light", agents: [[SECOND, "shall i continue"]] });
    const ring = frame(page, SECOND).locator('[data-nr-part="pane-agent-ring"]');
    await expectColor(ring, "border-top-color", STATE.light.waiting, 0.45, "waiting ring, light");
    await run(page, FIRST, "pnpm dev");
    await expectColor(
      part(page, FIRST, "pane-command").locator(".pane-bar-dot"),
      "background-color",
      STATE.light.running,
      1,
      "dot, light",
    );
  });
});

test.describe("the buttons", () => {
  test("every pane has split right, split down and, in a split tab, zoom: 28 px, always in sight", async ({
    page,
  }) => {
    await openSplit(page);
    for (const id of [FIRST, SECOND]) {
      const actions = part(page, id, "pane-bar-actions");
      await expect(actions).toBeVisible();
      for (const name of ["Split right", "Split down", "Zoom pane"]) {
        const target = button(page, id, name);
        await expect(target).toBeVisible();
        const at = await box(target);
        expect([at.width, at.height], `${name} of ${id}`).toEqual([28, 28]);
        expect(await style(target, "border-top-left-radius")).toBe("8px");
      }
    }
    // No hover needed, and no hover corner: the buttons are in the header.
    await page.mouse.move(2, 2);
    await expect(button(page, FIRST, "Split right")).toBeVisible();
    await expect(page.locator('[data-nr-part="pane-corner"]')).toHaveCount(0);
  });

  test("sit at the right end of the header, side by side, clear of what the header says", async ({
    page,
  }) => {
    await openSplit(page, { agents: [[SECOND, "shall i continue"]] });
    await run(page, FIRST, "pnpm dev");
    for (const id of [FIRST, SECOND]) {
      const header = await box(bar(page, id));
      const actions = await box(part(page, id, "pane-bar-actions"));
      const info = await box(frame(page, id).locator(".pane-bar-info"));
      // 6 px of padding on the right, vertically centered.
      expect(header.x + header.width - (actions.x + actions.width)).toBeCloseTo(6, 0);
      expect(
        Math.abs(actions.y + actions.height / 2 - (header.y + header.height / 2)),
      ).toBeLessThan(1.5);
      expect(info.x + info.width).toBeLessThanOrEqual(actions.x + 0.5);
      const right = await box(button(page, id, "Split right"));
      const down = await box(button(page, id, "Split down"));
      const zoom = await box(button(page, id, "Zoom pane"));
      expect(down.x).toBeGreaterThanOrEqual(right.x + right.width);
      expect(zoom.x).toBeGreaterThanOrEqual(down.x + down.width);
      expect(Math.abs(down.y - right.y)).toBeLessThan(1);
    }
  });

  test("are named, and their title has the shortcut that does the same", async ({ page }) => {
    await openSplit(page);
    await expect(button(page, FIRST, "Split right")).toHaveAttribute(
      "title",
      "Split right (Ctrl+Shift+D)",
    );
    await expect(button(page, FIRST, "Split down")).toHaveAttribute(
      "title",
      "Split down (Ctrl+Shift+E)",
    );
    await expect(button(page, FIRST, "Split right")).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Shift+D",
    );
    const zoomTitle = await button(page, FIRST, "Zoom pane").getAttribute("title");
    expect(zoomTitle).toMatch(/^Zoom pane \(Ctrl\+/);
  });

  test("have the names of the language of the interface", async ({ page }) => {
    await openSplit(page, { lang: "pt-BR" });
    await expect(button(page, FIRST, "Dividir à direita")).toBeVisible();
    await expect(button(page, FIRST, "Dividir abaixo")).toBeVisible();
    await expect(button(page, FIRST, "Ampliar painel")).toBeVisible();
    await expect(part(page, FIRST, "pane-branch").locator(".sr-only")).toHaveText("Branch main");
  });

  test("Split right splits that pane, the new one takes the focus and has a header too", async ({
    page,
  }) => {
    await openSplit(page);
    // The pane that is not the focused one: its own header splits it, not the focused pane.
    await button(page, SECOND, "Split down").click();
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(3);
    const ids = await paneIds(page);
    const added = ids.find((id) => id !== FIRST && id !== SECOND);
    if (added === undefined) throw new Error("no new pane");
    expect(await focusedPane(page)).toBe(added);
    const second = await box(frame(page, SECOND));
    const fresh = await box(frame(page, added));
    expect(fresh.y).toBeGreaterThan(second.y + second.height / 2);
    expect(Math.abs(fresh.x - second.x)).toBeLessThan(2);
    await expect(bar(page, added)).toBeVisible();
    await expect(frame(page, added)).toHaveAttribute("data-nr-focused", "true");
  });

  test("Split right of a tab of one pane makes it a split with a zoom button on each pane", async ({
    page,
  }) => {
    await openSingle(page);
    await button(page, "p2", "Split right").click();
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(2);
    for (const id of await paneIds(page)) {
      await expect(button(page, id, "Zoom pane")).toBeVisible();
    }
  });

  test("zoom fills the tab with that pane, the button turns into Restore, and restoring brings the others back", async ({
    page,
  }) => {
    await openSplit(page);
    const slot = await box(page.locator('[data-nr-part="item-view"]:visible'));
    await button(page, SECOND, "Zoom pane").click();
    await expect(frame(page, SECOND)).toHaveAttribute("data-nr-zoom", "zoomed");
    await expect(frame(page, FIRST)).toHaveAttribute("data-nr-zoom", "hidden");
    const zoomed = await box(frame(page, SECOND));
    expect(Math.abs(zoomed.width - slot.width)).toBeLessThanOrEqual(2);
    await expect(button(page, SECOND, "Zoom pane")).toHaveCount(0);
    await button(page, SECOND, "Restore pane").click();
    await expect(frame(page, SECOND)).not.toHaveAttribute("data-nr-zoom", "zoomed");
    await expect(frame(page, FIRST)).not.toHaveAttribute("data-nr-zoom", "hidden");
    await expect(button(page, SECOND, "Zoom pane")).toBeVisible();
  });

  test("the keyboard reaches them in order and Enter presses the one it is on", async ({
    page,
  }) => {
    await openSplit(page);
    await button(page, FIRST, "Split right").focus();
    await expect(button(page, FIRST, "Split right")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(button(page, FIRST, "Split down")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(button(page, FIRST, "Zoom pane")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(3);
  });

  test("at the limit of panes the split buttons are off and zoom is not", async ({ page }) => {
    await openSplit(page);
    // Eight panes, the limit of the setting, made with the buttons of the last pane each time.
    for (let n = 2; n < 8; n++) {
      const ids = await paneIds(page);
      const last = ids[ids.length - 1];
      if (last === undefined) throw new Error("no pane");
      await button(page, last, n % 2 === 0 ? "Split down" : "Split right").click();
      await expect.poll(() => paneIds(page).then((rows) => rows.length)).toBe(n + 1);
    }
    for (const id of await paneIds(page)) {
      await expect(button(page, id, "Split right")).toBeDisabled();
      await expect(button(page, id, "Split down")).toBeDisabled();
    }
    // Zoom is not a split: it stays on (a pane of 100 px or less has no room for it in its header).
    await expect(button(page, FIRST, "Zoom pane")).toBeEnabled();
  });

  test("the keyboard shortcuts still split and zoom the focused pane", async ({ page }) => {
    await openSplit(page);
    await frame(page, FIRST).locator(".terminal-view").click();
    await page.keyboard.press("Control+Shift+D");
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(3);
    const focused = await focusedPane(page);
    if (focused === undefined) throw new Error("no focus");
    await expect(bar(page, focused)).toBeVisible();
  });
});

test.describe("with the pane headers of the settings on", () => {
  test("the header of the settings stays, the glass header is under it, and no button has two of the same name", async ({
    page,
  }) => {
    await openSplit(page, { appearance: '"paneHeaders": true' });
    for (const id of [FIRST, SECOND]) {
      const header = await box(frame(page, id).locator('[data-nr-part="pane-header"]'));
      const glass = await box(bar(page, id));
      expect(glass.y).toBeGreaterThanOrEqual(header.y + header.height - 0.5);
      // The zoom button is the header of the settings' own: one in the pane, never two.
      await expect(button(page, id, "Zoom pane")).toHaveCount(1);
      await expect(button(page, id, "Split right")).toHaveCount(1);
      await expect(button(page, id, "Split down")).toHaveCount(1);
      await expect(button(page, id, "Close pane")).toHaveCount(1);
    }
    await expect(part(page, FIRST, "pane-bar-zoom")).toHaveCount(0);
    // The header of the settings lets the glass through.
    const background = parseColor(
      await style(frame(page, FIRST).locator('[data-nr-part="pane-header"]'), "background-color"),
    );
    expect(background.a).toBe(0);
  });

  test("zoom from the header of the settings still works, and the glass header says Split only", async ({
    page,
  }) => {
    await openSplit(page, { appearance: '"paneHeaders": true' });
    await button(page, SECOND, "Zoom pane").click();
    await expect(frame(page, SECOND)).toHaveAttribute("data-nr-zoom", "zoomed");
    await button(page, SECOND, "Restore pane").click();
    await expect(frame(page, SECOND)).not.toHaveAttribute("data-nr-zoom", "zoomed");
  });
});

test.describe("names too long and panes too narrow", () => {
  /** What nothing in a header may do: leave its strip, or be wider than the room the strip gives it. */
  async function expectHeaderFits(page: Page, id: string): Promise<void> {
    const report = await bar(page, id).evaluate((header) => {
      const edge = header.getBoundingClientRect();
      const info = header.querySelector<HTMLElement>(".pane-bar-info");
      const actions = header.querySelector<HTMLElement>(".pane-bar-actions");
      const outside: string[] = [];
      for (const element of header.querySelectorAll("*")) {
        if (element.closest(".sr-only") !== null) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > edge.right + 0.5 || rect.left < edge.left - 0.5) {
          outside.push(`${element.className || element.tagName} ${rect.left}-${rect.right}`);
        }
      }
      // Inside the info box: no child is wider than the room the box gives (a text cut by an ellipsis is
      // inside its own box; it is the box that must fit).
      const wide: string[] = [];
      if (info !== null) {
        const room = info.getBoundingClientRect();
        for (const child of info.querySelectorAll<HTMLElement>(":scope > *")) {
          const rect = child.getBoundingClientRect();
          if (rect.width > 0 && rect.right > room.right + 0.5) {
            wide.push(`${child.className} ${rect.right}>${room.right}`);
          }
        }
      }
      const overlap =
        info !== null && actions !== null
          ? info.getBoundingClientRect().right - actions.getBoundingClientRect().left
          : 0;
      return { outside, wide, overlap, own: header.scrollWidth - header.clientWidth };
    });
    expect(report.outside, `${id}: elements that leave the header`).toEqual([]);
    expect(report.wide, `${id}: boxes wider than the room they have`).toEqual([]);
    expect(report.overlap, `${id}: the info reaches the buttons`).toBeLessThanOrEqual(0.5);
    expect(report.own, `${id}: the header scrolls sideways`).toBeLessThanOrEqual(0);
  }

  test("a long folder, branch and command stay inside the header of a pane of half the window", async ({
    page,
  }) => {
    await openSplit(page, { longPane: true, agents: [[SECOND, "shall i continue"]] });
    await run(
      page,
      FIRST,
      "pnpm --filter @noren/desktop exec vite build --mode demo --a-flag-that-is-far-too-long",
    );
    await expect(part(page, FIRST, "pane-branch").locator(".pane-bar-chip-text")).toHaveText(
      LONG.branch,
    );
    await expectHeaderFits(page, FIRST);
    await expectHeaderFits(page, SECOND);
    // The last segment of the folder is what is kept when the rest is cut.
    const tail = part(page, FIRST, "pane-folder").locator(".pane-bar-tail");
    await expect(tail).toHaveText("parts");
    expect((await box(tail)).width).toBeGreaterThan(30);
    // The buttons are still where they were.
    for (const name of ["Split right", "Split down", "Zoom pane"]) {
      await expect(button(page, FIRST, name)).toBeVisible();
    }
  });

  test("in a pane of 190 px the chips give way, the badge keeps its icon, and nothing leaves the header", async ({
    page,
  }) => {
    await openSplit(page, {
      longPane: true,
      appearance: '"sidebar": { "width": 480 }',
      agents: [[SECOND, "shall i continue"]],
    });
    await run(page, FIRST, "pnpm dev --with-a-long-flag");
    await button(page, SECOND, "Split right").click();
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(3);
    const ids = await paneIds(page);
    for (const id of ids) {
      expect((await box(frame(page, id))).width, `pane ${id}`).toBeLessThan(400);
      await expectHeaderFits(page, id);
    }
    // The pane that is 190 px wide: no chip but the badge, whose words are left to the status.
    const narrow = ids.find((id) => id !== FIRST && id !== SECOND);
    if (narrow === undefined) throw new Error("no new pane");
    expect((await box(frame(page, SECOND))).width).toBeLessThan(240);
    await expect(part(page, SECOND, "pane-branch")).toBeHidden();
    await expect(part(page, SECOND, "pane-agent-badge")).toBeVisible();
    await expect(
      part(page, SECOND, "pane-agent-badge").locator(".pane-bar-chip-text"),
    ).toBeHidden();
    await expect(frame(page, SECOND).getByRole("status")).toHaveText(
      "Agent helper is waiting for you",
    );
    // The folder keeps its last segment readable.
    await expect(part(page, SECOND, "pane-folder").locator(".pane-bar-tail")).toBeVisible();
    // The wider pane still has its chips.
    await expect(part(page, FIRST, "pane-branch")).toBeVisible();
    await expect(part(page, FIRST, "pane-command")).toBeVisible();
  });

  test("the badge is whole or only an icon, never cut by an ellipsis, from a wide window down to a narrow one", async ({
    page,
  }) => {
    await openSplit(page, { lang: "pt-BR", agents: [[SECOND, "shall i continue"]] });
    const text = part(page, SECOND, "pane-agent-badge").locator(".pane-bar-chip-text");
    const widths: number[] = [];
    for (const width of [1280, 1180, 1112, 1060, 1000, 940, 880, 800]) {
      await page.setViewportSize({ width, height: 720 });
      await expect(part(page, SECOND, "pane-agent-badge")).toBeVisible();
      await expectHeaderFits(page, SECOND);
      if (await text.isVisible()) {
        const cut = await text.evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(cut, `the words of the badge at ${width} px`).toBeLessThanOrEqual(0);
        widths.push(width);
      }
      // The folder keeps its last segment whole as long as it has any room: no ellipsis in a short name.
      const tail = part(page, SECOND, "pane-folder").locator(".pane-bar-tail");
      expect(await tail.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    }
    // The words are there in a window as wide as 1112 px (panes of 440) and gone in the narrowest.
    expect(widths).toContain(1112);
    expect(widths).not.toContain(800);
  });

  test("eight panes in a row, each header fits", async ({ page }) => {
    await openSplit(page, { longPane: true });
    for (let n = 2; n < 8; n++) {
      const ids = await paneIds(page);
      const last = ids[ids.length - 1];
      if (last === undefined) throw new Error("no pane");
      await button(page, last, "Split right").click();
      await expect.poll(() => paneIds(page).then((rows) => rows.length)).toBe(n + 1);
    }
    for (const id of await paneIds(page)) await expectHeaderFits(page, id);
  });
});

test.describe("the text of the header keeps 4.5:1", () => {
  /** The color of a pixel of a screenshot. */
  const cases: { mode: Mode; picture?: string; label: string }[] = [
    { mode: "dark", label: "the illustrated backdrop, a dark theme" },
    { mode: "light", label: "the illustrated backdrop, a light theme" },
    { mode: "dark", picture: "#ffffff", label: "a white picture, a dark theme (the worst of it)" },
    {
      mode: "light",
      picture: "#000000",
      label: "a black picture, a light theme (the worst of it)",
    },
  ];

  for (const { mode, picture, label } of cases) {
    test(`the folder, the branch, the command and the badge over ${label}`, async ({ page }) => {
      await openSplit(page, {
        mode,
        agents: [[SECOND, "shall i continue"]],
        ...(picture !== undefined ? { picture } : {}),
      });
      await run(page, FIRST, "pnpm dev");
      await page.waitForTimeout(500);
      const png = await page.screenshot();
      const pixels = readPixels(png);
      const at = (x: number, y: number): string => {
        const [r, g, b] = pixels.at(Math.round(x), Math.round(y));
        return hexOf({ r: r ?? 0, g: g ?? 0, b: b ?? 0 });
      };
      const textOf = async (locator: Locator): Promise<string> =>
        hexOf(parseColor(await style(locator, "color")));
      /** The ground a text is read against: a pixel inside its chip, left of the icon. */
      const inChip = async (chip: Locator): Promise<string> => {
        const rect = await box(chip);
        return at(rect.x + 4, rect.y + rect.height / 2);
      };
      /** The ground of a text with none of its own: the header, above the line of text. */
      const inBar = async (id: string, over: Locator): Promise<string> => {
        const rect = await box(over);
        const header = await box(bar(page, id));
        return at(rect.x + rect.width / 2, header.y + 3);
      };
      const checks: [string, string, string][] = [];
      const folder = part(page, FIRST, "pane-folder");
      checks.push([
        "last segment of the folder",
        await textOf(folder.locator(".pane-bar-tail")),
        await inBar(FIRST, folder.locator(".pane-bar-tail")),
      ]);
      checks.push([
        "head of the folder",
        await textOf(folder.locator(".pane-bar-head")),
        await inBar(FIRST, folder.locator(".pane-bar-head")),
      ]);
      const branch = part(page, FIRST, "pane-branch");
      checks.push([
        "branch",
        await textOf(branch.locator(".pane-bar-chip-text")),
        await inChip(branch),
      ]);
      const command = part(page, FIRST, "pane-command");
      checks.push([
        "command",
        await textOf(command.locator(".pane-bar-chip-text")),
        await inChip(command),
      ]);
      const badge = part(page, SECOND, "pane-agent-badge");
      checks.push([
        "badge",
        await textOf(badge.locator(".pane-bar-chip-text")),
        await inChip(badge),
      ]);
      for (const [what, text, ground] of checks) {
        expect(
          contrastRatio(text, ground),
          `${what} (${text} on ${ground}) over ${label}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      // The buttons are graphics: 3:1.
      const icon = button(page, FIRST, "Split right");
      expect(
        contrastRatio(await textOf(icon), await inBar(FIRST, icon)),
        `buttons over ${label}`,
      ).toBeGreaterThanOrEqual(3);
      // The theme's own text is what the last segment is.
      expect(await textOf(folder.locator(".pane-bar-tail"))).toBe(THEME[mode].ui.text);
    });
  }
});

test.describe("axe", () => {
  for (const mode of ["dark", "light"] as const) {
    for (const lang of ["en", "pt-BR"] as const) {
      test(`a split tab with a command, a failed one and an agent that waits has no violation (${lang}, ${mode})`, async ({
        page,
      }) => {
        await openSplit(page, { mode, lang, agents: [[SECOND, "shall i continue"]] });
        await run(page, FIRST, "pnpm dev");
        await expectNoAxeViolations(page, `the header of a pane with a command, ${lang}, ${mode}`);
        await send(page, FIRST, END(2));
        await expect(part(page, FIRST, "pane-command")).toHaveAttribute("data-nr-state", "failed");
        await expectNoAxeViolations(page, `the header of a pane with a failure, ${lang}, ${mode}`);
      });

      test(`a tab of one pane, and the headers of the settings above the glass ones, have no violation (${lang}, ${mode})`, async ({
        page,
      }) => {
        await openSingle(page, { mode, lang });
        await expectNoAxeViolations(page, `a tab of one pane, ${lang}, ${mode}`);
      });
    }
  }

  test("a zoomed pane and the settings headers on have no violation", async ({ page }) => {
    await openSplit(page, {
      appearance: '"paneHeaders": true',
      agents: [[SECOND, "shall i continue"]],
    });
    await expectNoAxeViolations(page, "the settings headers over the glass ones");
    await button(page, SECOND, "Zoom pane").click();
    await expect(frame(page, SECOND)).toHaveAttribute("data-nr-zoom", "zoomed");
    await expectNoAxeViolations(page, "a zoomed pane");
  });

  test("a pane too narrow for its chips has no violation", async ({ page }) => {
    await openSplit(page, {
      longPane: true,
      appearance: '"sidebar": { "width": 480 }',
      agents: [[SECOND, "shall i continue"]],
    });
    await button(page, SECOND, "Split right").click();
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(3);
    await expectNoAxeViolations(page, "narrow panes with the badge as an icon");
  });
});
