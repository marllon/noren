import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";

// Baselines are per operating system (Windows only, D7): `pnpm e2e:visual`. The settings screen of the
// glass style (NOR-F20-19): the card of glass over the window with its header, its column of sections
// and its rows, at its Appearance (the cards of the interface style first), Themes and Background
// sections, in the dark and the light scheme and in both languages; and the same screen under the
// dense style, which did not change. The capture is of the card.

type Language = "en" | "pt-BR";

interface Shot {
  name: string;
  scheme: "dark" | "light";
  language: Language;
  style: "glass" | "dense";
  /** The section the screen is brought to the top of (Appearance is already). */
  section: string;
}

const SHOTS: readonly Shot[] = [
  {
    name: "appearance-dark",
    scheme: "dark",
    language: "en",
    style: "glass",
    section: "appearance",
  },
  {
    name: "appearance-light-ptbr",
    scheme: "light",
    language: "pt-BR",
    style: "glass",
    section: "appearance",
  },
  { name: "themes-dark", scheme: "dark", language: "en", style: "glass", section: "themes" },
  {
    name: "background-light",
    scheme: "light",
    language: "en",
    style: "glass",
    section: "background",
  },
  {
    name: "dense-appearance-dark",
    scheme: "dark",
    language: "en",
    style: "dense",
    section: "appearance",
  },
];

const SETTINGS: Record<Language, string> = { en: "Settings", "pt-BR": "Configurações" };
const THEME = { dark: "noren-dusk", light: "noren-paper" } as const;

async function open(page: Page, shot: Shot): Promise<Locator> {
  const lang = shot.language === "pt-BR" ? '"language": "pt-BR", ' : "";
  await seedConfig(
    page,
    `{ ${lang}"appearance": { "theme": "${THEME[shot.scheme]}", "style": "${shot.style}" } }\n`,
  );
  await page.goto("/");
  // The terminal takes the focus once its shell is up; nothing is clicked before that.
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeFocused();
  await page.getByRole("button", { name: SETTINGS[shot.language], exact: true }).first().click();
  const screen = page.getByRole("dialog", { name: SETTINGS[shot.language], exact: true });
  await expect(screen).toBeVisible();
  if (shot.section !== "appearance") {
    await screen.locator(`[data-nr-part="settings-nav-${shot.section}"]`).click();
    // The section is at the top of the content: the scroll has settled.
    await expect
      .poll(() =>
        screen.evaluate((root, id) => {
          const content = root.querySelector('[data-nr-part="settings-content"]');
          const section = root.querySelector(`[data-nr-part="settings-${id}"]`);
          if (content === null || section === null) return 9999;
          return Math.round(
            section.getBoundingClientRect().top - content.getBoundingClientRect().top,
          );
        }, shot.section),
      )
      .toBeLessThanOrEqual(34);
  } else {
    await screen.locator('[data-nr-part="settings-content"]').evaluate((el) => (el.scrollTop = 0));
  }
  // Nothing hovered, nothing focused, every animation (the sheet coming in, the scroll) finished, the type loaded.
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

    test(`@visual the ${shot.style} settings screen at ${shot.section} (${shot.scheme}, ${shot.language})`, async ({
      page,
    }) => {
      const screen = await open(page, shot);
      await expect(screen).toHaveScreenshot(`settings-${shot.name}.png`, {
        animations: "disabled",
        caret: "hide",
      });
    });
  });
}
