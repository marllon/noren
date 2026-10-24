import { readFileSync } from "node:fs";
import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { configText, seedConfig } from "./settings-fixture";
import { ACTIONS_CWD, ACTIONS_TEXT, seedActionsFile, seedSidebarState } from "./sidebar-fixture";
import { openCommandPalette } from "./palette-fixture";

// The interface style (NOR-F20-17): `appearance.style` is "glass" (the default) or "dense". It is chosen
// in the Appearance section of the settings screen (a row of two buttons) or from the palette, kept in
// `config.jsonc` as the one key that changed, and it reaches the page as the attribute `data-nr-style`
// on the root element and the token set of that attribute (fonts, corners, the highlight of the style,
// the glass). The fonts ship inside the app: nothing is fetched to draw them, which the policy of the
// app (`font-src 'self'`) holds too. The theme keeps the colors in either style.

interface Hook {
  paneIds(): string[];
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

interface Words {
  lang: "en" | "pt-BR";
  settings: string;
  close: string;
  row: string;
  glass: string;
  dense: string;
  command: string;
}

const WORDS: Record<Words["lang"], Words> = {
  en: {
    lang: "en",
    settings: "Settings",
    close: "Close",
    row: "Interface style",
    glass: "Glass",
    dense: "Dense technical",
    command: "Toggle interface style",
  },
  "pt-BR": {
    lang: "pt-BR",
    settings: "Configurações",
    close: "Fechar",
    row: "Estilo da interface",
    glass: "Vidro",
    dense: "Técnico denso",
    command: "Alternar o estilo da interface",
  },
};

type Mode = "dark" | "light";
const THEME: Record<Mode, string> = { dark: "noren-dusk", light: "noren-paper" };
/** The accent of each theme, which the style never touches. */
const THEME_ACCENT: Record<Mode, string> = { dark: "#e07a5f", light: "#b8472c" };
/** The background of each theme. */
const THEME_BG: Record<Mode, string> = { dark: "#14161b", light: "#f6f3ec" };

/** What the page holds for a style: the first font, a corner, the gap and the highlight. */
const TOKENS = {
  glass: {
    font: '"Geist"',
    mono: '"Geist Mono"',
    radiusPanel: "12px",
    radiusSide: "14px",
    gap: "8px",
    accent: "#5ee6c8",
  },
  dense: {
    font: '"JetBrains Mono"',
    mono: '"JetBrains Mono"',
    radiusPanel: "0px",
    radiusSide: "0px",
    gap: "1px",
    accent: "#2ee6d6",
  },
} as const;

/** The packaged fonts, as `PACKAGED_FONTS` of the app lists them. */
const FONTS: readonly [string, number][] = [
  ["Geist", 400],
  ["Geist", 500],
  ["Geist", 600],
  ["Geist Mono", 400],
  ["Geist Mono", 500],
  ["JetBrains Mono", 400],
  ["JetBrains Mono", 500],
  ["JetBrains Mono", 700],
];

const conf = JSON.parse(
  readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as { app: { security: { csp: Record<string, string> } } };
const POLICY = Object.entries(conf.app.security.csp)
  .map(([directive, sources]) => `${directive} ${sources}`)
  .join("; ");

interface StartOptions {
  mode?: Mode;
  /** `appearance.style` in the file; left out when `undefined` (the default, glass). */
  style?: string;
  /** The text of the whole file, instead of the one the options make. */
  text?: string;
}

const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');

/** Starts the page in a language and a theme with the file the options say. */
async function start(page: Page, lang: Words["lang"], options: StartOptions = {}): Promise<Words> {
  const appearance: Record<string, unknown> = { theme: THEME[options.mode ?? "dark"] };
  if (options.style !== undefined) appearance["style"] = options.style;
  await seedConfig(
    page,
    options.text ??
      JSON.stringify({ ...(lang === "pt-BR" ? { language: "pt-BR" } : {}), appearance }),
  );
  await seedSidebarState(page, { cwd: ACTIONS_CWD });
  await seedActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
  return WORDS[lang];
}

interface Look {
  attribute: string | null;
  fontUi: string;
  fontMono: string;
  radius: string;
  radiusPanel: string;
  radiusSide: string;
  gap: string;
  styleAccent: string;
  accent: string;
  bg: string;
  bodyFont: string;
}

/** A font list as the browser prints a computed `font-family`: names without their quotes. */
const unquoted = (list: string): string => list.replaceAll('"', "");

/** The attribute and the tokens the page has right now, as the browser computes them. */
const look = (page: Page): Promise<Look> =>
  page.evaluate(() => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    const read = (name: string) => css.getPropertyValue(name).trim();
    return {
      attribute: root.getAttribute("data-nr-style"),
      fontUi: read("--nr-font-ui"),
      fontMono: read("--nr-font-mono"),
      radius: read("--nr-radius"),
      radiusPanel: read("--nr-radius-panel"),
      radiusSide: read("--nr-radius-side"),
      gap: read("--nr-gap"),
      styleAccent: read("--nr-style-accent").toLowerCase(),
      accent: read("--nr-accent").toLowerCase(),
      bg: read("--nr-bg").toLowerCase(),
      bodyFont: getComputedStyle(document.body).fontFamily,
    };
  });

/** Opens the settings screen of a language. */
async function openSettings(page: Page, words: Words): Promise<Locator> {
  await page.getByRole("button", { name: words.settings, exact: true }).click();
  const screen = page.getByRole("dialog", { name: words.settings, exact: true });
  await expect(screen).toBeVisible();
  return screen;
}

async function closeSettings(page: Page, words: Words): Promise<void> {
  const screen = page.getByRole("dialog", { name: words.settings, exact: true });
  await screen.getByRole("button", { name: words.close, exact: true }).click();
  await expect(screen).toHaveCount(0);
}

/** The row of the style in the open settings screen. */
async function styleRow(screen: Locator, words: Words): Promise<Locator> {
  const group = screen.getByRole("group", { name: words.row, exact: true });
  await group.scrollIntoViewIfNeeded();
  return group;
}

/** The page has drawn with `style`: the attribute, the fonts, the corners and the highlight. */
async function expectStyle(page: Page, style: "glass" | "dense", mode: Mode): Promise<void> {
  const want = TOKENS[style];
  await expect.poll(async () => (await look(page)).attribute).toBe(style);
  const seen = await look(page);
  expect(seen.fontUi.startsWith(want.font), seen.fontUi).toBe(true);
  expect(seen.fontMono.startsWith(want.mono) || seen.fontMono === "var(--nr-font-ui)").toBe(true);
  expect(unquoted(seen.bodyFont).startsWith(unquoted(want.font)), seen.bodyFont).toBe(true);
  expect(seen.radiusPanel).toBe(want.radiusPanel);
  expect(seen.radiusSide).toBe(want.radiusSide);
  expect(seen.gap).toBe(want.gap);
  expect(seen.styleAccent).toBe(want.accent);
  // The radius of the theme is the one the components that are not redrawn yet read: the theme's own
  // under glass (10px for both Dusk and Paper), at most 3px under dense.
  expect(seen.radius).toBe(style === "dense" ? "3px" : "10px");
  // The colors are the theme's, whatever the style.
  expect(seen.accent).toBe(THEME_ACCENT[mode]);
}

for (const lang of ["en", "pt-BR"] as const) {
  test(`with nothing in the file the window is glass: the attribute, the type, the corners and the highlight (${lang})`, async ({
    page,
  }) => {
    await start(page, lang, { text: lang === "pt-BR" ? '{ "language": "pt-BR" }' : "{}" });
    const seen = await look(page);
    expect(seen.attribute).toBe("glass");
    expect(seen.fontUi).toBe('"Geist", system-ui, sans-serif');
    expect(unquoted(seen.bodyFont).startsWith("Geist")).toBe(true);
    expect(seen.radiusPanel).toBe("12px");
    expect(seen.radiusSide).toBe("14px");
    expect(seen.styleAccent).toBe("#5ee6c8");
    // The page itself says so before any script runs.
    const html = await (await page.request.get("/")).text();
    expect(html).toContain('<html lang="en" data-nr-style="glass">');
  });

  test(`a file that says "dense" starts the window dense, with the type, the corners and the highlight of that style (${lang})`, async ({
    page,
  }) => {
    await start(page, lang, { style: "dense" });
    await expectStyle(page, "dense", "dark");
    const seen = await look(page);
    expect(seen.fontUi).toBe(
      '"JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace',
    );
    // The row of the settings shows the style in force.
    const words = WORDS[lang];
    const screen = await openSettings(page, words);
    const row = await styleRow(screen, words);
    await expect(row.getByRole("radio", { name: words.dense, exact: true })).toBeChecked();
    await expect(row.getByRole("radio", { name: words.glass, exact: true })).not.toBeChecked();
  });

  test(`choosing the other style in the settings changes the attribute and the tokens at once, writes only that key and stays after a reload (${lang})`, async ({
    page,
  }) => {
    const words = await start(page, lang, { style: "glass" });
    await expectStyle(page, "glass", "dark");
    const screen = await openSettings(page, words);
    const row = await styleRow(screen, words);
    await expect(row.getByRole("radio")).toHaveCount(2);
    await expect(row.getByRole("radio", { name: words.glass, exact: true })).toBeChecked();
    const before = (await configText(page)) ?? "";

    await row.getByRole("radio", { name: words.dense, exact: true }).check();
    // At once, with the screen still open and nothing reloaded.
    await expectStyle(page, "dense", "dark");
    await expect.poll(() => configText(page)).toMatch(/"style":\s*"dense"/);
    const written = (await configText(page)) ?? "";
    // Only that key went into the file: the rest of it is what it was.
    expect(written.replace(/,?\s*"style":\s*"dense",?/, "")).toEqual(
      before.replace(/,?\s*"style":\s*"glass",?/, ""),
    );
    await closeSettings(page, words);
    await expectStyle(page, "dense", "dark");

    await page.reload();
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
      .toBeGreaterThan(0);
    await expectStyle(page, "dense", "dark");
    const again = await openSettings(page, words);
    const rowAgain = await styleRow(again, words);
    await expect(rowAgain.getByRole("radio", { name: words.dense, exact: true })).toBeChecked();

    // And back to glass, which is written too (the file said "dense" before).
    await rowAgain.getByRole("radio", { name: words.glass, exact: true }).check();
    await expectStyle(page, "glass", "dark");
    await expect.poll(() => configText(page)).toMatch(/"style":\s*"glass"/);
    await closeSettings(page, words);
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
      .toBeGreaterThan(0);
    await expectStyle(page, "glass", "dark");
  });
}

test("the style is written alone into a file with comments and other settings, and none of them is touched", async ({
  page,
}) => {
  const text = `{
  // My settings, keep this line.
  "language": "en",
  "appearance": {
    "theme": "noren-dusk", // mine
    "density": "compact",
  },
}
`;
  const words = await start(page, "en", { text });
  const screen = await openSettings(page, words);
  const row = await styleRow(screen, words);
  await row.getByRole("radio", { name: words.dense, exact: true }).check();
  await expect.poll(() => configText(page)).toMatch(/"style":\s*"dense"/);
  const written = (await configText(page)) ?? "";
  expect(written).toContain("// My settings, keep this line.");
  expect(written).toContain("// mine");
  expect(written).toContain('"density": "compact"');
  expect(written).toContain('"theme": "noren-dusk"');
  // The one thing that changed is the new key.
  expect(written.replace(/\s*"style":\s*"dense",?/, "").replace(/\s+/g, " ")).toEqual(
    text.replace(/\s+/g, " "),
  );
});

for (const mode of ["dark", "light"] as const) {
  for (const style of ["glass", "dense"] as const) {
    test(`the style never changes the colors of the theme: the accent and the background stay the theme's in the ${style} style (${mode})`, async ({
      page,
    }) => {
      await start(page, "en", { mode, style });
      const seen = await look(page);
      expect(seen.accent).toBe(THEME_ACCENT[mode]);
      expect(seen.styleAccent).toBe(TOKENS[style].accent);
      // The style has its own highlight, which is not the accent of the theme.
      expect(seen.styleAccent).not.toBe(seen.accent);
      expect(seen.bg).toBe(THEME_BG[mode]);
    });
  }
}

for (const lang of ["en", "pt-BR"] as const) {
  test(`the palette command flips the style and writes only that key (${lang})`, async ({
    page,
  }) => {
    const words = await start(page, lang);
    await expectStyle(page, "glass", "dark");
    const before = (await configText(page)) ?? "";
    await openCommandPalette(page);
    await palette(page).getByRole("combobox").fill(`>${words.command}`);
    await expect(palette(page).getByRole("option").first()).toContainText(words.command);
    await page.keyboard.press("Enter");
    await expect(palette(page)).toBeHidden();
    await expectStyle(page, "dense", "dark");
    await expect.poll(() => configText(page)).toMatch(/"style":\s*"dense"/);
    const written = (await configText(page)) ?? "";
    expect(written.replace(/,?\s*"style":\s*"dense",?/, "")).toEqual(before);

    await openCommandPalette(page);
    await palette(page).getByRole("combobox").fill(`>${words.command}`);
    await expect(palette(page).getByRole("option").first()).toContainText(words.command);
    await page.keyboard.press("Enter");
    await expect(palette(page)).toBeHidden();
    await expectStyle(page, "glass", "dark");
    await expect.poll(() => configText(page)).toMatch(/"style":\s*"glass"/);
  });
}

test("a change of the file by another program moves the style, and a value the schema refuses leaves it where it was", async ({
  page,
}) => {
  await start(page, "en");
  await expectStyle(page, "glass", "dark");
  const set = (text: string | null) =>
    page.evaluate((value) => (window as HookWindow).__norenTest?.setConfig(value), text);
  await set('{ "appearance": { "theme": "noren-dusk", "style": "dense" } }');
  await expectStyle(page, "dense", "dark");
  // A value that is not one of the two is refused: the window stays as it is.
  await set('{ "appearance": { "theme": "noren-dusk", "style": "flat" } }');
  await page.waitForTimeout(300);
  await expectStyle(page, "dense", "dark");
  await set('{ "appearance": { "theme": "noren-dusk", "style": "glass" } }');
  await expectStyle(page, "glass", "dark");
  // Without the key it is the default again, not the last one.
  await set('{ "appearance": { "theme": "noren-dusk", "style": "dense" } }');
  await expectStyle(page, "dense", "dark");
  await set('{ "appearance": { "theme": "noren-dusk" } }');
  await expectStyle(page, "glass", "dark");
});

test("the switch does not reload the page or touch what is on screen: the same terminal, the same tabs", async ({
  page,
}) => {
  const words = await start(page, "en");
  const paneBefore = await page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
  await page.evaluate(() => {
    (window as Window & { __same?: boolean }).__same = true;
  });
  const screen = await openSettings(page, words);
  const row = await styleRow(screen, words);
  await row.getByRole("radio", { name: words.dense, exact: true }).check();
  await expectStyle(page, "dense", "dark");
  await closeSettings(page, words);
  // A reload would have lost the marker, and a new session would have new pane ids.
  expect(await page.evaluate(() => (window as Window & { __same?: boolean }).__same)).toBe(true);
  expect(await page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? [])).toEqual(
    paneBefore,
  );
});

test.describe("the fonts that ship with the app", () => {
  test("load from the app with no network, every weight of the three, and nothing else is requested", async ({
    page,
  }) => {
    const outside: string[] = [];
    const fontRequests: string[] = [];
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (!url.startsWith("http://127.0.0.1")) {
        outside.push(url);
        return route.abort();
      }
      if (route.request().resourceType() === "font") fontRequests.push(url);
      return route.continue();
    });
    await start(page, "en");
    const loaded = await page.evaluate(async (fonts) => {
      const answers: { family: string; weight: number; faces: number; status: string }[] = [];
      for (const [family, weight] of fonts) {
        const faces = await document.fonts.load(`${weight} 13px "${family}"`);
        answers.push({ family, weight, faces: faces.length, status: faces[0]?.status ?? "none" });
      }
      await document.fonts.ready;
      return answers;
    }, FONTS);
    for (const answer of loaded) {
      expect(answer.faces, `${answer.family} ${answer.weight}`).toBe(1);
      expect(answer.status, `${answer.family} ${answer.weight}`).toBe("loaded");
    }
    // They were read from files of the app (woff2, under /assets), one request each at most.
    expect(fontRequests.length).toBeGreaterThanOrEqual(FONTS.length);
    for (const url of fontRequests) expect(url, url).toMatch(/\/assets\/[^/]+\.woff2$/);
    // And no address outside the app was asked for: no font service, nothing.
    expect(outside).toEqual([]);
  });

  for (const style of ["glass", "dense"] as const) {
    test(`are the ones drawn in the ${style} style: the platform font of the text is ${style === "glass" ? "Geist" : "JetBrains Mono"}, a web font and not a system one`, async ({
      page,
    }) => {
      await start(page, "en", { style });
      await expectStyle(page, style, "dark");
      await page.evaluate(async () => {
        await document.fonts.ready;
        // A line in the mono font of the interface, next to the title of the window.
        const probe = document.createElement("span");
        probe.id = "mono-probe";
        probe.textContent = "Ctrl+Shift+P";
        probe.style.fontFamily = "var(--nr-font-mono)";
        document.body.append(probe);
        await document.fonts.load('400 13px "Geist Mono"');
        await document.fonts.load('400 13px "JetBrains Mono"');
      });
      const client = await page.context().newCDPSession(page);
      await client.send("DOM.enable");
      await client.send("CSS.enable");
      const platformFont = async (selector: string): Promise<string[]> => {
        const { root } = await client.send("DOM.getDocument", { depth: -1 });
        const { nodeId } = await client.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector,
        });
        const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
        return fonts.map(
          (font) => `${font.familyName}${font.isCustomFont ? " (web)" : " (system)"}`,
        );
      };
      const ui = await platformFont(".titlebar-title");
      expect(ui).toEqual([`${style === "glass" ? "Geist" : "JetBrains Mono"} (web)`]);
      const mono = await platformFont("#mono-probe");
      expect(mono).toEqual([`${style === "glass" ? "Geist Mono" : "JetBrains Mono"} (web)`]);
      await client.detach();
    });
  }

  test("load under the policy of the app, which allows fonts from the app itself and nothing else", async ({
    page,
  }) => {
    expect(POLICY).toContain("font-src 'self'");
    const violations: string[] = [];
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": POLICY },
      });
    });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as Window & { __violations?: string[] }).__violations ??= [];
        (window as Window & { __violations?: string[] }).__violations?.push(
          `${event.effectiveDirective} ${event.blockedURI}`,
        );
      });
    });
    page.on("console", (message) => {
      if (/content security policy|refused to/i.test(message.text()))
        violations.push(message.text());
    });
    await start(page, "en", { style: "dense" });
    const loaded = await page.evaluate(async () => {
      const faces = await document.fonts.load('700 13px "JetBrains Mono"');
      await document.fonts.ready;
      return faces.map((face) => face.status);
    });
    expect(loaded).toEqual(["loaded"]);
    const seen = await page.evaluate(
      () => (window as Window & { __violations?: string[] }).__violations ?? [],
    );
    expect(seen).toEqual([]);
    expect(violations).toEqual([]);
  });
});

test.describe("reduced transparency", () => {
  /** What a probe painted with the glass tokens computes to: its fill's alpha and its blur. */
  const probe = (page: Page) =>
    page.evaluate(() => {
      const el = document.createElement("div");
      el.style.background = "var(--nr-glass-side)";
      el.style.backdropFilter = "var(--nr-glass-blur-side)";
      const panel = document.createElement("div");
      panel.style.background = "var(--nr-glass-panel)";
      panel.style.backdropFilter = "var(--nr-glass-blur-panel)";
      document.body.append(el, panel);
      const alphaOf = (color: string): number => {
        // `color(srgb r g b / a)` and `rgb(r g b / a)` carry the alpha after a slash, `rgba(r, g, b, a)`
        // after a comma, and a solid `rgb(r, g, b)` has none.
        const slash = / \/ ([0-9.]+)\)$/.exec(color);
        if (slash?.[1] !== undefined) return Number(slash[1]);
        const comma = /^rgba\(.*, ([0-9.]+)\)$/.exec(color);
        return comma?.[1] === undefined ? 1 : Number(comma[1]);
      };
      const result = {
        sideAlpha: alphaOf(getComputedStyle(el).backgroundColor),
        panelAlpha: alphaOf(getComputedStyle(panel).backgroundColor),
        sideBlur: getComputedStyle(el).backdropFilter,
        panelBlur: getComputedStyle(panel).backdropFilter,
        reduced: window.matchMedia("(prefers-reduced-transparency: reduce)").matches,
      };
      el.remove();
      panel.remove();
      return result;
    });

  async function emulateReducedTransparency(page: Page): Promise<void> {
    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
  }

  test("the glass is see-through and blurred by default, and solid with no blur under prefers-reduced-transparency", async ({
    page,
  }) => {
    await start(page, "en", { style: "glass" });
    const normal = await probe(page);
    expect(normal.reduced).toBe(false);
    expect(normal.sideAlpha).toBeCloseTo(0.42, 2);
    expect(normal.panelAlpha).toBeCloseTo(0.62, 2);
    expect(normal.sideBlur).not.toBe("none");
    expect(normal.panelBlur).not.toBe("none");

    await emulateReducedTransparency(page);
    const reduced = await probe(page);
    expect(reduced.reduced).toBe(true);
    expect(reduced.sideAlpha).toBe(1);
    expect(reduced.panelAlpha).toBe(1);
    expect(reduced.sideBlur).toBe("none");
    expect(reduced.panelBlur).toBe("none");
  });

  test("the dense style is solid with no blur whatever the system says", async ({ page }) => {
    await start(page, "en", { style: "dense" });
    for (const reduce of [false, true]) {
      if (reduce) await emulateReducedTransparency(page);
      const seen = await probe(page);
      expect(seen.sideAlpha, `reduce ${reduce}`).toBe(1);
      expect(seen.panelAlpha, `reduce ${reduce}`).toBe(1);
      expect(seen.sideBlur, `reduce ${reduce}`).toBe("none");
      expect(seen.panelBlur, `reduce ${reduce}`).toBe("none");
    }
  });

  test("the glass is worked out from the theme, so a light theme gets a light glass", async ({
    page,
  }) => {
    await start(page, "en", { style: "glass", mode: "light" });
    const fill = await page.evaluate(() => {
      const el = document.createElement("div");
      el.style.background = "var(--nr-glass-panel)";
      document.body.append(el);
      const color = getComputedStyle(el).backgroundColor;
      el.remove();
      return color;
    });
    const channels = [...fill.matchAll(/[0-9.]+/g)].map((match) => Number(match[0]));
    // A color of the Paper theme (a pale background) at 62%: its channels are high, not near black.
    expect(channels.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0)).toBeGreaterThan(0.5);
  });
});

for (const lang of ["en", "pt-BR"] as const) {
  for (const mode of ["dark", "light"] as const) {
    for (const style of ["glass", "dense"] as const) {
      test(`axe: the window has no violation in the ${style} style (${lang}, ${mode})`, async ({
        page,
      }) => {
        await start(page, lang, { mode, style });
        await expectStyle(page, style, mode);
        await expectNoAxeViolations(page, `the window, ${style}, ${lang}, ${mode}`);
      });

      test(`axe: the style choice of the settings has no violation in the ${style} style (${lang}, ${mode})`, async ({
        page,
      }) => {
        const words = await start(page, lang, { mode, style });
        const screen = await openSettings(page, words);
        const row = await styleRow(screen, words);
        await expect(row.getByRole("radio")).toHaveCount(2);
        await expect(
          row.getByRole("radio", {
            name: style === "glass" ? words.glass : words.dense,
            exact: true,
          }),
        ).toBeChecked();
        await expectNoAxeViolations(page, `the settings, style choice, ${style}, ${lang}, ${mode}`);
      });
    }
  }
}
