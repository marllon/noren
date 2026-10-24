import { readFileSync } from "node:fs";
import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import {
  closeSettings,
  configSaveCount,
  configText,
  openSettings,
  quiet,
  seedConfig,
  settingsScreen,
} from "./settings-fixture";

// The settings screen has no Save (NOR-F20-10c): every change that is a value `config.jsonc` takes is
// written as it is made, only the setting that changed; a value the file would refuse says why under
// its box and is not written (the rest still is); closing the screen (Esc, the X, a click outside)
// writes what still waits, so nothing is lost. Each kind of control is held to it here, against the
// fake backend: the text it receives is the text of the file, which a test reads back.

interface Hook {
  paneIds(): string[];
  setPathPick(path: string | null): void;
  setImagePick(path: string | null): void;
  pathPickCalls(): { kind: string; title: string }[];
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const FIXTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));
const PICTURE = "fixtures/background.png";

const DEV = { id: "dev", name: "Dev", program: "pwsh.exe" };
const OPS = { id: "ops", name: "Ops", program: "bash" };

/** A file with comments and settings of several kinds, as a person keeps it. */
const FILE = `// My Noren settings, keep this line.
{
  "appearance": {
    "theme": "noren-dusk",
    "sidebar": { "position": "left", "width": 220 }, // my sidebar
  },
  /* the terminal */
  "terminal": { "font": { "size": 15 } },
}
`;

type Language = "en" | "pt-BR";

async function start(
  page: Page,
  options: { file?: string; language?: Language; scheme?: "dark" | "light" } = {},
): Promise<Locator> {
  const language = options.language ?? "en";
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: "noren.web.images", value: JSON.stringify({ [PICTURE]: FIXTURE.toString("base64") }) },
  );
  const file =
    options.file ??
    (language === "pt-BR" ? FILE.replace("{\n", '{\n  "language": "pt-BR",\n') : FILE);
  await seedConfig(page, file);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  const name = language === "pt-BR" ? "Configurações" : "Settings";
  await page.getByRole("button", { name, exact: true }).click();
  const screen = page.getByRole("dialog", { name, exact: true });
  await expect(screen).toBeVisible();
  return screen;
}

const rowOf = (screen: Locator, key: string): Locator => screen.locator(`[data-nr-row="${key}"]`);
const parsed = async (page: Page): Promise<Record<string, unknown>> =>
  JSON.parse(
    ((await configText(page)) ?? "{}")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(\s*[}\]])/g, "$1"),
  ) as Record<string, unknown>;

test.describe("no Save, no Cancel", () => {
  for (const language of ["en", "pt-BR"] as const) {
    test(`${language}: no section has a Save or a Cancel button, and the screen closes with its X`, async ({
      page,
    }) => {
      const screen = await start(page, { language });
      const nav = screen.locator('[data-nr-part="settings-nav"]').getByRole("button");
      const names = await nav.allTextContents();
      expect(names.length).toBeGreaterThanOrEqual(14);
      const words = language === "en" ? ["Save", "Cancel"] : ["Salvar", "Cancelar"];
      for (const name of names) {
        await nav.filter({ hasText: name }).first().click();
        for (const word of words) {
          await expect(screen.getByRole("button", { name: word, exact: true }), name).toHaveCount(
            0,
          );
        }
      }
      // What stands there instead: the X, and the line that says every change is saved.
      const close = language === "en" ? "Close" : "Fechar";
      await expect(screen.getByRole("button", { name: close, exact: true })).toBeVisible();
      await expect(screen.locator('[data-nr-part="settings-autosave"]')).toHaveText(
        language === "en"
          ? "Every change is saved as you make it."
          : "Cada mudança é salva na hora.",
      );
      await screen.getByRole("button", { name: close, exact: true }).click();
      await expect(screen).toHaveCount(0);
    });
  }
});

test.describe("each kind of control writes at once, and only what it changed", () => {
  test("a switch", async ({ page }) => {
    const screen = await start(page);
    await rowOf(screen, "appearance.paneHeaders").getByRole("switch").check();
    await expect.poll(() => configSaveCount(page)).toBe(1);
    // The text the backend got is the file with one setting more, every comment where it was.
    expect(await configText(page)).toBe(
      FILE.replace(
        '"sidebar": { "position": "left", "width": 220 }, // my sidebar',
        '"sidebar": { "position": "left", "width": 220 }, // my sidebar\n    "paneHeaders": true,',
      ),
    );
  });

  test("a slider and its box", async ({ page }) => {
    const screen = await start(page);
    const row = rowOf(screen, "terminal.fontSize");
    await row.scrollIntoViewIfNeeded();
    await row.getByRole("slider").focus();
    await page.keyboard.press("End");
    await expect.poll(() => configSaveCount(page)).toBe(1);
    expect(await configText(page)).toBe(FILE.replace('"size": 15', '"size": 72'));
    await expect(row.getByRole("textbox")).toHaveValue("72");
  });

  test("a box with a number", async ({ page }) => {
    const screen = await start(page);
    await rowOf(screen, "appearance.width").getByRole("textbox").fill("260");
    await expect.poll(() => configSaveCount(page)).toBe(1);
    expect(await configText(page)).toBe(FILE.replace('"width": 220', '"width": 260'));
  });

  test("a row of buttons", async ({ page }) => {
    const screen = await start(page);
    await rowOf(screen, "appearance.density").getByRole("radio", { name: "Compact" }).check();
    await expect.poll(() => configSaveCount(page)).toBe(1);
    expect((await parsed(page))["appearance"]).toMatchObject({ density: "compact" });
    expect(await configText(page)).toContain("// my sidebar");
  });

  test("a list", async ({ page }) => {
    const screen = await start(page);
    const bell = rowOf(screen, "terminal.bell").getByRole("combobox");
    await bell.scrollIntoViewIfNeeded();
    await bell.selectOption({ label: "Beep" });
    await expect.poll(() => configSaveCount(page)).toBe(1);
    expect((await parsed(page))["terminal"]).toMatchObject({ bell: "sound", font: { size: 15 } });
    expect(await configText(page)).toContain("/* the terminal */");
  });

  test("a box with text", async ({ page }) => {
    const screen = await start(page);
    const box = rowOf(screen, "terminal.fontList").getByRole("textbox");
    await box.scrollIntoViewIfNeeded();
    await box.fill("Fira Code, monospace");
    await expect.poll(() => configSaveCount(page)).toBe(1);
    expect((await parsed(page))["terminal"]).toMatchObject({
      font: { size: 15, family: "Fira Code, monospace" },
    });
  });

  test("a path chosen with the chooser (a fake one), and a path typed", async ({ page }) => {
    const screen = await start(page);
    // The picture: the chooser answers a path, and it is written as soon as the window can read it.
    const row = rowOf(screen, "background.image");
    await row.scrollIntoViewIfNeeded();
    await page.evaluate((path) => (window as HookWindow).__norenTest?.setImagePick(path), PICTURE);
    await row.getByRole("button", { name: "Choose image…", exact: true }).click();
    await expect.poll(() => configSaveCount(page)).toBe(1);
    expect((await parsed(page))["appearance"]).toMatchObject({ background: { image: PICTURE } });

    // The program of a shell profile: the chooser answers a path, written when the row is left.
    await screen.getByRole("button", { name: "Add profile", exact: true }).click();
    const profile = screen.locator('[data-nr-part="settings-profile"]').first();
    await profile.scrollIntoViewIfNeeded();
    await profile.getByRole("textbox", { name: "Name", exact: true }).fill("Fish");
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setPathPick("C:\\Tools\\fish.exe"),
    );
    await profile.getByRole("button", { name: "Choose a file for “Program”", exact: true }).click();
    await expect(profile.getByRole("textbox", { name: "Program", exact: true })).toHaveValue(
      "C:\\Tools\\fish.exe",
    );
    await screen.getByRole("heading", { name: "Settings", exact: true }).click();
    await expect.poll(() => configSaveCount(page)).toBe(2);
    expect((await parsed(page))["profiles"]).toEqual([
      { id: "fish", name: "Fish", program: "C:\\Tools\\fish.exe" },
    ]);

    // A path typed: written when the typing pauses, like any text.
    await profile.getByRole("textbox", { name: "Start folder", exact: true }).fill("D:\\work");
    await expect.poll(() => configSaveCount(page)).toBe(3);
    expect((await parsed(page))["profiles"]).toEqual([
      { id: "fish", name: "Fish", program: "C:\\Tools\\fish.exe", cwd: "D:\\work" },
    ]);
  });

  test("the box of a mod's order and the switches of a list", async ({ page }) => {
    await page.addInitScript(() => {
      if (window.localStorage.getItem("noren.web.mods") === null) {
        window.localStorage.setItem(
          "noren.web.mods",
          JSON.stringify({ "a.css": "body {}", "b.css": "body {}" }),
        );
      }
    });
    const screen = await start(page);
    const mods = screen.locator('[data-nr-part="settings-mod"]');
    await mods.nth(0).getByRole("switch").check();
    await mods.nth(1).getByRole("switch").check();
    await expect.poll(() => configSaveCount(page)).toBe(2);
    expect((await parsed(page))["mods"]).toEqual(["a.css", "b.css"]);
    await screen.getByRole("button", { name: "Move a.css later", exact: true }).click();
    await expect.poll(() => configSaveCount(page)).toBe(3);
    expect((await parsed(page))["mods"]).toEqual(["b.css", "a.css"]);
  });
});

test.describe("a value the file would refuse", () => {
  test("says why under its box, and the backend gets no write for it", async ({ page }) => {
    const screen = await start(page);
    const cases: [string, string, string][] = [
      ["appearance.width", "9999", "Whole pixels, from 180 to 480."],
      ["terminal.fontSize", "500", "A number of pixels from 6 to 72."],
      ["terminal.scrollback", "ten", "A whole number of lines, from 0 to 100000."],
      ["notifications.longCommand", "-3", "A number of seconds, zero or more."],
      [
        "archive.after",
        "0",
        "A number of hours above zero. A fraction is fine: 0.5 is half an hour.",
      ],
    ];
    for (const [key, value, reason] of cases) {
      const row = rowOf(screen, key);
      await row.scrollIntoViewIfNeeded();
      const box = row.getByRole("textbox");
      await box.fill(value);
      await expect(box, key).toHaveAttribute("aria-invalid", "true");
      await expect(row.getByRole("alert"), key).toHaveText(reason);
    }
    // A text the schema refuses, and a path that is a web address.
    const fonts = rowOf(screen, "terminal.fontList").getByRole("textbox");
    await fonts.fill("url(http://example.com/a.woff)");
    await expect(fonts).toHaveAttribute("aria-invalid", "true");
    const image = rowOf(screen, "background.image").getByRole("textbox");
    await image.fill("https://example.com/sky.png");
    await expect(image).toHaveAttribute("aria-invalid", "true");
    await expect(rowOf(screen, "background.image").getByRole("alert")).toContainText(
      "web addresses",
    );
    // A shell profile with no program, a provider with no model.
    await screen.getByRole("button", { name: "Add profile", exact: true }).click();
    const profile = screen.locator('[data-nr-part="settings-profile"]').first();
    await profile.getByRole("textbox", { name: "Name", exact: true }).fill("No program");
    await expect(profile.getByRole("textbox", { name: "Program", exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    const ai = screen.getByRole("region", { name: "AI", exact: true });
    await ai.getByLabel("Ask provider", { exact: true }).selectOption("ollama");
    await expect(ai.getByRole("textbox", { name: "Ask model", exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    await quiet(page);
    expect(await configSaveCount(page)).toBe(0);
    expect(await configText(page)).toBe(FILE);

    // Closing writes nothing for any of them either, and the file is as it was.
    await closeSettings(page);
    expect(await configSaveCount(page)).toBe(0);
    expect(await configText(page)).toBe(FILE);
  });

  test("does not hold back what is valid: one wrong box beside a good one writes the good one", async ({
    page,
  }) => {
    const screen = await start(page);
    await rowOf(screen, "appearance.width").getByRole("textbox").fill("9999");
    await rowOf(screen, "appearance.density").getByRole("radio", { name: "Compact" }).check();
    await expect.poll(() => configSaveCount(page)).toBe(1);
    expect((await parsed(page))["appearance"]).toMatchObject({
      density: "compact",
      sidebar: { position: "left", width: 220 },
    });
    await expect(rowOf(screen, "appearance.width").getByRole("textbox")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });
});

test.describe("closing the screen loses nothing", () => {
  test("Escape right after typing: the value is written, and the screen opens on it", async ({
    page,
  }) => {
    const screen = await start(page);
    const size = rowOf(screen, "terminal.fontSize").getByRole("textbox");
    await size.scrollIntoViewIfNeeded();
    await size.fill("19");
    const family = rowOf(screen, "terminal.fontList").getByRole("textbox");
    await family.fill("Consolas, monospace");
    await page.keyboard.press("Escape");
    await expect(settingsScreen(page)).toHaveCount(0);
    expect((await parsed(page))["terminal"]).toMatchObject({
      font: { size: 19, family: "Consolas, monospace" },
    });

    const again = await openSettings(page);
    const row = rowOf(again, "terminal.fontSize");
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByRole("textbox")).toHaveValue("19");
    await expect(rowOf(again, "terminal.fontList").getByRole("textbox")).toHaveValue(
      "Consolas, monospace",
    );
  });

  test("the X and a click outside, right after typing", async ({ page }) => {
    let screen = await start(page);
    await rowOf(screen, "appearance.width").getByRole("textbox").fill("301");
    await screen.getByRole("button", { name: "Close", exact: true }).click();
    await expect(settingsScreen(page)).toHaveCount(0);
    expect((await parsed(page))["appearance"]).toMatchObject({ sidebar: { width: 301 } });

    screen = await openSettings(page);
    await rowOf(screen, "appearance.width").getByRole("textbox").fill("302");
    await page.mouse.click(3, 3);
    await expect(settingsScreen(page)).toHaveCount(0);
    expect((await parsed(page))["appearance"]).toMatchObject({ sidebar: { width: 302 } });

    // A press inside that ends outside (a selection dragged past the edge) does not close it.
    screen = await openSettings(page);
    const box = await rowOf(screen, "appearance.width").getByRole("textbox").boundingBox();
    if (box === null) throw new Error("no box");
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(3, 3, { steps: 4 });
    await page.mouse.up();
    await expect(screen).toBeVisible();
  });

  test("a profile being filled in is written when the screen closes", async ({ page }) => {
    const screen = await start(page);
    await screen.getByRole("button", { name: "Add profile", exact: true }).click();
    const profile = screen.locator('[data-nr-part="settings-profile"]').first();
    await profile.getByRole("textbox", { name: "Name", exact: true }).fill("Closing time");
    await profile.getByRole("textbox", { name: "Program", exact: true }).fill("pwsh.exe");
    await page.keyboard.press("Escape");
    await expect(settingsScreen(page)).toHaveCount(0);
    expect((await parsed(page))["profiles"]).toEqual([
      { id: "closing-time", name: "Closing time", program: "pwsh.exe" },
    ]);
  });

  test("it stays with the window: what was written shows without the screen", async ({ page }) => {
    const screen = await start(page);
    await rowOf(screen, "appearance.side").getByRole("radio", { name: "Right" }).check();
    await rowOf(screen, "appearance.width").getByRole("textbox").fill("320");
    await page.keyboard.press("Escape");
    await expect(settingsScreen(page)).toHaveCount(0);
    await expect(page.locator(".app-body")).toHaveAttribute("data-nr-side", "right");
    await expect
      .poll(async () => (await page.locator('[data-nr-part="sidebar"]').boundingBox())?.width)
      .toBe(320);
  });
});

test.describe("the file that changes while the screen is open", () => {
  test("a profile another program adds is kept by the next write, and a profile the person removes is taken out", async ({
    page,
  }) => {
    const screen = await start(page, {
      file: JSON.stringify({ profiles: [DEV] }, null, 2),
    });
    // A row waiting for its text keeps the list of profiles as a draft of the screen.
    await screen.getByRole("button", { name: "Add profile", exact: true }).click();
    // Another program puts a second profile in the file.
    const both = JSON.stringify({ profiles: [DEV, OPS] }, null, 2);
    await page.evaluate((text) => (window as HookWindow).__norenTest?.setConfig(text), both);
    await rowOf(screen, "appearance.density").getByRole("radio", { name: "Compact" }).check();
    await expect.poll(() => configSaveCount(page)).toBe(1);
    const profiles = ((await parsed(page))["profiles"] ?? []) as { id: string }[];
    expect(profiles.map((profile) => profile.id)).toEqual(["dev", "ops"]);

    // The profile that came in is on the screen now, and removing it (after the question) takes it out.
    const ops = screen.getByRole("group", { name: "Ops", exact: true });
    await ops.getByRole("button", { name: "Remove profile", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "Remove this profile?", exact: true })
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect.poll(() => configSaveCount(page)).toBe(2);
    const left = ((await parsed(page))["profiles"] ?? []) as { id: string }[];
    expect(left.map((profile) => profile.id)).toEqual(["dev"]);
  });
});

test.describe("the whole app or this space is a row of two buttons", () => {
  for (const language of ["en", "pt-BR"] as const) {
    test(`${language}: side by side, one marked, short names, the space named under the label`, async ({
      page,
    }) => {
      const screen = await start(page, { language });
      const row = rowOf(screen, "themes.themes");
      await row.scrollIntoViewIfNeeded();
      const label = language === "en" ? "Use a theme for" : "Usar o tema em";
      const group = row.getByRole("group", { name: label, exact: true });
      await expect(group).toBeVisible();
      const radios = group.getByRole("radio");
      await expect(radios).toHaveCount(2);
      const boxes = await group.locator("label").evaluateAll((labels) =>
        labels.map((one) => {
          const rect = one.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, text: one.textContent?.trim() ?? "" };
        }),
      );
      expect(boxes.map((one) => one.text)).toEqual(
        language === "en" ? ["The whole app", "This space"] : ["O app todo", "Só este espaço"],
      );
      expect(new Set(boxes.map((one) => Math.round(one.y))).size).toBe(1);
      const [first, second] = boxes;
      if (first === undefined || second === undefined) throw new Error("two buttons expected");
      expect(first.x).toBeLessThan(second.x);
      expect(Math.round(first.width)).toBe(Math.round(second.width));
      for (const one of boxes) expect(one.text.length).toBeLessThanOrEqual(16);
      // It is the same drawing as the other rows of buttons of the screen.
      expect(await group.locator(".settings-segmented").count()).toBe(1);
      await expect(radios.first()).toBeChecked();
      // The name of the space is in the explanation, not in a button.
      await expect(row).toContainText(
        language === "en"
          ? "The space is “Main”: a theme chosen for it shows only there."
          : "O espaço é “Main”: um tema escolhido para ele só aparece nele.",
      );
      // Choosing the second marks it, and the first is no longer marked.
      await radios.nth(1).check();
      await expect(radios.nth(1)).toBeChecked();
      await expect(radios.first()).not.toBeChecked();
    });
  }
});

test.describe("axe, any impact, with the screen as it is without Save", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`${scheme}: with a value refused, a failed write and a change made`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const screen = await start(page, {
        file: FILE.replace("noren-dusk", scheme === "dark" ? "noren-dusk" : "noren-paper"),
      });
      await rowOf(screen, "appearance.width").getByRole("textbox").fill("9999");
      await rowOf(screen, "appearance.density").getByRole("radio", { name: "Compact" }).check();
      await expect.poll(() => configSaveCount(page)).toBe(1);
      await expectNoAxeViolations(page, `settings without Save, ${scheme}`);
    });
  }
});
