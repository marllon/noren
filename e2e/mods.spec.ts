import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  configText,
  openSettings,
  saveSettings,
  seedConfig,
  settingsScreen,
} from "./settings-fixture";

// Mods: CSS files of the user in the `mods/` folder (the web build keeps them in the browser
// storage under `noren.web.mods`). They are turned on for every space in the settings screen, in an
// order, or for one space in the menu of the space; they reload while the app runs; and every one
// is put in `@layer mods`, which comes after the layers of Noren, so a plain selector in a mod beats
// the style of the app. The mods used below are the examples of the repository (`examples/mods/`).

interface Hook {
  paneIds(): string[];
  setMod(name: string, text: string | null): void;
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook; __stillHere?: boolean };

const WEB_MODS_KEY = "noren.web.mods";
const WEB_STATE_KEY = "noren.web.state";

const example = (name: string): string =>
  readFileSync(new URL(`../examples/mods/${name}`, import.meta.url), "utf8");

const TINTED = "tinted-sidebar.css";
const ACCENT = "accent-bar.css";
const DIM = "dim-unfocused.css";

/** Puts the files in the mods folder before the page loads (only on the first load of a test). */
async function seedMods(page: Page, files: Record<string, string>): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_MODS_KEY, value: JSON.stringify(files) },
  );
}

const examples = (): Record<string, string> => ({
  [TINTED]: example(TINTED),
  [ACCENT]: example(ACCENT),
  [DIM]: example(DIM),
});

async function start(page: Page, files: Record<string, string>, config: string | null = null) {
  await seedMods(page, files);
  if (config !== null) await seedConfig(page, config);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  // Marks this document: it is gone if the page reloads.
  await page.evaluate(() => {
    (window as HookWindow).__stillHere = true;
  });
}

const stillHere = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as HookWindow).__stillHere === true);

const sidebar = (page: Page): Locator => page.locator('[data-nr-part="sidebar"]');
/** One computed property of the first element matching `selector`. */
const computed = (page: Page, selector: string, property: string): Promise<string> =>
  page.evaluate(
    ({ selector, property }) => {
      const element = document.querySelector(selector);
      return element === null ? "" : getComputedStyle(element).getPropertyValue(property);
    },
    { selector, property },
  );
const sidebarBackground = (page: Page): Promise<string> =>
  computed(page, '[data-nr-part="sidebar"]', "background-color");

const modStyles = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll("style[data-nr-mod]")].map(
      (element) => element.getAttribute("data-nr-mod") ?? "",
    ),
  );
const modStyle = (page: Page, name: string): Promise<string | null> =>
  page.evaluate(
    (n) => document.querySelector(`style[data-nr-mod="${n}"]`)?.textContent ?? null,
    name,
  );

const savedConfig = async (page: Page): Promise<string> => (await configText(page)) ?? "";

const modRow = (screen: Locator, name: string): Locator =>
  screen.getByRole("checkbox", { name, exact: true });

/** Opens the settings screen, lets `change` touch the Mods section, and saves. */
async function changeMods(page: Page, change: (screen: Locator) => Promise<void>): Promise<void> {
  const screen = await openSettings(page);
  await change(screen);
  await saveSettings(page);
}

const modsNotice = (page: Page): Locator => page.locator('[data-nr-part="mods-notice"]');

const switcher = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string): Locator =>
  switcher(page).getByRole("button", { name, exact: true });
const menu = (page: Page, spaceName: string): Locator =>
  page.getByRole("menu", { name: `${spaceName} options`, exact: true });

/**
 * The entry of a mod in the menu of a space. Found by its text and not by its name for the
 * accessibility tree: the check mark of a mod that is on is drawn in front of the name by the style.
 */
const modItem = (inMenu: Locator, name: string): Locator =>
  inMenu.locator('[role="menuitemcheckbox"]', { hasText: name });

/** Every mod in the menu of a space; the switch of the AI of the space is a checkbox item too, and is not one. */
const modItems = (inMenu: Locator): Locator =>
  inMenu.getByRole("menuitemcheckbox").filter({ hasNotText: "AI in this space" });

/** Two spaces, "Main" and "Work", with "Work" active. */
async function addWorkSpace(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Work");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(spaceButton(page, "Work")).toHaveAttribute("data-nr-state", "active");
}

async function openSpaceMenu(page: Page, spaceName: string): Promise<Locator> {
  await spaceButton(page, spaceName).click({ button: "right" });
  await expect(menu(page, spaceName)).toBeVisible();
  return menu(page, spaceName);
}

/** The mods saved for a space in the state file (the web build keeps it in the browser storage). */
const savedModIds = (page: Page, spaceName: string): Promise<string[] | null> =>
  page.evaluate(
    ({ key, name }) => {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return null;
      const state = JSON.parse(raw) as { spaces: { name: string; modIds: string[] }[] };
      return state.spaces.find((space) => space.name === name)?.modIds ?? null;
    },
    { key: WEB_STATE_KEY, name: spaceName },
  );

test.describe("the Mods section of the settings screen", () => {
  test("lists the files of the folder, none on, and says so when the folder is empty", async ({
    page,
  }) => {
    await start(page, examples());
    const screen = await openSettings(page);
    const section = screen.getByRole("region", { name: "Mods", exact: true });
    await expect(section.getByRole("checkbox")).toHaveCount(3);
    for (const name of [ACCENT, DIM, TINTED]) await expect(modRow(section, name)).not.toBeChecked();
    // In the order of the file names.
    await expect(section.locator('[data-nr-part="settings-mod"]')).toHaveText([
      ACCENT,
      DIM,
      TINTED,
    ]);
    // Nothing is on, so nothing has an order to change.
    await expect(section.getByRole("button", { name: /^Move /i })).toHaveCount(0);
    expect(await modStyles(page)).toEqual([]);
  });

  test("an empty folder says where to put a file", async ({ page }) => {
    await start(page, {});
    const screen = await openSettings(page);
    await expect(screen.getByText("No mods yet.", { exact: false })).toBeVisible();
  });

  test("turning a mod on changes the computed style of the sidebar, turning it off puts it back", async ({
    page,
  }) => {
    await start(
      page,
      examples(),
      '// my settings\n{\n  // keep me\n  "keybindings": { "preset": "safe" },\n}\n',
    );
    const before = await sidebarBackground(page);
    const borderBefore = await computed(page, '[data-nr-part="sidebar"]', "border-right-color");

    await changeMods(page, (screen) => modRow(screen, TINTED).check());
    await expect.poll(() => sidebarBackground(page)).not.toBe(before);
    expect(await computed(page, '[data-nr-part="sidebar"]', "border-right-color")).not.toBe(
      borderBefore,
    );
    // The file says so, the comments are still there, and the page did not reload.
    const written = await savedConfig(page);
    expect(written).toContain(`"mods": ["${TINTED}"]`);
    expect(written).toContain("// my settings");
    expect(written).toContain("// keep me");
    expect(await modStyles(page)).toEqual([TINTED]);
    expect(await stillHere(page)).toBe(true);

    await changeMods(page, (screen) => modRow(screen, TINTED).uncheck());
    await expect.poll(() => sidebarBackground(page)).toBe(before);
    expect(await computed(page, '[data-nr-part="sidebar"]', "border-right-color")).toBe(
      borderBefore,
    );
    expect(await modStyles(page)).toEqual([]);
    expect(await savedConfig(page)).toContain('"mods": []');
    expect(await stillHere(page)).toBe(true);
  });

  test("a change in the screen is a draft until Save", async ({ page }) => {
    await start(page, examples());
    const before = await sidebarBackground(page);
    const screen = await openSettings(page);
    await modRow(screen, TINTED).check();
    await expect(modRow(screen, TINTED)).toBeChecked();
    expect(await sidebarBackground(page)).toBe(before);
    await screen.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(settingsScreen(page)).toHaveCount(0);
    expect(await sidebarBackground(page)).toBe(before);
    expect(await configText(page)).toBeNull();
  });

  test("the mods that are on keep their order, and the last one wins", async ({ page }) => {
    const loud = '[data-nr-part="sidebar"] { opacity: 0.5; }\n';
    const quiet = '[data-nr-part="sidebar"] { opacity: 0.6; }\n';
    await start(page, { "a-loud.css": loud, "b-quiet.css": quiet });

    await changeMods(page, async (screen) => {
      await modRow(screen, "a-loud.css").check();
      await modRow(screen, "b-quiet.css").check();
    });
    expect(await modStyles(page)).toEqual(["a-loud.css", "b-quiet.css"]);
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.6");
    expect(await savedConfig(page)).toContain('"mods": ["a-loud.css", "b-quiet.css"]');

    // Move the first one later: the other one is applied first now, so "loud" wins.
    await changeMods(page, async (screen) => {
      await screen.getByRole("button", { name: "Move a-loud.css later", exact: true }).click();
      await expect(screen.locator('[data-nr-part="settings-mod"]').first()).toContainText(
        "b-quiet.css",
      );
    });
    expect(await modStyles(page)).toEqual(["b-quiet.css", "a-loud.css"]);
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.5");
    expect(await savedConfig(page)).toContain('"mods": ["b-quiet.css", "a-loud.css"]');
    expect(await stillHere(page)).toBe(true);
  });

  test("the order is read from the file too, and a file edited by hand applies at once", async ({
    page,
  }) => {
    await start(page, { "a-loud.css": '[data-nr-part="sidebar"] { opacity: 0.5; }', "b.css": "" });
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setConfig('{ "mods": ["b.css", "a-loud.css"] }'),
    );
    await expect.poll(() => modStyles(page)).toEqual(["b.css", "a-loud.css"]);
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.5");
    expect(await stillHere(page)).toBe(true);
  });
});

test.describe("what the mods are put in", () => {
  test("every mod is wrapped in @layer mods, declared after the layers of the app", async ({
    page,
  }) => {
    await start(page, examples(), '{ "mods": ["tinted-sidebar.css", "accent-bar.css"] }');
    await expect.poll(() => modStyles(page)).toEqual([TINTED, ACCENT]);
    const text = await modStyle(page, TINTED);
    expect(text).toContain("@layer vendor, base, mods;");
    expect(text).toContain("@layer mods {");
    // The browser parsed each as one statement for the order and one block named "mods", nothing else.
    const parsed = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLStyleElement>("style[data-nr-mod]")].map((element) =>
        [...(element.sheet?.cssRules ?? [])].map((rule) =>
          rule instanceof CSSLayerBlockRule ? `block:${rule.name}` : rule.constructor.name,
        ),
      ),
    );
    expect(parsed).toEqual([
      ["CSSLayerStatementRule", "block:mods"],
      ["CSSLayerStatementRule", "block:mods"],
    ]);
  });

  test("a mod with a plain selector beats the style of the app, whatever its specificity", async ({
    page,
  }) => {
    // Compact density has a selector three times as specific as the one in the mod.
    const compact = '{ "appearance": { "density": "compact" } }';
    await start(
      page,
      { "roomy.css": ".tab-button { padding-left: 13px; padding-top: 11px; }" },
      compact,
    );
    const item = '[data-nr-part="item"]';
    await expect.poll(() => computed(page, item, "padding-left")).toBe("8px");

    await changeMods(page, (screen) => modRow(screen, "roomy.css").check());
    await expect.poll(() => computed(page, item, "padding-left")).toBe("13px");
    expect(await computed(page, item, "padding-top")).toBe("11px");

    await changeMods(page, (screen) => modRow(screen, "roomy.css").uncheck());
    await expect.poll(() => computed(page, item, "padding-left")).toBe("8px");
  });

  test("the variables of the theme are there for a mod to read", async ({ page }) => {
    await start(
      page,
      { "uses-variables.css": '[data-nr-part="sidebar"] { background-color: var(--nr-accent); }' },
      '{ "mods": ["uses-variables.css"] }',
    );
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--nr-accent").trim(),
    );
    expect(accent).toMatch(/^#[0-9a-f]{6}$/i);
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(accent.slice(i, i + 2), 16));
    await expect.poll(() => sidebarBackground(page)).toBe(`rgb(${r}, ${g}, ${b})`);
  });

  test("a mod that would close its layer early is ignored with a notice, the others still apply", async ({
    page,
  }) => {
    await start(
      page,
      {
        "escape.css": "} body { outline: 5px solid red; } .x {",
        "fine.css": '[data-nr-part="sidebar"] { opacity: 0.5; }',
      },
      '{ "mods": ["escape.css", "fine.css"] }',
    );
    await expect.poll(() => modStyles(page)).toEqual(["fine.css"]);
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.5");
    expect(await computed(page, "body", "outline-style")).not.toBe("solid");
    await expect(modsNotice(page)).toContainText('The mod "escape.css" is ignored');
    await expect(modsNotice(page)).toContainText("closes nothing");
  });

  test("braces inside comments, strings and addresses do not count", async ({ page }) => {
    const css = [
      "/* } stray brace in a comment */",
      '[data-nr-part="sidebar"]::after { content: "}"; background: url(data:image/svg+xml,%3Csvg%3E}%3C/svg%3E); }',
      '[data-nr-part="sidebar"] { opacity: 0.5; }',
    ].join("\n");
    await start(page, { "braces.css": css }, '{ "mods": ["braces.css"] }');
    await expect.poll(() => modStyles(page)).toEqual(["braces.css"]);
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.5");
    await expect(modsNotice(page)).toHaveCount(0);
  });

  test("no text, however hostile, takes a mod out of its layer in the browser", async ({
    page,
  }) => {
    // A few hundred texts made of the pieces CSS is easiest to confuse (braces, quotes, comments,
    // escapes, addresses, at-rules, the tokens of old HTML comments). Each one that Noren applies has
    // to be parsed by the browser as the statement of the layers and one block named "mods", and
    // nothing else at the top of its sheet. A text Noren refuses is not applied at all.
    const pieces = [
      "{",
      "}",
      "{",
      "}",
      '"',
      "'",
      "/*",
      "*/",
      "\\",
      "\\75 rl(",
      "url(",
      "URL( ",
      ")",
      "(",
      "\n",
      "\r\n",
      "a",
      " ",
      ";",
      ":",
      "@layer x {",
      "@layer mods {",
      "@media all {",
      "@import 'x.css';",
      "<!--",
      "-->",
      "U+0025",
      ".x{top:0}",
      "\u{feff}",
      "[",
      "]",
      "#",
      "@x",
      "\\7d ",
      "\\29",
      "\\\n",
      "5",
      "-",
      "e3",
      "!important",
      "\f",
      "é",
    ];
    // The same texts every run. NOREN_FUZZ_TEXTS and NOREN_FUZZ_SEED let a person look for more.
    let seed = Number(process.env["NOREN_FUZZ_SEED"] ?? 20261019) >>> 0;
    const count = Math.max(1, Number(process.env["NOREN_FUZZ_TEXTS"] ?? 240));
    const next = (bound: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };
    const texts = Array.from({ length: count }, () =>
      Array.from({ length: 1 + next(24) }, () => pieces[next(pieces.length)]).join(""),
    );

    await start(page, {});
    const BATCH = 60;
    let applied = 0;
    for (let first = 0; first < texts.length; first += BATCH) {
      const batch = texts.slice(first, first + BATCH);
      const names = batch.map((_, i) => `fuzz-${i}.css`);
      await page.evaluate(
        ({ names, batch }) => {
          const hook = (window as HookWindow).__norenTest;
          names.forEach((name, i) => hook?.setMod(name, batch[i] ?? ""));
          hook?.setConfig(JSON.stringify({ mods: names }));
        },
        { names, batch },
      );
      // The styles are in once the number of mod styles stops changing.
      await expect.poll(() => modStyles(page).then((n) => n.length)).toBeGreaterThanOrEqual(0);
      await page.waitForTimeout(150);
      const shapes = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLStyleElement>("style[data-nr-mod]")].map((element) => ({
          name: element.getAttribute("data-nr-mod"),
          rules: [...(element.sheet?.cssRules ?? [])].map((rule) =>
            rule instanceof CSSLayerBlockRule
              ? `block:${rule.name}`
              : rule instanceof CSSLayerStatementRule
                ? `statement:${rule.nameList.join(",")}`
                : rule.constructor.name,
          ),
        })),
      );
      for (const { name, rules } of shapes) {
        expect(rules, `${name}: ${JSON.stringify(batch[names.indexOf(name ?? "")])}`).toEqual([
          "statement:vendor,base,mods",
          "block:mods",
        ]);
      }
      applied += shapes.length;
      // The page itself is untouched by anything the texts say.
      expect(await computed(page, "body", "outline-style")).not.toBe("solid");
      // Out of the way for the next batch.
      await page.evaluate((names) => {
        const hook = (window as HookWindow).__norenTest;
        hook?.setConfig("{}");
        names.forEach((name) => hook?.setMod(name, null));
      }, names);
      await expect.poll(() => modStyles(page)).toEqual([]);
    }
    // Most of the texts are fine for the wrapper, so the check above was made on many styles.
    expect(applied).toBeGreaterThan(texts.length / 4);
  });
});

test.describe("reloading while the app runs", () => {
  test("a mod edited on disk applies at once, and one removed stops applying with a notice", async ({
    page,
  }) => {
    await start(
      page,
      { "live.css": '[data-nr-part="sidebar"] { opacity: 0.5; }' },
      '{ "mods": ["live.css"] }',
    );
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.5");

    // Edited with an editor: the same file, new text.
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setMod(
        "live.css",
        '[data-nr-part="sidebar"] { opacity: 0.7; }',
      ),
    );
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.7");
    expect(await modStyles(page)).toEqual(["live.css"]);

    // Deleted: ignored, the rest of the app goes on, and the notice says which one.
    await page.evaluate(() => (window as HookWindow).__norenTest?.setMod("live.css", null));
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("1");
    expect(await modStyles(page)).toEqual([]);
    await expect(modsNotice(page)).toContainText(
      'The mod "live.css" is turned on but is not in the mods folder, so it is ignored.',
    );
    expect(await stillHere(page)).toBe(true);
    await expect(sidebar(page)).toBeVisible();

    // Back again: it applies and the notice goes.
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setMod(
        "live.css",
        '[data-nr-part="sidebar"] { opacity: 0.8; }',
      ),
    );
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.8");
    await expect(modsNotice(page)).toHaveCount(0);
  });

  test("a mod that is not in the folder at the start is ignored with a notice that can be closed", async ({
    page,
  }) => {
    await start(
      page,
      { "here.css": '[data-nr-part="sidebar"] { opacity: 0.5; }' },
      '{ "mods": ["gone.css", "here.css"] }',
    );
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.5");
    expect(await modStyles(page)).toEqual(["here.css"]);
    await expect(modsNotice(page)).toContainText('The mod "gone.css" is turned on but is not');
    await modsNotice(page).getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(modsNotice(page)).toHaveCount(0);

    // The settings screen shows it, so it can be let go.
    const screen = await openSettings(page);
    const gone = screen.locator('[data-nr-part="settings-mod"]', { hasText: "gone.css" });
    await expect(gone).toContainText("not in the folder");
    await expect(modRow(screen, "gone.css")).toBeChecked();
    await modRow(screen, "gone.css").click();
    // Let go of, it has no row to come back to.
    await expect(gone).toHaveCount(0);
    await saveSettings(page);
    expect(await savedConfig(page)).toContain('"mods": ["here.css"]');
    await expect(modsNotice(page)).toHaveCount(0);
  });

  test("a folder with a file that is not a mod name leaves it out, and the app goes on", async ({
    page,
  }) => {
    await start(page, {
      "good.css": "",
      "has space.css": "a{}",
      "UPPER.CSS": "a{}",
      "con.css": "a{}",
      "notes.txt": "a{}",
    });
    const screen = await openSettings(page);
    await expect(screen.locator('[data-nr-part="settings-mod"]')).toHaveText(["good.css"]);
  });

  test("a file in the config with a name that is a path is a problem of the file, with its line", async ({
    page,
  }) => {
    await start(page, { "good.css": "" }, '{\n  "mods": ["../escape.css"]\n}\n');
    await expect(page.locator('[data-nr-part="config-notice"]')).toContainText(
      "Not a mod file name",
    );
    await expect(page.locator('[data-nr-part="config-notice"]')).toContainText("line 2");
    expect(await modStyles(page)).toEqual([]);
  });
});

test.describe("mods for one space", () => {
  test("a mod turned on for a space applies in that space only", async ({ page }) => {
    await start(page, examples());
    await addWorkSpace(page);
    const plain = await sidebarBackground(page);

    // The menu of the space lists the mods; turn one on for "Work".
    let work = await openSpaceMenu(page, "Work");
    // The mark of a mod that is on is drawn in front of its name, so the names are read as a part.
    await expect(modItems(work)).toHaveText([
      new RegExp(`${ACCENT}$`),
      new RegExp(`${DIM}$`),
      new RegExp(`${TINTED}$`),
    ]);
    await expect(modItem(work, TINTED)).toHaveAttribute("aria-checked", "false");
    await modItem(work, TINTED).click();
    // The menu stays open for the next one, and shows the new state.
    await expect(modItem(menu(page, "Work"), TINTED)).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(menu(page, "Work")).toBeHidden();

    await expect.poll(() => sidebarBackground(page)).not.toBe(plain);
    expect(await modStyles(page)).toEqual([TINTED]);
    // Not in the global settings: the file has no `mods`.
    expect(await configText(page)).toBeNull();
    await expect.poll(() => savedModIds(page, "Work")).toEqual([TINTED]);
    expect(await savedModIds(page, "Main")).toEqual([]);

    // Another space: the style is gone. Back to "Work": it is there again.
    await spaceButton(page, "Main").click();
    await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
    await expect.poll(() => sidebarBackground(page)).toBe(plain);
    expect(await modStyles(page)).toEqual([]);

    await spaceButton(page, "Work").click();
    await expect(spaceButton(page, "Work")).toHaveAttribute("data-nr-state", "active");
    await expect.poll(() => sidebarBackground(page)).not.toBe(plain);
    expect(await modStyles(page)).toEqual([TINTED]);
    expect(await stillHere(page)).toBe(true);

    // And it is kept: a reload finds the space with its mod.
    await page.reload();
    await expect(spaceButton(page, "Work")).toHaveAttribute("data-nr-state", "active");
    await expect.poll(() => sidebarBackground(page)).not.toBe(plain);
    await spaceButton(page, "Main").click();
    await expect.poll(() => sidebarBackground(page)).toBe(plain);

    // Turned off again from the menu of the space, even when it is not the active one.
    work = await openSpaceMenu(page, "Work");
    await expect(modItem(work, TINTED)).toHaveAttribute("aria-checked", "true");
    await modItem(work, TINTED).click();
    await expect.poll(() => savedModIds(page, "Work")).toEqual([]);
    await page.keyboard.press("Escape");
    await spaceButton(page, "Work").click();
    await expect.poll(() => sidebarBackground(page)).toBe(plain);
  });

  test("the mods of a space come after the global ones, and a mod on for every space cannot be turned off in the menu", async ({
    page,
  }) => {
    await start(
      page,
      {
        "global.css": '[data-nr-part="sidebar"] { opacity: 0.5; }',
        "space.css": '[data-nr-part="sidebar"] { opacity: 0.6; }',
      },
      '{ "mods": ["global.css"] }',
    );
    await addWorkSpace(page);
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.5");

    const work = await openSpaceMenu(page, "Work");
    const global = modItem(work, "global.css");
    await expect(global).toHaveAttribute("aria-checked", "true");
    await expect(global).toBeDisabled();
    await expect(global).toContainText("(all spaces)");
    await modItem(work, "space.css").click();
    await page.keyboard.press("Escape");

    // Both apply in "Work", the global one first, so the one of the space wins.
    await expect.poll(() => modStyles(page)).toEqual(["global.css", "space.css"]);
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.6");

    // In "Main" only the global one.
    await spaceButton(page, "Main").click();
    await expect.poll(() => modStyles(page)).toEqual(["global.css"]);
    await expect.poll(() => computed(page, '[data-nr-part="sidebar"]', "opacity")).toBe("0.5");
  });

  test("a space that lists a mod the folder lost shows it as missing and can let it go", async ({
    page,
  }) => {
    await start(page, { "here.css": "" });
    await addWorkSpace(page);
    let work = await openSpaceMenu(page, "Work");
    await modItem(work, "here.css").click();
    await page.keyboard.press("Escape");
    await expect.poll(() => savedModIds(page, "Work")).toEqual(["here.css"]);

    await page.evaluate(() => (window as HookWindow).__norenTest?.setMod("here.css", null));
    await expect(modsNotice(page)).toContainText('The mod "here.css" is turned on but is not');

    work = await openSpaceMenu(page, "Work");
    const stale = modItem(work, "here.css");
    await expect(stale).toContainText("(missing)");
    await stale.click();
    await expect.poll(() => savedModIds(page, "Work")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(modsNotice(page)).toHaveCount(0);
  });

  test("a folder with no mods adds nothing to the menu of a space", async ({ page }) => {
    await start(page, {});
    const main = await openSpaceMenu(page, "Main");
    await expect(modItems(main)).toHaveCount(0);
    await expect(main.getByText("Mods", { exact: true })).toHaveCount(0);
  });
});
