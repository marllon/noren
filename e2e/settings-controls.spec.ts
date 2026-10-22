import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { cancelSettings, configText, saveSettings, seedConfig } from "./settings-fixture";

// The controls of the settings screen (NOR-F20-10b): every field has the right one. A yes or no is a
// switch, a number with a range in the schema is a box with a slider beside it, a path has a button
// that opens the chooser of the system (a fake one here, which a test answers), a choice is a row of
// buttons when it has two or three short options and a drop-down list otherwise, and a color is the
// swatch and box of the theme editor. What a person can see (the picture, the sidebar, the tabs, the
// font and the cursor of the terminal, the three sliders of the window) shows in the window at once
// as a preview, Cancel takes it back and Save writes it. Everything runs on the fake backend.

interface Drawing {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: string;
  cursorBlink: boolean;
}

interface Hook {
  paneIds(): string[];
  terminalDrawing(): Drawing | undefined;
  setPathPick(path: string | null): void;
  failPathPick(message: string): void;
  pathPickCalls(): { kind: string; title: string }[];
  setImagePick(path: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

/** The fixture picture and the path the web build serves it under (`noren.web.images`). */
const FIXTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));
const PICTURE = "fixtures/background.png";

type Language = "en" | "pt-BR";
type Mode = "dark" | "light";

const THEME: Record<Mode, string> = { dark: "noren-dusk", light: "noren-paper" };
const SETTINGS_NAME: Record<Language, string> = { en: "Settings", "pt-BR": "Configurações" };

function fileFor(language: Language, mode: Mode, extra = ""): string {
  const lang = language === "pt-BR" ? '"language": "pt-BR", ' : "";
  return `{ ${lang}"appearance": { "theme": "${THEME[mode]}" }${extra} }\n`;
}

async function start(
  page: Page,
  options: { language?: Language; mode?: Mode; file?: string } = {},
): Promise<Locator> {
  const language = options.language ?? "en";
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: "noren.web.images", value: JSON.stringify({ [PICTURE]: FIXTURE.toString("base64") }) },
  );
  await seedConfig(page, options.file ?? fileFor(language, options.mode ?? "dark"));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  await page.getByRole("button", { name: SETTINGS_NAME[language], exact: true }).click();
  const screen = page.getByRole("dialog", { name: SETTINGS_NAME[language], exact: true });
  await expect(screen).toBeVisible();
  return screen;
}

const rowOf = (screen: Locator, key: string): Locator => screen.locator(`[data-nr-row="${key}"]`);
const body = (page: Page): Locator => page.locator(".app-body");
const sidebar = (page: Page): Locator => page.locator('[data-nr-part="sidebar"]');
const save = (screen: Locator): Locator =>
  screen.getByRole("button", { name: "Save", exact: true });
const pictureLayer = (page: Page): Locator => page.locator('[data-nr-part="background"]');
const drawing = (page: Page): Promise<Drawing | undefined> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.terminalDrawing());
const pathPicks = (page: Page): Promise<{ kind: string; title: string }[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.pathPickCalls() ?? []);

/** The rows with a number that has a range in the schema: the row, the box, the slider and the range. */
const RANGES = [
  { row: "appearance.width", slider: "Sidebar width", min: 180, max: 480, step: 1, over: "9999" },
  {
    row: "window.opacity",
    slider: "Interface opacity",
    min: 0.3,
    max: 1,
    step: 0.01,
    over: "5",
  },
  { row: "background.opacity", slider: "Image opacity", min: 0, max: 1, step: 0.01, over: "3" },
  { row: "background.blur", slider: "Image blur", min: 0, max: 100, step: 1, over: "500" },
  { row: "terminal.fontSize", slider: "Font size", min: 6, max: 72, step: 1, over: "500" },
  { row: "terminal.lineHeight", slider: "Line height", min: 1, max: 3, step: 0.05, over: "9" },
  {
    row: "terminal.scrollback",
    slider: "Scrollback",
    min: 0,
    max: 100000,
    step: 100,
    over: "999999",
  },
  { row: "terminal.maxPanes", slider: "Panes per tab", min: 2, max: 16, step: 1, over: "99" },
] as const;

test.describe("the switch", () => {
  test("every yes or no of the screen is a switch, and no plain check box is left", async ({
    page,
  }) => {
    const screen = await start(page);
    await expect(screen.locator('input[type="checkbox"]:not([role="switch"])')).toHaveCount(0);
    const names = await screen
      .getByRole("switch")
      .evaluateAll((all) =>
        all.map((element) => element.closest("label")?.textContent?.trim() ?? ""),
      );
    expect(names).toEqual(
      expect.arrayContaining([
        "Compact mode",
        "Keep sidebar open",
        "Pane headers",
        "Font ligatures",
        "Cursor blinks",
        "Screen reader mode",
        "System notifications",
        "Archive idle tabs",
        "Turn the AI on",
        "Push when Noren closes",
      ]),
    );
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  test("a click and the Space key turn it, and a screen reader hears its state", async ({
    page,
  }) => {
    const screen = await start(page);
    const row = rowOf(screen, "appearance.paneHeaders");
    await row.scrollIntoViewIfNeeded();
    const pane = row.getByRole("switch", { name: "Pane headers", exact: true });
    await expect(pane).not.toBeChecked();
    await expect(save(screen)).toBeDisabled();

    await pane.click();
    await expect(pane).toBeChecked();
    await expect(save(screen)).toBeEnabled();

    // The keyboard: Space on the focused switch turns it back.
    await pane.focus();
    await page.keyboard.press("Space");
    await expect(pane).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(pane).toBeChecked();
    // Its role is a switch, and the checked state is the one a screen reader reads.
    expect(await pane.evaluate((element) => element.getAttribute("role"))).toBe("switch");
    expect(await pane.evaluate((element) => (element as HTMLInputElement).checked)).toBe(true);
  });

  test("it is drawn as a switch: a track and a knob that moves, in the color of the theme", async ({
    page,
  }) => {
    const screen = await start(page);
    const pane = rowOf(screen, "appearance.paneHeaders").getByRole("switch");
    await pane.scrollIntoViewIfNeeded();
    const facts = () =>
      pane.evaluate((element) => {
        const track = getComputedStyle(element);
        const knob = getComputedStyle(element, "::after");
        const root = getComputedStyle(document.documentElement);
        const accent = root.getPropertyValue("--nr-accent").trim();
        const probe = document.createElement("i");
        probe.style.color = accent;
        document.body.append(probe);
        const accentRgb = getComputedStyle(probe).color;
        probe.remove();
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          track: track.backgroundColor,
          knobMove: knob.transform,
          accentRgb,
          radius: track.borderTopLeftRadius,
        };
      });
    const off = await facts();
    expect([off.width, off.height]).toEqual([40, 24]);
    expect(off.knobMove).toBe("none");
    expect(off.track).not.toBe(off.accentRgb);
    expect(parseFloat(off.radius)).toBeGreaterThanOrEqual(12);
    await pane.click();
    // The knob slides (120 ms); wait for it to arrive, then read it.
    await expect.poll(async () => (await facts()).knobMove).toBe("matrix(1, 0, 0, 1, 16, 0)");
    const on = await facts();
    expect(on.track).toBe(on.accentRgb);
  });

  test("a switch that cannot be used now is off and cannot be turned (Keep sidebar open without compact mode)", async ({
    page,
  }) => {
    const screen = await start(page);
    const keep = rowOf(screen, "appearance.keepOpen").getByRole("switch");
    await expect(keep).toBeDisabled();
    const compact = rowOf(screen, "appearance.compact").getByRole("switch");
    await compact.click();
    await expect(keep).toBeEnabled();
    await keep.click();
    await expect(keep).toBeChecked();
  });

  test("Save writes what the switches say", async ({ page }) => {
    const screen = await start(page);
    await rowOf(screen, "appearance.paneHeaders").getByRole("switch").click();
    const blinks = rowOf(screen, "terminal.cursorBlinks").getByRole("switch");
    await blinks.scrollIntoViewIfNeeded();
    await blinks.click();
    await saveSettings(page);
    const text = (await configText(page)) ?? "";
    expect(text).toContain('"paneHeaders": true');
    expect(text).toContain('"blink": false');
  });

  test("the switches of a list (the mods) are switches too, with the order buttons beside them", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      if (window.localStorage.getItem("noren.web.mods") === null) {
        window.localStorage.setItem(
          "noren.web.mods",
          JSON.stringify({ "quiet.css": "body {}", "loud.css": "body {}" }),
        );
      }
    });
    const screen = await start(page);
    const mods = screen.locator('[data-nr-part="settings-mod"]');
    await expect(mods).toHaveCount(2);
    await expect(mods.getByRole("switch")).toHaveCount(2);
    await mods.first().getByRole("switch").click();
    await expect(mods.first().getByRole("switch")).toBeChecked();
  });
});

test.describe("the slider beside a box", () => {
  test("every number that has a range in the schema has one, over the range of the schema", async ({
    page,
  }) => {
    const screen = await start(page);
    for (const range of RANGES) {
      const row = rowOf(screen, range.row);
      await row.scrollIntoViewIfNeeded();
      const slider = row.getByRole("slider", { name: range.slider, exact: true });
      await expect(slider, range.row).toHaveAttribute("min", String(range.min));
      await expect(slider, range.row).toHaveAttribute("max", String(range.max));
      await expect(slider, range.row).toHaveAttribute("step", String(range.step));
      await expect(row.getByRole("textbox"), range.row).toHaveCount(1);
    }
  });

  test("the numbers that have no top in the schema, and a port, have a box alone", async ({
    page,
  }) => {
    const screen = await start(page);
    for (const key of ["notifications.longCommand", "archive.after"]) {
      const row = rowOf(screen, key);
      await row.scrollIntoViewIfNeeded();
      await expect(row.getByRole("textbox"), key).toHaveCount(1);
      await expect(row.getByRole("slider"), key).toHaveCount(0);
    }
    await screen.getByRole("button", { name: "Add SSH profile", exact: true }).click();
    const port = screen.getByRole("textbox", { name: "Port (optional)", exact: true });
    await expect(port).toBeVisible();
    await expect(
      screen.locator('[data-nr-part="settings-profile"]').getByRole("slider"),
    ).toHaveCount(0);
  });

  test("the box is on the left, the slider on its right, on one line, inside the control column", async ({
    page,
  }) => {
    const screen = await start(page);
    for (const range of RANGES) {
      const row = rowOf(screen, range.row);
      await row.scrollIntoViewIfNeeded();
      const box = await row.getByRole("textbox").boundingBox();
      const slider = await row.getByRole("slider").boundingBox();
      if (box === null || slider === null) throw new Error(range.row);
      expect(box.x + box.width, range.row).toBeLessThanOrEqual(slider.x);
      expect(
        Math.abs(box.y + box.height / 2 - (slider.y + slider.height / 2)),
        range.row,
      ).toBeLessThan(4);
      expect(box.width, range.row).toBe(112);
      // The two together are the control column: 320 px, which starts where the other controls do.
      expect(Math.round(slider.x + slider.width - box.x), range.row).toBe(320);
    }
  });

  for (const range of RANGES) {
    test(`${range.row}: the keys of the slider move the box (Home, End, arrows), inside the range`, async ({
      page,
    }) => {
      const screen = await start(page);
      const row = rowOf(screen, range.row);
      await row.scrollIntoViewIfNeeded();
      const box = row.getByRole("textbox");
      const slider = row.getByRole("slider");
      await slider.focus();
      // The handle may already stand at the top (the interface opacity does): then End moves nothing
      // and the box stays as it is, so only the handle is read here.
      await page.keyboard.press("End");
      await expect(slider).toHaveValue(String(range.max));
      await page.keyboard.press("Home");
      await expect(slider).toHaveValue(String(range.min));
      await expect(box).toHaveValue(String(range.min));
      await page.keyboard.press("ArrowRight");
      const stepped = Number((range.min + range.step).toFixed(2));
      await expect(box).toHaveValue(String(stepped));
      await page.keyboard.press("ArrowLeft");
      await expect(box).toHaveValue(String(range.min));
      await page.keyboard.press("End");
      await expect(box).toHaveValue(String(range.max));
      await expect(slider).toHaveValue(String(range.max));
      await page.keyboard.press("ArrowRight");
      // The handle cannot pass the top of the range: the box is still the top.
      await expect(box).toHaveValue(String(range.max));
      // No problem is told for any value the keys can reach.
      await expect(row.getByRole("alert")).toHaveCount(0);
    });

    test(`${range.row}: what is typed in the box is where the handle stands, and a value out of the range holds Save back`, async ({
      page,
    }) => {
      const screen = await start(page);
      const row = rowOf(screen, range.row);
      await row.scrollIntoViewIfNeeded();
      const box = row.getByRole("textbox");
      const slider = row.getByRole("slider");
      const middle = String(Number(((range.min + range.max) / 2).toFixed(2)));
      await box.fill(middle);
      await expect(slider).toHaveValue(
        String(Math.min(range.max, Math.max(range.min, Number(middle)))),
      );
      await expect(row.getByRole("alert")).toHaveCount(0);

      // Out of the range: the box says why where it is typed, Save waits, the handle is at the top.
      await box.fill(range.over);
      await expect(row.getByRole("alert")).toBeVisible();
      await expect(box).toHaveAttribute("aria-invalid", "true");
      await expect(save(screen)).toBeDisabled();
      await expect(slider).toHaveValue(String(range.max));
      // Back inside, the problem goes and Save is ready.
      await box.fill(String(range.max));
      await expect(row.getByRole("alert")).toHaveCount(0);
      await expect(save(screen)).toBeEnabled();
    });
  }

  test("the handle is moved by the mouse, and the box says the same number", async ({ page }) => {
    const screen = await start(page);
    const row = rowOf(screen, "appearance.width");
    await row.scrollIntoViewIfNeeded();
    const slider = row.getByRole("slider");
    const at = await slider.boundingBox();
    if (at === null) throw new Error("no slider");
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    const value = Number(await slider.inputValue());
    expect(value).toBeGreaterThan(180 + 300 * 0.35);
    expect(value).toBeLessThan(180 + 300 * 0.65);
    await expect(row.getByRole("textbox")).toHaveValue(String(value));
    // Dragged to the right end it stops at the top of the range.
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    await page.mouse.move(at.x + at.width + 80, at.y + at.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(slider).toHaveValue("480");
    await expect(row.getByRole("textbox")).toHaveValue("480");
  });

  test("half a number on the way keeps the handle where it was, and an empty box (not set) stands at the value in force", async ({
    page,
  }) => {
    const screen = await start(page);
    const row = rowOf(screen, "background.opacity");
    await row.scrollIntoViewIfNeeded();
    const box = row.getByRole("textbox");
    const slider = row.getByRole("slider");
    // The picture opacity is not set: the handle stands at the 0.6 the theme has.
    await expect(box).toHaveValue("");
    await expect(slider).toHaveValue("0.6");
    // The empty box says the number the handle is at, in gray, so the two do not look at odds.
    await expect(box).toHaveAttribute("placeholder", "0.6");
    await box.fill("0.2");
    await expect(slider).toHaveValue("0.2");
    // Half a number is no value yet: the handle stays where the window has the picture now (0.2).
    await box.fill("0.");
    await expect(slider).toHaveValue("0.2");
    await box.fill("");
    await expect(slider).toHaveValue("0.6");
  });

  test("the sliders and the boxes name themselves, in Portuguese too", async ({ page }) => {
    const screen = await start(page, { language: "pt-BR" });
    for (const name of [
      "Largura da barra lateral",
      "Opacidade da interface",
      "Opacidade da imagem",
      "Desfoque da imagem",
      "Tamanho da fonte",
      "Altura da linha",
      "Histórico",
      "Painéis por aba",
    ]) {
      await expect(screen.getByRole("slider", { name, exact: true }), name).toHaveCount(1);
    }
  });

  test("Save writes a number the slider chose", async ({ page }) => {
    const screen = await start(page);
    const row = rowOf(screen, "terminal.fontSize");
    await row.scrollIntoViewIfNeeded();
    await row.getByRole("slider").focus();
    await page.keyboard.press("End");
    const panes = rowOf(screen, "terminal.maxPanes");
    await panes.scrollIntoViewIfNeeded();
    await panes.getByRole("slider").focus();
    await page.keyboard.press("Home");
    await saveSettings(page);
    const text = (await configText(page)) ?? "";
    expect(text).toContain('"size": 72');
    expect(text).toContain('"maxPanes": 2');
  });
});

test.describe("the row of buttons and the list", () => {
  test("a choice of two or three short options is a row of buttons, drawn side by side with one marked", async ({
    page,
  }) => {
    const screen = await start(page);
    for (const [key, name, options] of [
      ["appearance.side", "Sidebar side", ["Left", "Right"]],
      ["appearance.tabs", "Tab position", ["In the sidebar", "On top"]],
      ["appearance.density", "Density", ["Comfortable", "Compact"]],
      ["terminal.cursorShape", "Cursor shape", ["Block", "Bar", "Underline"]],
      ["shortcuts.preset", "Shortcut preset", ["Safe", "Browser"]],
    ] as const) {
      const row = rowOf(screen, key);
      await row.scrollIntoViewIfNeeded();
      const group = row.getByRole("group", { name, exact: true });
      await expect(group, key).toBeVisible();
      const radios = group.getByRole("radio");
      await expect(radios, key).toHaveCount(options.length);
      const boxes = await group.locator("label").evaluateAll((labels) =>
        labels.map((label) => {
          const rect = label.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, text: label.textContent?.trim() ?? "" };
        }),
      );
      expect(
        boxes.map((one) => one.text),
        key,
      ).toEqual([...options]);
      // Side by side: one line, each to the right of the one before, the same width.
      expect(new Set(boxes.map((one) => Math.round(one.y))).size, key).toBe(1);
      const lefts = boxes.map((one) => one.x);
      expect(lefts, key).toEqual([...lefts].sort((a, b) => a - b));
      expect(new Set(lefts).size, key).toBe(boxes.length);
      expect(new Set(boxes.map((one) => Math.round(one.width))).size, key).toBe(1);
      // Exactly one is checked, and the one that is has the mark of the theme on it.
      const checked = await radios.evaluateAll(
        (all) => all.filter((radio) => (radio as HTMLInputElement).checked).length,
      );
      expect(checked, key).toBe(1);
      const marked = await group.locator("label:has(input:checked)").evaluate((label) => {
        const style = getComputedStyle(label);
        return { weight: style.fontWeight, shadow: style.boxShadow };
      });
      expect(Number(marked.weight)).toBeGreaterThanOrEqual(600);
      expect(marked.shadow).not.toBe("none");
    }
  });

  test("a click on the name of an option chooses it, and the arrows move the choice", async ({
    page,
  }) => {
    const screen = await start(page);
    const group = rowOf(screen, "appearance.side").getByRole("group", { name: "Sidebar side" });
    const right = await group.locator("label", { hasText: "Right" }).boundingBox();
    if (right === null) throw new Error("no segment");
    await page.mouse.click(right.x + right.width / 2, right.y + right.height / 2);
    await expect(group.getByRole("radio", { name: "Right", exact: true })).toBeChecked();
    await group.getByRole("radio", { name: "Right", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(group.getByRole("radio", { name: "Left", exact: true })).toBeChecked();
    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: "Right", exact: true })).toBeChecked();
    await expect(save(screen)).toBeEnabled();
  });

  test("a choice of four or more options, or of long ones, is a list, with every option and the chosen one showing", async ({
    page,
  }) => {
    const screen = await start(page);
    for (const [key, name, value, labels] of [
      [
        "appearance.language",
        "Language",
        "system",
        ["Same as the system", "English", "Português (Brasil)"],
      ],
      ["window.effect", "Window effect", "none", ["None", "Mica", "Acrylic", "Vibrancy"]],
      [
        "terminal.bell",
        "When a program rings the bell",
        "none",
        ["Only mark the tab", "Flash the pane", "Beep", "Flash and beep"],
      ],
      [
        "terminal.rightClick",
        "Right click in the terminal",
        "menu",
        ["Open a menu", "Copy the selection, or paste", "Always paste"],
      ],
    ] as const) {
      const row = rowOf(screen, key);
      await row.scrollIntoViewIfNeeded();
      const list = row.getByRole("combobox", { name, exact: true });
      await expect(list, key).toBeVisible();
      await expect(list, key).toHaveValue(value);
      await expect(list.locator("option"), key).toHaveText([...labels]);
      // No radio button is left in the row: the list is the control.
      await expect(row.getByRole("radio"), key).toHaveCount(0);
    }
  });

  test("a list chooses by its names, and Save writes the value", async ({ page }) => {
    const screen = await start(page);
    const bell = rowOf(screen, "terminal.bell").getByRole("combobox");
    await bell.scrollIntoViewIfNeeded();
    await bell.selectOption({ label: "Flash and beep" });
    await expect(bell).toHaveValue("both");
    const click = rowOf(screen, "terminal.rightClick").getByRole("combobox");
    await click.selectOption({ label: "Always paste" });
    await rowOf(screen, "appearance.language")
      .getByRole("combobox")
      .selectOption({ label: "Português (Brasil)" });
    await expect(save(screen)).toBeEnabled();
    await saveSettings(page);
    const text = (await configText(page)) ?? "";
    expect(text).toContain('"bell": "both"');
    expect(text).toContain('"rightClick": "paste"');
    expect(text).toContain('"language": "pt-BR"');
  });

  for (const language of ["en", "pt-BR"] as const) {
    test(`the rule, in ${language}: a row of buttons has two or three options with names that fit; the four-option and long ones are lists`, async ({
      page,
    }) => {
      const screen = await start(page, { language });
      const groups = screen.locator('[data-nr-row] [role="group"]:has(input[type="radio"])');
      const found = await groups.evaluateAll((all) =>
        all.map((group) => ({
          count: group.querySelectorAll('input[type="radio"]').length,
          names: [...group.querySelectorAll("label")].map((label) => label.textContent ?? ""),
          overflowing: [...group.querySelectorAll("label")].filter(
            (label) => label.scrollWidth > label.clientWidth + 1,
          ).length,
        })),
      );
      expect(found.length).toBe(5);
      for (const group of found) {
        expect(group.count).toBeGreaterThanOrEqual(2);
        expect(group.count).toBeLessThanOrEqual(3);
        expect(group.overflowing, group.names.join("/")).toBe(0);
        for (const name of group.names) expect(name.length, name).toBeLessThanOrEqual(16);
      }
      // The four lists of the screen: the language, the window effect, the bell and the right click.
      const lists = screen.locator(
        '[data-nr-row="appearance.language"], [data-nr-row="window.effect"], [data-nr-row="terminal.bell"], [data-nr-row="terminal.rightClick"]',
      );
      await expect(lists.getByRole("combobox")).toHaveCount(4);
      await expect(lists.getByRole("radio")).toHaveCount(0);
    });
  }
});

test.describe("the chooser of a path", () => {
  async function openSshProfile(page: Page, language: Language = "en"): Promise<Locator> {
    const screen = await start(page, { language });
    const add = language === "en" ? "Add SSH profile" : "Adicionar perfil SSH";
    await screen.getByRole("button", { name: add, exact: true }).click();
    return screen.locator('[data-nr-part="settings-profile"]').first();
  }

  test("the key file and the known hosts file of an ssh profile each have a Choose button that asks for a file", async ({
    page,
  }) => {
    const profile = await openSshProfile(page);
    await profile.scrollIntoViewIfNeeded();
    const key = profile.getByRole("button", {
      name: "Choose a file for “Key file (optional)”",
      exact: true,
    });
    const hosts = profile.getByRole("button", {
      name: "Choose a file for “Known hosts file (optional)”",
      exact: true,
    });
    await expect(key).toHaveText("Choose…");
    await expect(hosts).toHaveText("Choose…");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setPathPick("C:\\Users\\me\\.ssh\\id_ed25519"),
    );
    await key.click();
    await expect(
      profile.getByRole("textbox", { name: "Key file (optional)", exact: true }),
    ).toHaveValue("C:\\Users\\me\\.ssh\\id_ed25519");
    expect(await pathPicks(page)).toEqual([{ kind: "file", title: "Choose a file" }]);
    // The other box is not touched by it.
    await expect(
      profile.getByRole("textbox", { name: "Known hosts file (optional)", exact: true }),
    ).toHaveValue("");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setPathPick("C:\\Users\\me\\.ssh\\known_hosts"),
    );
    await hosts.click();
    await expect(
      profile.getByRole("textbox", { name: "Known hosts file (optional)", exact: true }),
    ).toHaveValue("C:\\Users\\me\\.ssh\\known_hosts");
  });

  test("the folder and the program of a shell profile have one, for a folder and for a file; the ones on another machine have none", async ({
    page,
  }) => {
    const screen = await start(page);
    await screen.getByRole("button", { name: "Add profile", exact: true }).click();
    const profile = screen.locator('[data-nr-part="settings-profile"]').first();
    await profile.scrollIntoViewIfNeeded();
    const folder = profile.getByRole("button", {
      name: "Choose a folder for “Start folder”",
      exact: true,
    });
    const program = profile.getByRole("button", {
      name: "Choose a file for “Program”",
      exact: true,
    });
    await page.evaluate(() => (window as HookWindow).__norenTest?.setPathPick("C:\\Work"));
    await folder.click();
    await expect(profile.getByRole("textbox", { name: "Start folder", exact: true })).toHaveValue(
      "C:\\Work",
    );
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setPathPick("C:\\Tools\\fish.exe"),
    );
    await program.click();
    await expect(profile.getByRole("textbox", { name: "Program", exact: true })).toHaveValue(
      "C:\\Tools\\fish.exe",
    );
    expect(await pathPicks(page)).toEqual([
      { kind: "folder", title: "Choose a folder" },
      { kind: "file", title: "Choose a file" },
    ]);

    // On an ssh profile the program and the folder are on the other machine: a box, no chooser.
    await screen.getByRole("button", { name: "Add SSH profile", exact: true }).click();
    const ssh = screen.locator('[data-nr-part="settings-profile"]').nth(1);
    await expect(ssh.getByRole("button", { name: /^Choose a/ })).toHaveCount(2);
    await expect(
      ssh.getByRole("textbox", { name: "Program on that machine (optional)", exact: true }),
    ).toBeVisible();
    await expect(
      ssh.getByRole("textbox", { name: "Start folder on that machine (optional)", exact: true }),
    ).toBeVisible();
  });

  test("closing the chooser changes nothing, and a chooser that cannot open says why", async ({
    page,
  }) => {
    const profile = await openSshProfile(page);
    await profile.scrollIntoViewIfNeeded();
    const key = profile.getByRole("textbox", { name: "Key file (optional)", exact: true });
    await key.fill("C:\\mine\\key");
    const choose = profile.getByRole("button", {
      name: "Choose a file for “Key file (optional)”",
      exact: true,
    });
    await page.evaluate(() => (window as HookWindow).__norenTest?.setPathPick(null));
    await choose.click();
    await expect.poll(async () => (await pathPicks(page)).length).toBe(1);
    await expect(key).toHaveValue("C:\\mine\\key");
    await expect(choose).toBeEnabled();

    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.failPathPick("no window to open it over"),
    );
    await choose.click();
    await expect(profile.getByRole("alert").filter({ hasText: "could not be opened" })).toHaveText(
      "The chooser could not be opened: no window to open it over",
    );
    await expect(key).toHaveValue("C:\\mine\\key");
    // The next try works, and the sentence goes.
    await page.evaluate(() => (window as HookWindow).__norenTest?.setPathPick("C:\\new\\key"));
    await choose.click();
    await expect(key).toHaveValue("C:\\new\\key");
    await expect(profile.getByRole("alert").filter({ hasText: "could not be opened" })).toHaveCount(
      0,
    );
  });

  test("a path the chooser gave is checked like one typed, and Save writes it", async ({
    page,
  }) => {
    const profile = await openSshProfile(page);
    const screen = settingsOf(page);
    await profile.scrollIntoViewIfNeeded();
    await profile.getByRole("textbox", { name: "Name", exact: true }).fill("Staging");
    await profile.getByRole("textbox", { name: "Host", exact: true }).fill("staging.example.org");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setPathPick("C:\\Users\\me\\.ssh\\id_ed25519"),
    );
    await profile
      .getByRole("button", { name: "Choose a file for “Key file (optional)”", exact: true })
      .click();
    await expect(save(screen)).toBeEnabled();
    await saveSettings(page);
    const written = JSON.parse((await configText(page)) ?? "{}") as {
      profiles: { identityFile?: string; host?: string }[];
    };
    expect(written.profiles[0]).toMatchObject({
      host: "staging.example.org",
      identityFile: "C:\\Users\\me\\.ssh\\id_ed25519",
    });
  });

  test("says its words in Portuguese", async ({ page }) => {
    const profile = await openSshProfile(page, "pt-BR");
    await profile.scrollIntoViewIfNeeded();
    await expect(
      profile.getByRole("button", {
        name: "Escolher um arquivo para “Arquivo da chave (opcional)”",
        exact: true,
      }),
    ).toHaveText("Escolher…");
    await page.evaluate(() => (window as HookWindow).__norenTest?.setPathPick("C:\\k"));
    await profile
      .getByRole("button", { name: /^Escolher um arquivo para “Arquivo da chave/ })
      .click();
    expect(await pathPicks(page)).toEqual([{ kind: "file", title: "Escolher um arquivo" }]);
  });
});

/** The settings screen of a page that already has it open. */
const settingsOf = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Settings", exact: true });

test.describe("the color picker of the theme editor", () => {
  test("a color is a swatch that opens the color picker and a box for the hex value, which stay one value", async ({
    page,
  }) => {
    const screen = await start(page);
    await screen
      .locator('[data-nr-theme="noren-dusk"] [data-nr-action="edit"]')
      .scrollIntoViewIfNeeded();
    await screen.locator('[data-nr-theme="noren-dusk"] [data-nr-action="edit"]').click();
    const editor = page.getByRole("dialog", { name: "Theme editor", exact: true });
    await expect(editor).toBeVisible();
    const field = editor.locator('[data-nr-field="ui.accent"]');
    const swatch = field.locator('input[type="color"]');
    const hex = field.getByRole("textbox", { name: "Accent", exact: true });
    await expect(swatch).toHaveAttribute("aria-label", "Accent, color picker");
    await expect(swatch).toHaveValue(await hex.inputValue());
    // The box drives the swatch ...
    await hex.fill("#10b981");
    await expect(swatch).toHaveValue("#10b981");
    // ... and the swatch drives the box, and the preview of the theme follows both.
    await swatch.fill("#e11d48");
    await expect(hex).toHaveValue("#e11d48");
    await expect(
      editor
        .locator('[data-nr-part="theme-preview"]')
        .evaluate((element) =>
          (element as HTMLElement).style.getPropertyValue("--tp-accent").trim(),
        ),
    ).resolves.toBe("#e11d48");
    // A box with a value that is not a color says why and keeps the swatch where it was.
    await hex.fill("#12");
    await expect(field.getByRole("alert")).toBeVisible();
    await expect(swatch).toHaveValue("#e11d48");
  });

  test("the settings screen itself has no color field: nothing to give a swatch to", async ({
    page,
  }) => {
    const screen = await start(page);
    await expect(screen.locator('input[type="color"]')).toHaveCount(0);
  });
});

test.describe("what has an effect shows in the window at once, as a preview", () => {
  test("the sidebar: its side, its width, its density and compact mode follow the screen, and Cancel takes it all back", async ({
    page,
  }) => {
    const screen = await start(page);
    await expect(body(page)).toHaveAttribute("data-nr-side", "left");
    await expect.poll(async () => (await sidebar(page).boundingBox())?.width).toBe(200);

    await rowOf(screen, "appearance.side")
      .getByRole("radio", { name: "Right", exact: true })
      .check();
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");
    await rowOf(screen, "appearance.density")
      .getByRole("radio", { name: "Compact", exact: true })
      .check();
    await expect(body(page)).toHaveAttribute("data-nr-density", "compact");
    const width = rowOf(screen, "appearance.width");
    await width.getByRole("slider").focus();
    await page.keyboard.press("End");
    await expect.poll(async () => (await sidebar(page).boundingBox())?.width).toBe(480);
    await rowOf(screen, "appearance.compact").getByRole("switch").click();
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "auto-hide");
    // Nothing is written: the file is as it was.
    expect(await configText(page)).toBe(fileFor("en", "dark"));

    await cancelSettings(page);
    await expect(body(page)).toHaveAttribute("data-nr-side", "left");
    await expect(body(page)).toHaveAttribute("data-nr-density", "comfortable");
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "docked");
    await expect.poll(async () => (await sidebar(page).boundingBox())?.width).toBe(200);
    expect(await configText(page)).toBe(fileFor("en", "dark"));
  });

  test("a width that is not valid yet keeps the last one the window showed, and says why", async ({
    page,
  }) => {
    const screen = await start(page);
    const row = rowOf(screen, "appearance.width");
    await row.getByRole("textbox").fill("300");
    await expect.poll(async () => (await sidebar(page).boundingBox())?.width).toBe(300);
    await row.getByRole("textbox").fill("30");
    await expect(row.getByRole("alert")).toHaveText("Whole pixels, from 180 to 480.");
    await expect.poll(async () => (await sidebar(page).boundingBox())?.width).toBe(300);
    await row.getByRole("textbox").fill("");
    await expect(row.getByRole("alert")).toBeVisible();
    await expect.poll(async () => (await sidebar(page).boundingBox())?.width).toBe(300);
  });

  test("the tabs on top, the sidebar hidden with them", async ({ page }) => {
    const screen = await start(page);
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "docked");
    await rowOf(screen, "appearance.tabs")
      .getByRole("radio", { name: "On top", exact: true })
      .check();
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "auto-hide");
    await cancelSettings(page);
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "docked");
  });

  test("the pane headers: the switch turns them on in the window before Save, and Cancel takes them off", async ({
    page,
  }) => {
    const screen = await start(page);
    await expect(page.locator('[data-nr-part="pane-header"]')).toHaveCount(0);
    await rowOf(screen, "appearance.paneHeaders").getByRole("switch").click();
    await expect(page.locator('[data-nr-part="pane-header"]')).toHaveCount(1);
    await cancelSettings(page);
    await expect(page.locator('[data-nr-part="pane-header"]')).toHaveCount(0);
  });

  test("the terminal: the font size, the line height, the cursor and the font follow the screen, and Cancel takes them back", async ({
    page,
  }) => {
    const screen = await start(page);
    await expect.poll(async () => (await drawing(page))?.fontSize).toBe(14);
    const before = await drawing(page);

    const size = rowOf(screen, "terminal.fontSize");
    await size.scrollIntoViewIfNeeded();
    await size.getByRole("slider").focus();
    await page.keyboard.press("End");
    await expect.poll(async () => (await drawing(page))?.fontSize).toBe(72);
    await size.getByRole("textbox").fill("20");
    await expect.poll(async () => (await drawing(page))?.fontSize).toBe(20);
    // Half a number on the way, and one out of the range, leave the terminal where it was.
    await size.getByRole("textbox").fill("2");
    await expect(size.getByRole("alert")).toBeVisible();
    await expect.poll(async () => (await drawing(page))?.fontSize).toBe(20);

    const line = rowOf(screen, "terminal.lineHeight");
    await line.getByRole("slider").focus();
    await page.keyboard.press("End");
    await expect.poll(async () => (await drawing(page))?.lineHeight).toBe(3);
    await rowOf(screen, "terminal.cursorShape")
      .getByRole("radio", { name: "Underline", exact: true })
      .check();
    await expect.poll(async () => (await drawing(page))?.cursorStyle).toBe("underline");
    await rowOf(screen, "terminal.cursorBlinks").getByRole("switch").click();
    await expect.poll(async () => (await drawing(page))?.cursorBlink).toBe(false);
    await rowOf(screen, "terminal.fontList").getByRole("textbox").fill("Consolas");
    await expect.poll(async () => (await drawing(page))?.fontFamily).toContain("Consolas");
    // The file has none of it.
    expect(await configText(page)).toBe(fileFor("en", "dark"));

    await cancelSettings(page);
    await expect.poll(async () => await drawing(page)).toEqual(before);
    expect(await configText(page)).toBe(fileFor("en", "dark"));
  });

  test("Save keeps what the window was showing, and writes it", async ({ page }) => {
    const screen = await start(page);
    const size = rowOf(screen, "terminal.fontSize");
    await size.scrollIntoViewIfNeeded();
    await size.getByRole("textbox").fill("18");
    await rowOf(screen, "terminal.cursorShape")
      .getByRole("radio", { name: "Bar", exact: true })
      .check();
    await rowOf(screen, "appearance.side")
      .getByRole("radio", { name: "Right", exact: true })
      .check();
    await expect.poll(async () => (await drawing(page))?.fontSize).toBe(18);
    await saveSettings(page);
    await expect.poll(async () => (await drawing(page))?.fontSize).toBe(18);
    expect((await drawing(page))?.cursorStyle).toBe("bar");
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");
    const text = (await configText(page)) ?? "";
    expect(text).toContain('"size": 18');
    expect(text).toContain('"style": "bar"');
    expect(text).toContain('"position": "right"');
  });

  test("the picture: chosen with the chooser it shows behind the terminal at once, Cancel takes it away, and a path that cannot be read shows nothing and no notice", async ({
    page,
  }) => {
    const screen = await start(page);
    const row = rowOf(screen, "background.image");
    await row.scrollIntoViewIfNeeded();
    await expect(pictureLayer(page)).toHaveCount(0);

    // A path being typed that is not a picture: the thumbnail says why, the window shows nothing.
    await row.getByRole("textbox").fill("fixtures/not-there.png");
    await expect(row.locator('[data-nr-part="background-thumbnail-failure"]')).toBeVisible();
    await expect(pictureLayer(page)).toHaveCount(0);
    await expect(page.locator('[data-nr-part="background-notice"]')).toHaveCount(0);

    await page.evaluate((path) => (window as HookWindow).__norenTest?.setImagePick(path), PICTURE);
    await row.getByRole("button", { name: "Choose image…", exact: true }).click();
    await expect(pictureLayer(page)).toHaveCount(1);
    expect(
      await pictureLayer(page).evaluate((element) => getComputedStyle(element).backgroundImage),
    ).toMatch(/^url\("blob:/);
    expect(await configText(page)).toBe(fileFor("en", "dark"));

    await cancelSettings(page);
    await expect(pictureLayer(page)).toHaveCount(0);
    expect(await configText(page)).toBe(fileFor("en", "dark"));
  });

  test("the picture: in a file that has one, emptying the box shows none at once, and Cancel brings it back", async ({
    page,
  }) => {
    const withPicture = `{ "appearance": { "theme": "noren-dusk", "background": { "image": "${PICTURE}" } } }\n`;
    const screen = await start(page, { file: withPicture });
    const row = rowOf(screen, "background.image");
    await row.scrollIntoViewIfNeeded();
    await expect(pictureLayer(page)).toHaveCount(1);
    await row.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(pictureLayer(page)).toHaveCount(0);
    expect(await configText(page)).toBe(withPicture);
    await cancelSettings(page);
    await expect(pictureLayer(page)).toHaveCount(1);
  });
});

test.describe("axe on the screen with every control at work", () => {
  for (const language of ["en", "pt-BR"] as const) {
    for (const mode of ["dark", "light"] as const) {
      test(`${language}, ${mode} theme: switches on, sliders moved, a list and a row of buttons chosen, a chooser that failed`, async ({
        page,
      }) => {
        test.setTimeout(60_000);
        const screen = await start(page, { language, mode });
        const pt = language === "pt-BR";
        const row = (key: string) => rowOf(screen, key);
        await row("appearance.paneHeaders").getByRole("switch").click();
        await row("appearance.width").getByRole("slider").focus();
        await page.keyboard.press("End");
        await row("appearance.tabs").getByRole("radio").last().check();
        await expectNoAxeViolations(
          page,
          `appearance with its controls moved, ${language} ${mode}`,
        );

        await row("terminal.fontSize").scrollIntoViewIfNeeded();
        await row("terminal.fontSize").getByRole("slider").focus();
        await page.keyboard.press("PageUp");
        await row("terminal.cursorShape").getByRole("radio").last().check();
        await row("terminal.bell").getByRole("combobox").selectOption("both");
        await row("terminal.cursorBlinks").getByRole("switch").click();
        await expectNoAxeViolations(page, `terminal with its controls moved, ${language} ${mode}`);

        await screen
          .getByRole("button", {
            name: pt ? "Adicionar perfil SSH" : "Add SSH profile",
            exact: true,
          })
          .click();
        await page.evaluate(() =>
          (window as HookWindow).__norenTest?.failPathPick("no window to open it over"),
        );
        const choose = screen
          .locator('[data-nr-part="settings-profile"]')
          .first()
          .getByRole("button", { name: /^(Choose a file|Escolher um arquivo) for|para/ })
          .first();
        await choose.scrollIntoViewIfNeeded();
        await choose.click();
        await expect(
          screen.locator('[data-nr-part="settings-profile"]').getByRole("alert").first(),
        ).toBeVisible();
        await expectNoAxeViolations(
          page,
          `profiles with a chooser that failed, ${language} ${mode}`,
        );
      });
    }
  }

  test("the segmented buttons and the switches keep the focus ring a keyboard needs", async ({
    page,
  }) => {
    const screen = await start(page);
    const radio = rowOf(screen, "appearance.side").getByRole("radio", { name: "Left" });
    await radio.focus();
    await page.keyboard.press("ArrowRight");
    const outline = await rowOf(screen, "appearance.side")
      .locator("label:has(input:focus-visible)")
      .evaluate((label) => getComputedStyle(label).outlineStyle);
    expect(outline).toBe("solid");
    const pane = rowOf(screen, "appearance.paneHeaders").getByRole("switch");
    await pane.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    expect(await pane.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  });
});
