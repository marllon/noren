import { expect, test } from "./test";
import type { Page } from "@playwright/test";
import { configText, openSettings, closeSettings, seedConfig } from "./settings-fixture";
import { seedSidebarState } from "./sidebar-fixture";
import { openCommandPalette } from "./palette-fixture";

// The languages of the interface: English and Brazilian Portuguese, with no library. With
// "language" on "system" (or not in the file) the language of the browser decides and English is
// the fallback; the settings screen changes it, writes it into `config.jsonc` (comments kept) and
// the interface follows at once, with no reload.

type TestHook = { paneIds(): string[] };
type TestWindow = Window & { __norenTest?: TestHook };

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.paneIds() ?? []);

const COMMENTED = `// My Noren settings, keep this line.
{
  /* where things go */
  "appearance": {
    "density": "comfortable", // I like it roomy
  },
}
`;

async function openMain(page: Page): Promise<void> {
  await seedSidebarState(page, { split: true, secondSpace: true });
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBeGreaterThan(0);
}

/** The words of the main window, the palette and the settings screen, in Portuguese. */
async function expectPortuguese(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(
    page.getByRole("complementary", { name: "Barra lateral", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tree", { name: "Abas", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nova aba", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Espaços", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Novo espaço", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Configurações", exact: true })).toBeVisible();
  // The pinned group of the sidebar and the name given to a tab with no title.
  await expect(page.getByRole("group", { name: "Fixadas", exact: true })).toBeVisible();

  // The palette: its name, its groups and the names of the actions.
  await openCommandPalette(page);
  const palette = page.locator('[data-nr-part="palette"]');
  await expect(
    palette.getByRole("combobox", { name: "Paleta de comandos", exact: true }),
  ).toBeVisible();
  await expect(palette.getByPlaceholder(/^Buscar abas, espaços e comandos/)).toBeVisible();
  await palette.getByRole("combobox").fill(">");
  await expect(palette.getByRole("option", { name: /Abrir as configurações/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /^Nova aba Abas/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /Dividir à direita/ })).toBeVisible();
  await expect(palette.getByText("Ações", { exact: true })).toBeVisible();
  await expect(palette.getByText("Geral", { exact: true }).first()).toBeVisible();
  await expect(palette.getByRole("option", { name: /Open settings/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // The settings screen: sections and labels.
  const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  await expect(screen).toBeVisible();
  await expect(screen.getByRole("heading", { name: "Aparência", exact: true })).toBeVisible();
  await expect(screen.getByRole("heading", { name: "Janela", exact: true })).toBeVisible();
  await expect(screen.getByRole("heading", { name: "Atalhos", exact: true })).toBeVisible();
  await expect(screen.getByRole("heading", { name: "Notificações", exact: true })).toBeVisible();
  await expect(screen.getByRole("combobox", { name: "Idioma", exact: true })).toBeVisible();
  await expect(screen.getByRole("radio", { name: "Esquerda", exact: true })).toBeVisible();
  await expect(
    screen.getByRole("textbox", { name: "Largura da barra lateral (px)" }),
  ).toBeVisible();
  await expect(screen.getByRole("switch", { name: "Modo compacto", exact: true })).toBeVisible();
  // No Save and no Cancel: the screen closes with its X, and every change is already written.
  await expect(screen.getByRole("button", { name: "Salvar", exact: true })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "Cancelar", exact: true })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "Fechar", exact: true })).toBeVisible();
  await expect(screen.getByText("Cada mudança é salva na hora.", { exact: true })).toBeVisible();

  // The shortcuts screen: opened from the settings, in Portuguese too.
  await screen.getByRole("button", { name: "Atalhos de teclado", exact: true }).click();
  const shortcuts = page.getByRole("dialog", { name: "Atalhos de teclado", exact: true });
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.getByRole("textbox", { name: "Buscar atalhos" })).toBeVisible();
  await expect(shortcuts.getByText("Nova aba", { exact: true }).first()).toBeVisible();
  await expect(shortcuts.getByRole("button", { name: "Fechar", exact: true })).toBeVisible();
  await shortcuts.getByRole("button", { name: "Fechar", exact: true }).click();
  await screen.getByRole("button", { name: "Fechar", exact: true }).click();
  await expect(screen).toHaveCount(0);
}

test("changing the language to Portuguese in the settings translates the interface at once", async ({
  page,
}) => {
  await seedConfig(page, COMMENTED);
  await openMain(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("tree", { name: "Tabs", exact: true })).toBeVisible();

  const screen = await openSettings(page);
  // The language is a drop-down list: four or more options would be a tall stack of radio buttons.
  const language = screen.getByRole("combobox", { name: "Language", exact: true });
  await expect(language).toHaveValue("system");
  await expect(
    language.getByRole("option", { name: "Same as the system", exact: true }),
  ).toBeAttached();
  await language.selectOption({ label: "Português (Brasil)" });

  // No reload, and no wait for a Save: the same page, the open screen too, speaks Portuguese now.
  const portuguese = page.getByRole("dialog", { name: "Configurações", exact: true });
  await expect(portuguese).toBeVisible();
  await expect(portuguese.getByRole("combobox", { name: "Idioma", exact: true })).toHaveValue(
    "pt-BR",
  );
  await portuguese.getByRole("button", { name: "Fechar", exact: true }).click();
  await expect(portuguese).toHaveCount(0);
  await expectPortuguese(page);

  // The file has the language, and the comments of the person are where they were.
  const text = (await configText(page)) ?? "";
  expect(text).toContain('"language": "pt-BR"');
  expect(text).toContain("// My Noren settings, keep this line.");
  expect(text).toContain("/* where things go */");
  expect(text).toContain("// I like it roomy");
});

test("the language chosen stays after a reload, and can go back to English", async ({ page }) => {
  await seedConfig(page, COMMENTED);
  await openMain(page);
  const screen = await openSettings(page);
  await screen
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption({ label: "Português (Brasil)" });
  await expect(page.getByRole("tree", { name: "Abas", exact: true })).toBeVisible();
  await page
    .getByRole("dialog", { name: "Configurações", exact: true })
    .getByRole("button", { name: "Fechar", exact: true })
    .click();

  await page.reload();
  await expect(page.getByRole("tree", { name: "Abas", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");

  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  const portuguese = page.getByRole("dialog", { name: "Configurações", exact: true });
  const idioma = portuguese.getByRole("combobox", { name: "Idioma", exact: true });
  await expect(idioma).toHaveValue("pt-BR");
  await idioma.selectOption({ label: "English" });
  // Back to English at once, the open screen included.
  await expect(portuguese).toHaveCount(0);
  await closeSettings(page);

  await expect(page.getByRole("tree", { name: "Tabs", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect((await configText(page)) ?? "").toContain('"language": "en"');
});

test.describe("with the browser in Brazilian Portuguese", () => {
  test.use({ locale: "pt-BR" });

  test("a file that does not say the language opens in Portuguese", async ({ page }) => {
    await openMain(page);
    await expectPortuguese(page);
  });

  test("language system opens in Portuguese", async ({ page }) => {
    await seedConfig(page, '{ "language": "system" }');
    await openMain(page);
    await expectPortuguese(page);
  });

  test("a language chosen in the file wins over the browser's", async ({ page }) => {
    await seedConfig(page, '{ "language": "en" }');
    await openMain(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("tree", { name: "Tabs", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeVisible();
  });
});

test.describe("with the browser in a language Noren does not have", () => {
  test.use({ locale: "fr-FR" });

  test("the interface is in English", async ({ page }) => {
    await openMain(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("tree", { name: "Tabs", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeVisible();
  });
});
