import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { seedConfig } from "./settings-fixture";
import {
  ACTIONS_CWD,
  ACTIONS_TEXT,
  changeActionsFile,
  seedActionsFile,
  seedSidebarState,
} from "./sidebar-fixture";

// The profiles and project actions of the Favorites bar (NOR-F20-11b): put in the bar with the right
// click of a profile row of the palette and of an action row of the header, taken out with the right
// click of the tile, a click on a profile opens a tab with it, a click on an action runs it through
// the confirmation that already exists, and the list is the same after a reload. A tile whose
// profile is gone or whose action the file no longer declares stays, unavailable, says why when it
// is clicked and runs nothing, not even another action. The seeded sidebar: Main (folder
// `/srv/proj`, with the actions "Loop" and "Dev server") and the space "Other"; the profiles of the
// machine are "Fake shell" and "PowerShell".

const WEB_STATE_KEY = "noren.web.state";
const WEB_ACTIONS_KEY = "noren.web.actions";
const OTHER_CWD = "/srv/other";
const OTHER_ACTIONS = JSON.stringify({
  actions: [{ id: "lint", label: "Lint", command: "pnpm lint", tab: "lint" }],
});

interface Hook {
  paneIds(): string[];
  lines(): string[];
  sessionStarts(): { profileId?: string }[];
  commandRuns(): { cwd: string; command: string }[];
}
type HookWindow = Window & { __norenTest?: Hook };

interface Words {
  lang: "en" | "pt-BR";
  region: string;
  add: string;
  remove: string;
  /** The name of the tile of the profile "PowerShell". */
  profile: string;
  /** The name of the tile of the action "Dev server", idle and running. */
  run: string;
  show: string;
  /** The name of a button of the header, and the button of the confirmation. */
  start: string;
  runButton: string;
}

const WORDS: Record<Words["lang"], Words> = {
  en: {
    lang: "en",
    region: "Favorites",
    add: "Add to favorites",
    remove: "Remove from favorites",
    profile: "New PowerShell tab",
    run: "Run Dev server",
    show: "Show Dev server",
    start: "Start Dev server",
    runButton: "Run",
  },
  "pt-BR": {
    lang: "pt-BR",
    region: "Favoritos",
    add: "Adicionar aos favoritos",
    remove: "Remover dos favoritos",
    profile: "Nova aba PowerShell",
    run: "Executar Dev server",
    show: "Mostrar Dev server",
    start: "Iniciar Dev server",
    runButton: "Executar",
  },
};

type Mode = "dark" | "light";
const THEME: Record<Mode, string> = { dark: "noren-dusk", light: "noren-paper" };

const PROFILES = [
  { id: "fake", name: "Fake shell", default: true },
  { id: "pwsh", name: "PowerShell", default: false },
];

const bar = (page: Page) => page.locator('[data-nr-part="favorites"]');
const hint = (page: Page) => page.locator('[data-nr-part="favorites-hint"]');
const tiles = (page: Page) => bar(page).locator('[data-nr-part="favorite"]');
const tile = (page: Page, name: string) => bar(page).getByRole("button", { name, exact: true });
const tabList = (page: Page) => page.locator('[data-nr-part="sidebar"]').getByRole("tree");
const tabRow = (page: Page, name: string) =>
  tabList(page).getByRole("treeitem", { name, exact: true });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const notice = (page: Page) => page.locator('[data-nr-part="pane-notice"]');
const dialog = (page: Page) => page.getByRole("alertdialog");
const header = (page: Page) => page.locator('[data-nr-part="space-header"]');
const actionRow = (page: Page, label: string) =>
  header(page).locator(".space-action").filter({ hasText: label });

/** What `state.json` holds, as the web backend keeps it. */
async function saved(page: Page): Promise<{
  version: number;
  favorites: string[];
  favoriteLinks?: {
    kind: string;
    profileId?: string;
    spaceId?: string;
    actionId?: string;
    label: string;
  }[];
}> {
  const text = await page.evaluate((key) => window.localStorage.getItem(key), WEB_STATE_KEY);
  return JSON.parse(text ?? "{}");
}

const sessionStarts = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts() ?? []);
const typed = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines().join("\n") ?? "");

interface StartOptions {
  mode?: Mode;
  profiles?: typeof PROFILES;
  /** Links the saved state already holds (written once, before the page first loads). */
  links?: object[];
  /** Gives "Other" a folder with an actions file. */
  otherActions?: boolean;
  actionsText?: string;
}

/** Starts the page in a language and a theme with the seeded sidebar, ready for the tests below. */
async function start(page: Page, lang: Words["lang"], options: StartOptions = {}): Promise<Words> {
  const language = lang === "pt-BR" ? '"language": "pt-BR", ' : "";
  await seedConfig(
    page,
    `{ ${language}"appearance": { "theme": "${THEME[options.mode ?? "dark"]}" } }\n`,
  );
  await page.addInitScript((profiles) => {
    window.localStorage.setItem("noren.web.profiles", JSON.stringify(profiles));
  }, options.profiles ?? PROFILES);
  await seedSidebarState(page, { cwd: ACTIONS_CWD, secondSpace: true });
  await seedActionsFile(page, ACTIONS_CWD, options.actionsText ?? ACTIONS_TEXT);
  if (options.otherActions === true) {
    await page.addInitScript(
      ({ key, folder, text }) => {
        const files = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<
          string,
          string
        >;
        files[folder] = text;
        window.localStorage.setItem(key, JSON.stringify(files));
      },
      { key: WEB_ACTIONS_KEY, folder: OTHER_CWD, text: OTHER_ACTIONS },
    );
  }
  if (options.links !== undefined || options.otherActions === true) {
    // Patches the state the first time only: a reload in a test must find what the page saved.
    await page.addInitScript(
      ({ key, links, otherActions, otherCwd }) => {
        if (window.localStorage.getItem("seed-patched") !== null) return;
        window.localStorage.setItem("seed-patched", "yes");
        const state = JSON.parse(window.localStorage.getItem(key) ?? "{}") as {
          favoriteLinks?: object[];
          spaces: { id: string; defaults: { cwd?: string } }[];
        };
        if (links !== undefined) state.favoriteLinks = links;
        if (otherActions) {
          const other = state.spaces.find((space) => space.id === "s2");
          if (other) other.defaults.cwd = otherCwd;
        }
        window.localStorage.setItem(key, JSON.stringify(state));
      },
      {
        key: WEB_STATE_KEY,
        links: options.links,
        otherActions: options.otherActions === true,
        otherCwd: OTHER_CWD,
      },
    );
  }
  await page.goto("/");
  await expect(tabRow(page, "api")).toBeVisible();
  return WORDS[lang];
}

const DEV_LINK = { kind: "action", spaceId: "s1", actionId: "dev", label: "Dev server" };
const PWSH_LINK = { kind: "profile", profileId: "pwsh", label: "PowerShell" };

/** Opens the palette and narrows it to the profile "PowerShell". */
async function paletteProfileRow(page: Page, lang: Words["lang"]): Promise<Locator> {
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type(">powershell");
  const row = palette(page).locator('[data-nr-kind="profile"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(lang === "pt-BR" ? "Nova aba PowerShell" : "New PowerShell tab");
  return row;
}

for (const lang of ["en", "pt-BR"] as const) {
  test(`a profile is put in the bar with the right click of its row in the palette, opens a tab, survives a reload and is taken out with the right click of its tile (${lang})`, async ({
    page,
  }) => {
    const words = await start(page, lang);
    await expect(hint(page)).toBeVisible();
    // A state saved before the bar took profiles has no list, and is still the version it was.
    const before = await saved(page);
    expect(before.version).toBe(2);
    expect(before.favoriteLinks).toBeUndefined();

    const row = await paletteProfileRow(page, lang);
    await row.click({ button: "right" });
    await expect(
      page.getByRole("menu", { name: lang === "pt-BR" ? "Opções do perfil" : "Profile options" }),
    ).toBeVisible();
    await menuItem(page, words.add).click();
    // The palette stays open and the keyboard is back in its search box.
    await expect(palette(page)).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(palette(page).getByRole("combobox")).toBeFocused();
    await expect(tile(page, words.profile)).toBeVisible();
    await expect(hint(page)).toHaveCount(0);
    await expect(tile(page, words.profile)).toHaveAttribute("data-nr-kind", "profile");
    await expect.poll(async () => (await saved(page)).favoriteLinks).toEqual([PWSH_LINK]);
    expect((await saved(page)).version).toBe(2);
    expect((await saved(page)).favorites).toEqual([]);

    // The row now offers to take it out, and does.
    await row.click({ button: "right" });
    await expect(menuItem(page, words.remove)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette(page)).toBeHidden();

    // A click opens a new tab that starts the profile.
    const count = await tabList(page).getByRole("treeitem").count();
    await tile(page, words.profile).click();
    await expect(tabList(page).getByRole("treeitem")).toHaveCount(count + 1);
    await expect
      .poll(async () => (await sessionStarts(page)).map((s) => s.profileId))
      .toContain("pwsh");

    // The same bar after a reload.
    await page.reload();
    await expect(tabRow(page, "api")).toBeVisible();
    await expect(tile(page, words.profile)).toBeVisible();
    await expect.poll(async () => (await saved(page)).favoriteLinks).toEqual([PWSH_LINK]);

    // The right click of the tile takes it out, and the line that teaches comes back.
    await tile(page, words.profile).click({ button: "right" });
    await expect(
      page.getByRole("menu", {
        name: lang === "pt-BR" ? "Opções do favorito" : "Favorite options",
      }),
    ).toBeVisible();
    await menuItem(page, words.remove).click();
    await expect(tiles(page)).toHaveCount(0);
    await expect(hint(page)).toBeVisible();
    await expect.poll(async () => (await saved(page)).favoriteLinks).toEqual([]);
    await page.reload();
    await expect(tabRow(page, "api")).toBeVisible();
    await expect(tiles(page)).toHaveCount(0);
    await expect(hint(page)).toBeVisible();
  });

  test(`an action is put in the bar with the right click of its row, runs from the bar after the first-run question, survives a reload and is taken out with the right click of its tile (${lang})`, async ({
    page,
  }) => {
    const words = await start(page, lang);
    await expect(actionRow(page, "Dev server")).toBeVisible();

    await actionRow(page, "Dev server").click({ button: "right" });
    await expect(
      page.getByRole("menu", { name: lang === "pt-BR" ? "Opções da ação" : "Action options" }),
    ).toBeVisible();
    await menuItem(page, words.add).click();
    await expect(tile(page, words.run)).toBeVisible();
    await expect(tile(page, words.run)).toHaveAttribute("data-nr-kind", "action");
    await expect(hint(page)).toHaveCount(0);
    await expect.poll(async () => (await saved(page)).favoriteLinks).toEqual([DEV_LINK]);
    // Nothing ran because it was put in the bar.
    await expect(tabRow(page, "dev")).toHaveCount(0);

    // The first run asks, as the Start button does, and then the command is typed in the named tab.
    await tile(page, words.run).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText("Dev server");
    await expect(dialog(page).locator("pre")).toHaveText("pnpm dev");
    await expect(tabRow(page, "dev")).toHaveCount(0);
    await dialog(page).getByRole("button", { name: words.runButton, exact: true }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(tabRow(page, "dev")).toBeVisible();
    await expect.poll(() => typed(page)).toContain("pnpm dev");
    // While it runs the tile says it shows the tab, and a click shows it without typing it again.
    await expect(tile(page, words.show)).toHaveAttribute("data-nr-state", "running");
    await tabRow(page, "api").click();
    await expect(tabRow(page, "api")).toHaveAttribute("aria-current", "true");
    await tile(page, words.show).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(tabRow(page, "dev")).toHaveAttribute("aria-current", "true");
    await expect(tabList(page).getByRole("treeitem", { name: "dev", exact: true })).toHaveCount(1);
    expect((await typed(page)).match(/pnpm dev/g)?.length ?? 0).toBe(1);

    // The same bar after a reload (the file is read again for the tile).
    await page.reload();
    await expect(tabRow(page, "api")).toBeVisible();
    await expect(tiles(page)).toHaveCount(1);
    await expect(tiles(page).first()).toHaveAttribute("data-nr-kind", "action");
    await expect.poll(async () => (await saved(page)).favoriteLinks).toEqual([DEV_LINK]);

    // The row now offers to take it out; so does the tile, which does.
    await actionRow(page, "Dev server").click({ button: "right" });
    await expect(menuItem(page, words.remove)).toBeVisible();
    await page.keyboard.press("Escape");
    await tiles(page).first().click({ button: "right" });
    await menuItem(page, words.remove).click();
    await expect(tiles(page)).toHaveCount(0);
    await expect.poll(async () => (await saved(page)).favoriteLinks).toEqual([]);
    await page.reload();
    await expect(tabRow(page, "api")).toBeVisible();
    await expect(tiles(page)).toHaveCount(0);
  });
}

test("the bar keeps the favorite tabs first and then the profiles and actions in the order they were added", async ({
  page,
}) => {
  const words = await start(page, "en", { links: [DEV_LINK, PWSH_LINK] });
  await expect(tiles(page)).toHaveCount(2);
  await tabRow(page, "scratch").click({ button: "right" });
  await menuItem(page, words.add).click();
  await expect(tiles(page)).toHaveCount(3);
  await expect(tiles(page).nth(0)).toHaveAttribute("data-nr-kind", "tab");
  await expect(tiles(page).nth(1)).toHaveAttribute("data-nr-kind", "action");
  await expect(tiles(page).nth(2)).toHaveAttribute("data-nr-kind", "profile");
  await expect.poll(async () => (await saved(page)).favorites).toEqual(["i6"]);
  expect((await saved(page)).favoriteLinks?.map((link) => link.kind)).toEqual([
    "action",
    "profile",
  ]);
});

test("adding what is already in the bar adds nothing, and the same action id of another space is another tile", async ({
  page,
}) => {
  const words = await start(page, "en", { links: [DEV_LINK], otherActions: true });
  await actionRow(page, "Dev server").click({ button: "right" });
  // It is in the bar, so the menu offers to take it out and not to add it again.
  await expect(menuItem(page, words.add)).toHaveCount(0);
  await expect(menuItem(page, words.remove)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await saved(page)).favoriteLinks).toEqual([DEV_LINK]);
});

test("an action of a space that is not on screen is in the bar and runs there, with the question and its space", async ({
  page,
}) => {
  const other = { kind: "action", spaceId: "s2", actionId: "lint", label: "Lint" };
  await start(page, "en", { links: [other], otherActions: true });
  await expect(tile(page, "Run Lint")).toBeVisible();
  await expect(tile(page, "Run Lint")).not.toHaveAttribute("aria-disabled", "true");
  // The bar is the same in the other space.
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await expect(tabRow(page, "elsewhere")).toBeVisible();
  await expect(tile(page, "Run Lint")).toBeVisible();
  await page.getByRole("button", { name: "Main", exact: true }).click();
  await expect(tabRow(page, "api")).toBeVisible();

  await tile(page, "Run Lint").click();
  await expect(dialog(page)).toContainText("Lint");
  await expect(dialog(page).locator("pre")).toHaveText("pnpm lint");
  await dialog(page).getByRole("button", { name: "Run", exact: true }).click();
  // Its space comes on screen and the named tab opens in it.
  await expect(tabRow(page, "lint")).toBeVisible();
  await expect(tabRow(page, "elsewhere")).toBeVisible();
  await expect(tabRow(page, "api")).toHaveCount(0);
  await expect.poll(() => typed(page)).toContain("pnpm lint");
});

test("a profile the computer does not have any more stays, unavailable, says why when clicked and opens no tab", async ({
  page,
}) => {
  const gone = { kind: "profile", profileId: "old-shell", label: "Old shell" };
  await start(page, "en", { links: [gone, PWSH_LINK] });
  const lost = tile(page, "New Old shell tab");
  await expect(lost).toBeVisible();
  await expect(lost).toHaveAttribute("aria-disabled", "true");
  await expect(lost).toHaveAttribute("data-nr-state", "unavailable");
  const reason = 'The profile "Old shell" is not available any more.';
  await expect(lost).toHaveAttribute("title", reason);
  // The reason is its description, for a screen reader.
  await expect(lost).toHaveAccessibleDescription(reason);
  // The one the computer has is not affected.
  await expect(tile(page, "New PowerShell tab")).not.toHaveAttribute("aria-disabled", "true");

  const count = await tabList(page).getByRole("treeitem").count();
  const starts = (await sessionStarts(page)).length;
  // Playwright counts aria-disabled as not enabled, so the click is forced: it is what a person does.
  await lost.click({ force: true });
  await expect(notice(page)).toHaveText(reason);
  await expect(tabList(page).getByRole("treeitem")).toHaveCount(count);
  // No shell was started in its place, not even the default one.
  expect((await sessionStarts(page)).length).toBe(starts);
  // It can still be taken out.
  await lost.click({ button: "right", force: true });
  await menuItem(page, "Remove from favorites").click();
  await expect(lost).toHaveCount(0);
  await expect(tile(page, "New PowerShell tab")).toBeVisible();
});

test("an action the file no longer declares is unavailable with the reason, and a click runs nothing, not even another action", async ({
  page,
}) => {
  await start(page, "en", { links: [DEV_LINK] });
  const dev = tile(page, "Run Dev server");
  await expect(dev).toBeVisible();
  await expect(dev).not.toHaveAttribute("aria-disabled", "true");

  // The file drops "dev" and keeps another action: the tile must not run that one in its place.
  const without = JSON.stringify({
    actions: [{ id: "loop", label: "Loop", command: "loop", tab: "loop" }],
  });
  await changeActionsFile(page, ACTIONS_CWD, without);
  const reason = '"Dev server" is no longer in the .noren/actions.json of Main.';
  const gone = tile(page, "Run Dev server");
  await expect(gone).toHaveAttribute("aria-disabled", "true", { timeout: 8000 });
  await expect(gone).toHaveAttribute("data-nr-state", "unavailable");
  await expect(gone).toHaveAttribute("title", reason);
  await expect(gone).toHaveAccessibleDescription(reason);

  const runs = await page.evaluate(() => (window as HookWindow).__norenTest?.commandRuns() ?? []);
  const linesBefore = await typed(page);
  await gone.click({ force: true });
  await expect(notice(page)).toHaveText(reason);
  await expect(dialog(page)).toHaveCount(0);
  await expect(tabRow(page, "dev")).toHaveCount(0);
  await expect(tabRow(page, "loop")).toHaveCount(0);
  expect(await typed(page)).toBe(linesBefore);
  expect(
    await page.evaluate(() => (window as HookWindow).__norenTest?.commandRuns() ?? []),
  ).toEqual(runs);

  // The link is still in the file of the state, and the tile comes back when the file has it again.
  await expect.poll(async () => (await saved(page)).favoriteLinks).toEqual([DEV_LINK]);
  await changeActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
  await expect(tile(page, "Run Dev server")).not.toHaveAttribute("aria-disabled", "true", {
    timeout: 8000,
  });
  await tile(page, "Run Dev server").click();
  await expect(dialog(page).locator("pre")).toHaveText("pnpm dev");
});

test("a file that is missing, not valid or changes the command: the tile says why, or asks again", async ({
  page,
}) => {
  await start(page, "en", { links: [DEV_LINK] });
  await expect(tile(page, "Run Dev server")).toBeVisible();

  await changeActionsFile(page, ACTIONS_CWD, "{ not json");
  await expect(tile(page, "Run Dev server")).toHaveAttribute(
    "title",
    "The .noren/actions.json of Main is not valid.",
    { timeout: 8000 },
  );

  await page.evaluate(
    (key) => window.localStorage.setItem(key, JSON.stringify({})),
    WEB_ACTIONS_KEY,
  );
  await expect(tile(page, "Run Dev server")).toHaveAttribute(
    "title",
    "There is no .noren/actions.json in Main.",
    { timeout: 8000 },
  );
  await tile(page, "Run Dev server").click({ force: true });
  await expect(notice(page)).toHaveText("There is no .noren/actions.json in Main.");

  // The command in the file changes: the tile runs what the file says now, after asking again.
  const changed = JSON.stringify({
    actions: [{ id: "dev", label: "Dev server", command: "pnpm dev --host", tab: "dev" }],
  });
  await changeActionsFile(page, ACTIONS_CWD, changed);
  await expect(tile(page, "Run Dev server")).not.toHaveAttribute("aria-disabled", "true", {
    timeout: 8000,
  });
  await tile(page, "Run Dev server").click();
  await expect(dialog(page).locator("pre")).toHaveText("pnpm dev --host");
});

test("the menu key and Shift+F10 open the menu of the highlighted profile row, and Escape closes it back to the search box", async ({
  page,
}) => {
  const words = await start(page, "en");
  await paletteProfileRow(page, "en");
  await page.keyboard.press("ContextMenu");
  await expect(page.getByRole("menu", { name: "Profile options" })).toBeVisible();
  await expect(menuItem(page, words.add)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole("combobox")).toBeFocused();

  await page.keyboard.press("Shift+F10");
  await menuItem(page, words.add).click();
  await expect(tile(page, "New PowerShell tab")).toBeVisible();
  await expect.poll(async () => (await saved(page)).favoriteLinks).toEqual([PWSH_LINK]);
});

test("a row of the palette that is not a profile has no menu", async ({ page }) => {
  await start(page, "en");
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await palette(page).locator('[data-nr-kind="tab"]').first().click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(palette(page)).toBeVisible();
});

test("Shift+F10 on the Start button of an action opens its menu", async ({ page }) => {
  const words = await start(page, "en");
  await header(page).getByRole("button", { name: words.start, exact: true }).focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "Action options" })).toBeVisible();
  await menuItem(page, words.add).click();
  await expect(tile(page, words.run)).toBeVisible();
});

test.describe("axe", () => {
  for (const lang of ["en", "pt-BR"] as const) {
    for (const mode of ["dark", "light"] as const) {
      test(`the bar with the three kinds of tile and one that is unavailable has no violation (${lang}, ${mode})`, async ({
        page,
      }) => {
        const gone = { kind: "profile", profileId: "old-shell", label: "Old shell" };
        await start(page, lang, { mode, links: [DEV_LINK, PWSH_LINK, gone] });
        await tabRow(page, "scratch").click({ button: "right" });
        await menuItem(page, WORDS[lang].add).click();
        await expect(tiles(page)).toHaveCount(4);
        await expect(bar(page).locator('[data-nr-state="unavailable"]')).toHaveCount(1);
        await expectNoAxeViolations(page, `the bar with three kinds of tile, ${lang}, ${mode}`);
      });

      test(`the menus of a profile row, an action row and a tile have no violation (${lang}, ${mode})`, async ({
        page,
      }) => {
        const words = await start(page, lang, { mode });
        await actionRow(page, "Dev server").click({ button: "right" });
        await expect(menuItem(page, words.add)).toBeVisible();
        await expectNoAxeViolations(page, `the menu of an action row, ${lang}, ${mode}`);
        await menuItem(page, words.add).click();

        const row = await paletteProfileRow(page, lang);
        await row.click({ button: "right" });
        await expect(menuItem(page, words.add)).toBeVisible();
        await expectNoAxeViolations(page, `the menu of a profile row, ${lang}, ${mode}`);
        await menuItem(page, words.add).click();
        await page.keyboard.press("Escape");

        await tile(page, words.run).click({ button: "right" });
        await expect(menuItem(page, words.remove)).toBeVisible();
        await expectNoAxeViolations(page, `the menu of a tile, ${lang}, ${mode}`);
      });
    }
  }
});
