import { readFileSync } from "node:fs";
import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { NOREN_DUSK } from "../packages/model/src/builtin-themes";
import type { Theme } from "../packages/model/src/theme";
import { serializeTheme } from "../packages/model/src/user-themes";
import { seedConfig } from "./settings-fixture";

// Baselines are per operating system (Windows only): `pnpm e2e:visual`. The theme editor of the
// glass style (NOR-F20-20): the card of glass with its header, the preview over the night landscape
// and the column of boxes, at its top (the kind, the colors), in the dark and the light scheme and in
// both languages; at its Font group (the sliders and the switch) and at its picture (the card, with
// a picture on the preview) for a theme of the person; and the dense editor at its Font group, which
// has its own look since NOR-F20-21c (its other pictures are in dense-editor.visual.spec.ts). The capture
// is of the card.

type Language = "en" | "pt-BR";

interface Shot {
  name: string;
  scheme: "dark" | "light";
  language: Language;
  style: "glass" | "dense";
  /** The group the column of boxes is scrolled to the top of (none: the top of the column). */
  group?: string;
  /** Edits a theme of the person that has a picture, instead of the theme in force. */
  own?: boolean;
}

const SHOTS: readonly Shot[] = [
  { name: "dark", scheme: "dark", language: "en", style: "glass" },
  { name: "light-ptbr", scheme: "light", language: "pt-BR", style: "glass" },
  { name: "font-dark", scheme: "dark", language: "en", style: "glass", group: "font", own: true },
  {
    name: "picture-light",
    scheme: "light",
    language: "en",
    style: "glass",
    group: "picture",
    own: true,
  },
  { name: "dense-dark", scheme: "dark", language: "en", style: "dense", group: "font" },
];

const SETTINGS: Record<Language, string> = { en: "Settings", "pt-BR": "Configurações" };
const TITLE: Record<Language, string> = { en: "Theme editor", "pt-BR": "Editor de tema" };
const THEME = { dark: "noren-dusk", light: "noren-paper" } as const;
const PICTURE = "fixtures/background.png";
const FIXTURE = readFileSync(new URL("./fixtures/background.png", import.meta.url));

/** A theme of the person with a picture, a font of its own and the ligatures off. */
const MINE: Theme = {
  ...NOREN_DUSK,
  id: "mine",
  name: "Mine",
  ui: { ...NOREN_DUSK.ui, accent: "#10b981", radius: 8 },
  font: { family: "Fira Code", size: 15, lineHeight: 1.3, ligatures: false },
  background: { image: PICTURE, opacity: 0.4, blur: 5 },
};

async function open(page: Page, shot: Shot): Promise<Locator> {
  const lang = shot.language === "pt-BR" ? '"language": "pt-BR", ' : "";
  await seedConfig(
    page,
    `{ ${lang}"appearance": { "theme": "${THEME[shot.scheme]}", "style": "${shot.style}" } }\n`,
  );
  for (const [key, value] of [
    ["noren.web.themes", JSON.stringify(shot.own === true ? { mine: serializeTheme(MINE) } : {})],
    ["noren.web.images", JSON.stringify({ [PICTURE]: FIXTURE.toString("base64") })],
  ] as const) {
    await page.addInitScript(
      ({ k, v }) => {
        if (window.localStorage.getItem(k) === null) window.localStorage.setItem(k, v);
      },
      { k: key, v: value },
    );
  }
  await page.goto("/");
  // The terminal takes the focus once its shell is up; nothing is clicked before that.
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeFocused();
  await page.getByRole("button", { name: SETTINGS[shot.language], exact: true }).first().click();
  const screen = page.getByRole("dialog", { name: SETTINGS[shot.language], exact: true });
  await expect(screen).toBeVisible();
  const id = shot.own === true ? "mine" : THEME[shot.scheme];
  const card = screen.locator(`[data-nr-part="theme-card"][data-nr-theme="${id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-nr-action="edit"]').click();
  const editor = page.getByRole("dialog", { name: TITLE[shot.language], exact: true });
  await expect(editor).toBeVisible();
  if (shot.own === true) {
    await expect(editor.locator('[data-nr-part="theme-preview"]')).toHaveAttribute(
      "data-nr-picture",
      "shown",
    );
  }
  // The column is at the top of the group asked for, and the scroll has settled.
  await editor.locator(".theme-editor-controls").evaluate((controls, group) => {
    const target =
      group === undefined
        ? null
        : controls.querySelector<HTMLElement>(`[data-nr-group="${group}"]`);
    controls.scrollTop =
      target === null ? 0 : target.offsetTop - (controls as HTMLElement).offsetTop;
  }, shot.group);
  // The picture of the card is loaded before the capture.
  if (shot.group === "picture") {
    await expect
      .poll(() =>
        editor
          .locator('[data-nr-part="background-thumbnail"]')
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
  }
  // Nothing hovered, nothing focused (the name is selected when the editor opens), every animation
  // finished, the type loaded.
  await page.mouse.move(2, 2);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  return editor;
}

for (const shot of SHOTS) {
  test.describe(`${shot.name}`, () => {
    test.use({ colorScheme: shot.scheme, viewport: { width: 1280, height: 800 } });

    test(`@visual the ${shot.style} theme editor${shot.group === undefined ? "" : ` at ${shot.group}`} (${shot.scheme}, ${shot.language})`, async ({
      page,
    }) => {
      const editor = await open(page, shot);
      await expect(editor).toHaveScreenshot(`editor-${shot.name}.png`, {
        animations: "disabled",
        caret: "hide",
      });
    });
  });
}
