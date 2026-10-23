import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";

// Baselines are per operating system (Windows only, D7): `pnpm e2e:visual`. The settings screen of the
// dense style (NOR-F20-21b): the page of the window with its header, its numbered column of sections,
// its search, its boxes of rows and its strip at the foot, at its Appearance (the two cards of the
// interface style first, in the glass screen's baseline of the dense Appearance), Themes, Background,
// Terminal and Profiles sections, in the dark and the light scheme and in both languages. The capture is
// of the screen, which fills the window under the title bar.

type Language = "en" | "pt-BR";

interface Shot {
  name: string;
  scheme: "dark" | "light";
  language: Language;
  /** The section the screen is brought to the top of (Appearance is already). */
  section: string;
}

const SHOTS: readonly Shot[] = [
  { name: "appearance-light-ptbr", scheme: "light", language: "pt-BR", section: "appearance" },
  { name: "themes-dark", scheme: "dark", language: "en", section: "themes" },
  { name: "background-light", scheme: "light", language: "en", section: "background" },
  { name: "terminal-dark-ptbr", scheme: "dark", language: "pt-BR", section: "terminal" },
  { name: "profiles-light", scheme: "light", language: "en", section: "profiles" },
];

const SETTINGS: Record<Language, string> = { en: "Settings", "pt-BR": "Configurações" };
const THEME = { dark: "noren-dusk", light: "noren-paper" } as const;

async function open(page: Page, shot: Shot): Promise<Locator> {
  const lang = shot.language === "pt-BR" ? '"language": "pt-BR", ' : "";
  await seedConfig(
    page,
    `{ ${lang}"appearance": { "theme": "${THEME[shot.scheme]}", "style": "dense" } }\n`,
  );
  await page.goto("/");
  // The terminal takes the focus once its shell is up; nothing is clicked before that.
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeFocused();
  await page.getByRole("button", { name: SETTINGS[shot.language], exact: true }).first().click();
  const screen = page.getByRole("dialog", { name: SETTINGS[shot.language], exact: true });
  await expect(screen).toBeVisible();
  const content = screen.locator('[data-nr-part="settings-content"]');
  if (shot.section !== "appearance") {
    await screen.locator(`[data-nr-part="settings-nav-${shot.section}"]`).click();
    // The section is at the top of the content: the scroll has settled.
    await expect
      .poll(() =>
        screen.evaluate((root, id) => {
          const area = root.querySelector('[data-nr-part="settings-content"]');
          const section = root.querySelector(`[data-nr-part="settings-${id}"]`);
          if (area === null || section === null) return 9999;
          return Math.round(section.getBoundingClientRect().top - area.getBoundingClientRect().top);
        }, shot.section),
      )
      .toBeLessThanOrEqual(34);
  } else {
    await content.evaluate((el) => (el.scrollTop = 0));
  }
  // Nothing hovered, nothing focused (the search has the focus when the screen opens and its ring would
  // be in every picture), every animation finished, the type loaded.
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
  return screen;
}

for (const shot of SHOTS) {
  test.describe(`${shot.name}`, () => {
    test.use({ colorScheme: shot.scheme, viewport: { width: 1280, height: 800 } });

    test(`@visual the dense settings screen at ${shot.section} (${shot.scheme}, ${shot.language})`, async ({
      page,
    }) => {
      const screen = await open(page, shot);
      await expect(screen).toHaveScreenshot(`settings-dense-${shot.name}.png`, {
        animations: "disabled",
        caret: "hide",
      });
    });
  });
}
