import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { en } from "../apps/desktop/src/i18n/en";
import { ptBR } from "../apps/desktop/src/i18n/pt-BR";
import { JSON_PROFILES_FILE } from "../packages/model/src/import-fixtures";
import { seedConfig } from "./settings-fixture";
import { ACTIONS_CWD, ACTIONS_TEXT, seedActionsFile, seedSidebarState } from "./sidebar-fixture";
import { numberTheTabs } from "./numbered-tabs";

test.beforeEach(numberTheTabs);

// The rest of the interface in Brazilian Portuguese (the main screens are in `i18n.spec.ts`): every
// screen below is opened with "language" on "pt-BR" in the file and must show its words in
// Portuguese, and none of what it shows, as text or as a label, may be a word of the English
// dictionary that has a different Portuguese one. The browser stays on en-US, so it is the setting
// of the file that does it.

interface Hook {
  paneIds(): string[];
  lines(): string[];
  setConfig(text: string | null): void;
  setAiReply(text: string | null): void;
  aiChats(): { messages: { role: string; content: string }[] }[];
}
type HookWindow = Window & { __norenTest?: Hook };

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const PT = '{ "language": "pt-BR" }\n';
const WEB_AI_OLLAMA_KEY = "noren.web.ai-ollama";

const KEYS = Object.keys(en) as (keyof typeof en)[];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches a text of the English dictionary whole, with each `{value}` standing for anything. */
const ENGLISH_TEXTS: { key: string; pattern: RegExp }[] = KEYS.flatMap((key) =>
  en[key] === ptBR[key]
    ? []
    : [
        {
          key,
          pattern: new RegExp(
            `^${en[key]
              .split(/\{\w+\}/)
              .map(escapeRegExp)
              .join(".+")}$`,
          ),
        },
      ],
);

/** Every text a person sees inside `scope`, and every label, placeholder and tooltip it has. */
async function shownTexts(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const seen = new Set<string>();
    const visible = (element: Element | null): boolean =>
      element !== null && element.checkVisibility({ visibilityProperty: true });
    const skipped = (element: Element | null): boolean => element?.closest(".xterm") != null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = (node.textContent ?? "").trim();
      if (text !== "" && visible(parent) && !skipped(parent)) seen.add(text);
    }
    const labelled = [root, ...root.querySelectorAll("[aria-label],[placeholder],[title],[alt]")];
    for (const element of labelled) {
      if (!visible(element) || skipped(element)) continue;
      for (const name of ["aria-label", "placeholder", "title", "alt"]) {
        const value = element.getAttribute(name)?.trim();
        if (value) seen.add(value);
      }
    }
    return [...seen];
  });
}

/** The texts of `scope` that are English words of the dictionary, with the key they came from. */
async function englishLeft(scope: Locator): Promise<string[]> {
  const texts = await shownTexts(scope);
  return texts.flatMap((text) =>
    ENGLISH_TEXTS.filter(({ pattern }) => pattern.test(text)).map(({ key }) => `${key}: ${text}`),
  );
}

async function expectNoEnglish(scope: Locator): Promise<void> {
  expect(await englishLeft(scope)).toEqual([]);
}

const paneCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0);
const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);

async function waitForShell(page: Page): Promise<void> {
  await expect.poll(() => paneCount(page)).toBeGreaterThan(0);
  await expect.poll(async () => (await lines(page)).some((l) => l.startsWith("fake$"))).toBe(true);
}

/** Opens the app with `config` as the file; the shell is up and has the keyboard. */
async function start(page: Page, config: string = PT): Promise<void> {
  await seedConfig(page, config);
  await page.goto("/");
  await waitForShell(page);
  await page.locator('[data-nr-part="pane"]:visible').click();
}

const sidebar = (page: Page): Locator =>
  page.getByRole("complementary", { name: "Barra lateral", exact: true });
const treeOf = (page: Page): Locator => page.getByRole("tree", { name: "Abas", exact: true });
const tabNamed = (page: Page, name: string): Locator =>
  treeOf(page).getByRole("treeitem", { name, exact: true });
const menuItem = (page: Page, name: string): Locator =>
  page.getByRole("menuitem", { name, exact: true });
const button = (scope: Locator | Page, name: string): Locator =>
  scope.getByRole("button", { name, exact: true });

/** Runs `echo <word>` in the terminal on screen and waits for its output. */
async function say(page: Page, word: string): Promise<void> {
  await page.keyboard.type(`echo ${word}`);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await lines(page)).includes(word)).toBe(true);
}

test.describe("the sidebar and the notices", () => {
  test("the notice of a problem with config.jsonc", async ({ page }) => {
    await start(page);
    await page.evaluate(
      (text) => (window as HookWindow).__norenTest?.setConfig(text),
      '{ "language": "pt-BR", "appearance": { "sidebar": { "width": 5000 } } }',
    );
    const notice = page.locator('[data-nr-part="config-notice"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(
      "O arquivo de configurações tem um problema, então as últimas configurações válidas continuam em uso.",
    );
    await expect(button(notice, "Dispensar")).toBeVisible();
    await expectNoEnglish(notice);
    await button(notice, "Dispensar").click();
    await expect(notice).toHaveCount(0);
  });

  test("the actions of the project and the favorites", async ({ page }) => {
    await seedSidebarState(page, { cwd: ACTIONS_CWD });
    await seedActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
    await seedConfig(page, PT);
    await page.goto("/");
    await expect(tabNamed(page, "api")).toBeVisible();

    const header = page.getByRole("region", { name: "Ações do projeto", exact: true });
    await expect(header).toBeVisible();
    await expect(button(header, "Iniciar Loop")).toBeVisible();
    await expect(button(header, "Iniciar Dev server")).toBeVisible();
    await expect(header.getByTitle("Parada")).toHaveCount(2);

    // A favorite gives the grid, whose label is a word of the interface.
    await tabNamed(page, "api").click({ button: "right" });
    await menuItem(page, ptBR["menu.addFavorite"]).click();
    const grid = page.getByRole("region", { name: "Favoritos", exact: true });
    await expect(grid).toBeVisible();

    await expectNoEnglish(sidebar(page));
  });

  test("the peek of a tab, the switcher and the search over every tab", async ({ page }) => {
    await start(page);
    await say(page, "alpha");
    for (const word of ["beta", "gamma"]) {
      await page.getByRole("button", { name: "Nova aba", exact: true }).click();
      await expect
        .poll(async () => (await lines(page)).some((l) => l.startsWith("fake$")))
        .toBe(true);
      await say(page, word);
    }
    await expect(treeOf(page).getByRole("treeitem")).toHaveCount(3);

    // The switcher of Ctrl+Tab: its list and the preview of a tab.
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const switcher = page.getByRole("listbox", { name: "Abas recentes", exact: true });
    await expect(switcher).toBeVisible();
    await expect(switcher.getByRole("option")).toHaveCount(3);
    await expectNoEnglish(switcher);
    await page.keyboard.up("Control");
    await expect(switcher).toHaveCount(0);

    // The search over the output of every open tab.
    await page.keyboard.press("Control+Shift+Alt+F");
    const search = page.getByRole("dialog", { name: "Buscar em todas as abas", exact: true });
    await expect(search).toBeVisible();
    await expect(
      search.getByText("Digite para buscar na saída de todas as abas abertas.", { exact: true }),
    ).toBeVisible();
    await expectNoEnglish(search);
    const box = search.getByRole("textbox", { name: "Buscar texto em todas as abas", exact: true });
    await expect(box).toHaveAttribute("placeholder", "Buscar na saída de todas as abas abertas");
    await box.fill("alpha");
    await expect(search.getByRole("listbox", { name: "Resultados", exact: true })).toBeVisible();
    await expect(search.getByRole("option").first()).toBeVisible();
    await expectNoEnglish(search);
    await box.fill("nothing-like-this");
    await expect(search.getByText("Nenhum resultado", { exact: true })).toBeVisible();
    await expectNoEnglish(search);
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);

    // The peek: rest the pointer on a tab.
    await tabNamed(page, "Aba 1").hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toBeVisible();
    await expectNoEnglish(tip);
  });
});

test.describe("the library and the dialogs of a space", () => {
  test("the library, its sections and the confirmation to delete", async ({ page }) => {
    await seedSidebarState(page);
    await seedConfig(page, PT);
    await page.goto("/");
    await expect(tabNamed(page, "api")).toBeVisible();
    await tabNamed(page, "api").click();
    // A tab closed goes to the stack the library lists under "Fechadas".
    await page.keyboard.press("Control+Shift+W");
    await expect(tabNamed(page, "api")).toHaveCount(0);

    await page.keyboard.press("Control+Alt+Shift+L");
    const library = page.getByRole("dialog", { name: "Biblioteca", exact: true });
    await expect(library).toBeVisible();
    const sections = library.getByRole("tablist", { name: "Seções da biblioteca", exact: true });
    await expect(sections.getByRole("tab", { name: /^Arquivo/ })).toBeVisible();
    await expect(library.getByRole("textbox", { name: "Buscar na biblioteca" })).toHaveAttribute(
      "placeholder",
      "Buscar por título, pasta ou saída",
    );
    await expect(library.getByText("Nada no arquivo ainda.", { exact: true })).toBeVisible();
    await expectNoEnglish(library);

    await sections.getByRole("tab", { name: /^Fechadas/ }).click();
    await expect(library.getByRole("list", { name: "Fechadas", exact: true })).toBeVisible();
    await expect(library.getByRole("button", { name: /^Restaurar api / })).toBeVisible();
    await library.getByRole("textbox", { name: "Buscar na biblioteca" }).fill("zzz-nothing");
    await expect(library.getByText("Nenhum resultado", { exact: true })).toBeVisible();
    await expectNoEnglish(library);
    await library.getByRole("textbox", { name: "Buscar na biblioteca" }).fill("");

    await button(library, "Excluir api").click();
    const confirm = page.getByRole("alertdialog", { name: "Excluir da biblioteca", exact: true });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(
      'Excluir "api" de vez? A saída salva dela é excluída junto.',
    );
    await expect(button(confirm, "Cancelar")).toBeVisible();
    await expectNoEnglish(confirm);
    await button(confirm, "Cancelar").click();
    await expect(confirm).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(library).toHaveCount(0);
  });

  test("the dialog to make and edit a space, and the one for its picture", async ({ page }) => {
    await start(page);
    await button(page, "Novo espaço").click();
    const made = page.getByRole("dialog", { name: "Novo espaço", exact: true });
    await expect(made).toBeVisible();
    await expect(made.getByRole("textbox", { name: "Nome", exact: true })).toBeVisible();
    await expect(made.getByRole("group", { name: "Cor", exact: true })).toBeVisible();
    await expect(made.getByRole("radio", { name: "Azul", exact: true })).toBeVisible();
    await expect(made.getByRole("group", { name: "Ícone", exact: true })).toBeVisible();
    await expect(made.getByRole("radio", { name: "Foguete", exact: true })).toBeVisible();
    await expect(made.getByRole("textbox", { name: "Pasta inicial", exact: true })).toBeVisible();
    await expect(made.getByRole("textbox", { name: "Variáveis de ambiente" })).toHaveAttribute(
      "placeholder",
      "NOME=valor, uma por linha",
    );
    await expectNoEnglish(made);
    // A name is asked for before anything is made.
    await button(made, "Criar espaço").click();
    await expect(made.getByRole("alert")).toHaveText("Dê um nome ao espaço.");
    await expectNoEnglish(made);
    await made.getByRole("textbox", { name: "Nome", exact: true }).fill("Casa");
    await button(made, "Criar espaço").click();
    await expect(made).toHaveCount(0);

    const switcher = page.getByRole("navigation", { name: "Espaços", exact: true });
    await switcher.getByRole("button", { name: "Casa", exact: true }).click({ button: "right" });
    await menuItem(page, "Editar espaço…").click();
    const edited = page.getByRole("dialog", { name: "Editar espaço", exact: true });
    await expect(edited).toBeVisible();
    await expect(button(edited, "Salvar")).toBeVisible();
    await expectNoEnglish(edited);
    await button(edited, "Cancelar").click();
    await expect(edited).toHaveCount(0);

    await switcher.getByRole("button", { name: "Casa", exact: true }).click({ button: "right" });
    await menuItem(page, "Imagem de fundo…").click();
    const picture = page.getByRole("dialog", { name: "Imagem de fundo", exact: true });
    await expect(picture).toBeVisible();
    await expect(picture).toContainText(
      "Um arquivo de imagem deste computador para o espaço “Casa”",
    );
    await expect(picture.getByRole("textbox", { name: "Arquivo da imagem" })).toBeVisible();
    await expect(picture.getByRole("textbox", { name: "Opacidade (0 a 1)" })).toBeVisible();
    await expect(picture.getByRole("textbox", { name: "Desfoque (px)" })).toBeVisible();
    await expect(button(picture, "Remover imagem")).toBeDisabled();
    await expect(button(picture, "Aplicar")).toBeVisible();
    await expectNoEnglish(picture);
  });

  test("the question before a paste of several lines", async ({ page }) => {
    await start(page);
    const text = ["echo one", "echo two", "echo three"].join("\n");
    await page.evaluate((value) => navigator.clipboard.writeText(value), text);
    await page.keyboard.press("Control+Shift+V");
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Colar 3 linhas?", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText("Cada linha pode ser executada como um comando.")).toBeVisible();
    await expect(button(dialog, "Cancelar")).toBeVisible();
    await expect(button(dialog, "Colar")).toBeVisible();
    await expectNoEnglish(dialog);
    await button(dialog, "Cancelar").click();
    await expect(dialog).toBeHidden();
  });
});

test.describe("the import of profiles and the quick window", () => {
  test("the preview of what importing a settings file would add", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "noren.web.profiles",
        JSON.stringify([
          { id: "fake", name: "Fake shell", default: true },
          { id: "git-bash", name: "Git Bash", default: false },
        ]),
      );
    });
    await start(page);
    await page.getByRole("button", { name: "Configurações", exact: true }).click();
    const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
    await expect(screen).toBeVisible();

    const chooser = page.waitForEvent("filechooser");
    await button(screen, "Importar perfis...").click();
    await (
      await chooser
    ).setFiles({
      name: "settings.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON_PROFILES_FILE, "utf8"),
    });
    const preview = page.getByRole("dialog", { name: "Importar perfis", exact: true });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(
      'perfis de "settings.json" serão adicionados ao config.jsonc.',
    );
    await expect(
      preview.getByRole("list", { name: "Perfis a importar", exact: true }),
    ).toBeVisible();
    await expect(preview.locator('[data-nr-part="profile-import-hidden"]')).toHaveText(
      "1 perfil oculto no arquivo foi ignorado.",
    );
    await expect(preview.locator('[data-nr-part="profile-import-skipped"]')).toContainText(
      "Deixados de fora: No Command",
    );
    await expect(button(preview, "Cancelar")).toBeVisible();
    await expect(button(preview, "Importar 5 perfis")).toBeVisible();
    await expectNoEnglish(preview);

    await button(preview, "Importar 5 perfis").click();
    await expect(preview).toHaveCount(0);
    await expect(page.locator('[data-nr-part="settings-import-status"]')).toContainText(
      'Importados 5 perfis: "Git Bash (2)", "Dev Shell" e mais 3. Abra um com "Nova aba ..." na paleta de comandos.',
    );
  });

  test("the quick window", async ({ page }) => {
    await seedConfig(page, PT);
    await page.goto("/?quick-preview");
    await waitForShell(page);
    // In the real app the quick window reads no settings and follows the language of the system;
    // in this page it shares the language of the app drawn next to it.
    const panel = page.locator('[data-nr-part="quick-preview"]');
    await page.evaluate(() =>
      (window as HookWindow & { __norenQuick?: { show(): Promise<void> } }).__norenQuick?.show(),
    );
    await expect(panel).toHaveAttribute("aria-label", "Prévia da janela rápida");
    await expect(panel.getByText("Terminal rápido", { exact: true })).toBeVisible();
    await expect(button(panel, "Promover a aba")).toBeVisible();
    await expectNoEnglish(panel);
  });
});

test.describe("the AI", () => {
  const FILE_ON = `{
  "language": "pt-BR",
  "ai": { "enabled": true, "defaults": { "ask": { "provider": "ollama", "model": "llama3" } } }
}
`;
  const FILE_UNNAMED = `{ "language": "pt-BR", "ai": { "enabled": true } }\n`;

  async function startAi(page: Page, file: string, models: string[] | null): Promise<void> {
    if (models !== null) {
      await page.addInitScript(
        ({ key, value }) => {
          if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
        },
        { key: WEB_AI_OLLAMA_KEY, value: JSON.stringify(models) },
      );
    }
    await start(page, file);
  }

  const askPanel = (page: Page): Locator =>
    page.getByRole("complementary", { name: "Perguntar", exact: true });

  test("the Ask panel: chips, preview of what is sent, the answer and the code block", async ({
    page,
  }) => {
    await startAi(page, FILE_ON, ["llama3"]);
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setAiReply("Tente isto:\n\n```sh\nls -la\n```\n"),
    );
    await page.keyboard.press("Control+Shift+A");
    const panel = askPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Perguntar", exact: true })).toBeVisible();
    await expect(panel.locator('[data-nr-part="ask-target"]')).toHaveText("Ollama · llama3");
    const chips = panel.getByRole("group", { name: "Contexto", exact: true });
    for (const name of ["Seleção", "Última saída", "Tela", "@ Aba"]) {
      await expect(button(chips, name)).toBeVisible();
    }
    await expect(button(panel, "Fechar Perguntar")).toBeVisible();
    await expect(panel.locator('[data-nr-part="ask-empty"]')).toContainText(
      "Pergunte sobre o seu shell ou o seu trabalho.",
    );
    // The tabs that can be added.
    await button(chips, "@ Aba").click();
    await expect(
      panel.getByRole("group", { name: "Abas para adicionar", exact: true }),
    ).toBeVisible();
    await expect(panel.getByText("Não há outra aba.", { exact: true })).toBeVisible();
    await button(chips, "@ Aba").click();
    // A chip with nothing to read says so in the preview.
    await button(chips, "Seleção").click();
    const box = panel.getByRole("textbox", { name: "Pergunta", exact: true });
    await expect(box).toHaveAttribute(
      "placeholder",
      "Faça uma pergunta (Enter para ver a prévia, Shift+Enter para nova linha)",
    );
    await expectNoEnglish(panel);

    await box.fill("Como listo os arquivos?");
    await box.press("Enter");
    const review = panel.getByRole("region", { name: "Prévia do que será enviado", exact: true });
    await expect(review).toBeVisible();
    await expect(review).toContainText(
      "Isto vai para Ollama · llama3. Nada é enviado até você pressionar Enviar.",
    );
    await expect(review.locator('[data-nr-part="ask-secrets"]')).toHaveText(
      "Nenhum segredo foi encontrado no que será enviado.",
    );
    await expect(review).toContainText("Seleção: nada está selecionado no terminal.");
    await expect(button(review, "Enviar")).toBeVisible();
    await expect(button(review, "Editar")).toBeVisible();
    await expectNoEnglish(panel);

    await button(review, "Enviar").click();
    const exchange = panel.locator('[data-nr-part="ask-exchange"][data-nr-state="done"]');
    await expect(exchange).toHaveCount(1);
    await expect(exchange).toHaveAttribute("aria-label", "Pergunta: Como listo os arquivos?");
    await expectNoEnglish(panel);
    await button(exchange, "Inserir no terminal").click();
    await expect(panel.locator('[data-nr-part="ask-note"]')).toHaveText(
      "Colocado no prompt. Só é executado quando você pressiona Enter no terminal.",
    );
    await expectNoEnglish(panel);
  });

  test("the Ask panel with nothing to answer with gives the steps", async ({ page }) => {
    await startAi(page, FILE_UNNAMED, []);
    await page.keyboard.press("Control+Shift+A");
    const panel = askPanel(page);
    await expect(panel).toBeVisible();
    const steps = panel.locator('[data-nr-part="ask-steps"]');
    await expect(steps).toBeVisible();
    await expect(steps).toContainText(
      "Nada pode responder ainda. Para obter uma primeira resposta:",
    );
    await expect(steps.getByRole("listitem")).toHaveCount(3);
    await expect(steps).toContainText("Depois feche este painel e abra de novo.");
    await expect(steps).toContainText("escolha o provedor e o modelo para Perguntar");
    await expect(panel.locator('[data-nr-part="ask-target"]')).toHaveText("Nenhum provedor");
    await expectNoEnglish(panel);
  });

  test("Explain opens Ask with the command that failed", async ({ page }) => {
    await startAi(page, FILE_ON, ["llama3"]);
    await page.keyboard.type("nosuchcmd --flag");
    await page.keyboard.press("Enter");
    const explain = page.locator('[data-nr-part="pane"]:visible [data-nr-part="explain-button"]');
    await expect(explain).toHaveCount(1);
    await explain.click();
    const panel = askPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-nr-part="ask-explain-chip"]')).toContainText(
      "Comando: fake$ nosuchcmd --flag",
    );
    await expect(button(panel, "Remover o comando")).toBeVisible();
    await expect(panel.getByRole("region", { name: "Prévia do que será enviado" })).toContainText(
      "Por que este comando falhou e como eu corrijo?",
    );
    await expectNoEnglish(panel);
  });

  test("the dialog that asks for a command", async ({ page }) => {
    await startAi(page, FILE_ON, ["llama3"]);
    await page.evaluate(() => (window as HookWindow).__norenTest?.setAiReply("```sh\nls -la\n```"));
    await page.keyboard.press("Control+Shift+P");
    const palette = page.getByRole("combobox", { name: "Paleta de comandos", exact: true });
    await expect(palette).toBeVisible();
    await palette.fill("? listar os arquivos");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Pedir um comando", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/^Para .+ em .+\.$/)).toBeVisible();
    await expect(dialog).toContainText(
      "Isto vai para Ollama · llama3. Nada é enviado até você pressionar Enviar.",
    );
    await expect(dialog.getByRole("region", { name: "Prévia do que será enviado" })).toBeVisible();
    await expect(dialog.locator('[data-nr-part="command-secrets"]')).toHaveText(
      "Nenhum segredo foi encontrado no que será enviado.",
    );
    await expectNoEnglish(dialog);

    await button(dialog, "Enviar").click();
    await expect(dialog.locator('[data-nr-part="command-text"]')).toHaveText("ls -la");
    await expect(dialog).toContainText("O comando, para colocar no seu prompt:");
    await expect(dialog).toContainText("Só é executado quando você pressiona Enter no terminal.");
    await expect(dialog).toContainText("Enviado para Ollama · llama3.");
    await expect(button(dialog, "Fechar")).toBeVisible();
    await expect(button(dialog, "Inserir no prompt")).toBeVisible();
    await expectNoEnglish(dialog);
  });

  test("the dialog that asks for a command refuses a request that is too long", async ({
    page,
  }) => {
    await startAi(page, FILE_ON, ["llama3"]);
    await page.keyboard.press("Control+Shift+P");
    const palette = page.getByRole("combobox", { name: "Paleta de comandos", exact: true });
    await palette.fill(`? ${"x".repeat(20000)}`);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Pedir um comando", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveText(
      "O pedido é longo demais. Encurte e tente de novo.",
    );
    await expectNoEnglish(dialog);
  });

  test("the dialog that asks for a command, with nothing to answer it, gives the steps", async ({
    page,
  }) => {
    await startAi(page, FILE_UNNAMED, null);
    await page.keyboard.press("Control+Shift+P");
    const palette = page.getByRole("combobox", { name: "Paleta de comandos", exact: true });
    await palette.fill("? listar os arquivos");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Pedir um comando", exact: true });
    const steps = dialog.locator('[data-nr-part="command-steps"]');
    await expect(steps).toBeVisible();
    await expect(steps).toContainText("Depois feche esta janela e abra de novo.");
    await expect(steps).toContainText("escolha o provedor e o modelo para Comando");
    await expect(button(dialog, "Enviar")).toHaveCount(0);
    await expectNoEnglish(dialog);
  });

  test("the providers of the AI in the settings", async ({ page }) => {
    const file = `{
  "language": "pt-BR",
  "ai": {
    "providers": [
      { "id": "work", "kind": "openai-compatible", "baseUrl": "https://llm.example.com/v1", "model": "big" },
    ],
  },
}
`;
    await startAi(page, file, ["llama3", "qwen2"]);
    await page.getByRole("button", { name: "Configurações", exact: true }).click();
    const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
    const ai = screen.getByRole("region", { name: "IA", exact: true });
    await expect(ai.getByRole("heading", { name: "Provedores", exact: true })).toBeVisible();
    const ollama = ai.getByRole("group", { name: "Ollama", exact: true });
    await expect(ollama.getByRole("status").first()).toContainText(
      "O Ollama está em execução, com 2 modelos instalados:",
    );
    await expect(
      ollama.getByRole("list", { name: "Modelos do Ollama", exact: true }),
    ).toBeVisible();
    await expect(button(ollama, "Verificar o Ollama de novo")).toBeVisible();

    const work = ai.getByRole("group", { name: "work", exact: true });
    await expect(work).toContainText("OpenAI-compatible, https://llm.example.com/v1, modelo big");
    await expect(work).toContainText("Nenhuma chave de API guardada.");
    await button(work, "Testar conexão com work").click();
    await expect(work.locator('[data-nr-part="settings-ai-provider-note"]')).toHaveText(
      "A conexão funciona.",
    );
    await button(work, "Guardar chave de work").click();
    await expect(work.locator('[data-nr-part="settings-ai-provider-note"]')).toHaveText(
      "Cole a chave no campo primeiro.",
    );
    await work.getByLabel("Chave de API de work", { exact: true }).fill("sk-test-e2e-0123456789");
    await button(work, "Guardar chave de work").click();
    await expect(work.locator('[data-nr-part="settings-ai-provider-note"]')).toHaveText(
      "A chave foi guardada no cofre de chaves.",
    );
    await expect(work).toContainText("Há uma chave de API guardada no cofre de chaves.");
    await expect(button(work, "Remover chave de work")).toBeVisible();
    await expect(button(work, "Remover o provedor work")).toBeVisible();

    const form = ai.getByRole("group", { name: "Adicionar um provedor", exact: true });
    for (const label of [
      "Id do provedor",
      "Tipo do provedor",
      "Endereço do provedor",
      "Modelo do provedor",
      "Chave de API do provedor (opcional)",
    ]) {
      await expect(form.getByLabel(label, { exact: true })).toBeVisible();
    }
    await form.getByLabel("Id do provedor", { exact: true }).fill("meu-provedor");
    await form
      .getByLabel("Endereço do provedor", { exact: true })
      .fill("https://api.example.com/v1");
    await form.getByLabel("Modelo do provedor", { exact: true }).fill("modelo-x");
    await button(form, "Adicionar provedor").click();
    await expect(ai.locator('[data-nr-part="settings-ai-providers-status"]')).toHaveText(
      "meu-provedor adicionado.",
    );
    await expect(ai).toContainText("Adicionar ou remover um provedor grava o config.jsonc na hora");
    await expectNoEnglish(ai);
  });

  test("the steps to a first provider in the settings", async ({ page }) => {
    await startAi(page, FILE_UNNAMED, null);
    await page.getByRole("button", { name: "Configurações", exact: true }).click();
    const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
    const steps = screen.locator('[data-nr-part="settings-ai-steps"]');
    await expect(steps).toBeVisible();
    await expect(steps).toContainText(
      "Nenhum provedor está pronto para responder ainda. Para ter um:",
    );
    await expect(steps.getByRole("listitem")).toHaveCount(3);
    await expect(
      screen.getByRole("group", { name: "Ollama", exact: true }).getByRole("status").first(),
    ).toContainText("O Ollama não foi encontrado neste computador.");
    await expectNoEnglish(screen.getByRole("region", { name: "IA", exact: true }));
  });
});

test.describe("the descriptions of the fields of config.jsonc", () => {
  test("show in Portuguese as the tooltips of the settings screen", async ({ page }) => {
    await start(page);
    await page.getByRole("button", { name: "Configurações", exact: true }).click();
    const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
    await expect(screen).toBeVisible();
    await expect(
      screen.getByRole("group", { name: "Lado da barra lateral", exact: true }),
    ).toHaveAttribute("title", "Em que lado da janela fica a barra lateral.");
    await expect(
      screen.getByRole("switch", { name: "Modo compacto", exact: true }).locator(".."),
    ).toHaveAttribute(
      "title",
      "Modo compacto: a barra lateral sai do layout e aparece sobre ele quando o ponteiro toca a borda da janela.",
    );
    await expect(screen.getByRole("combobox", { name: "Idioma", exact: true })).toHaveAttribute(
      "title",
      /^O idioma da interface: "en" \(inglês\)/,
    );
    // Every tooltip of the screen is Portuguese: none is a description of the English dictionary.
    const tooltips = await screen
      .locator("[title]")
      .evaluateAll((all) => all.map((element) => element.getAttribute("title") ?? ""));
    expect(tooltips.length).toBeGreaterThan(20);
    const english = KEYS.filter((key) => key.startsWith("field.")).map((key) => en[key] as string);
    expect(tooltips.filter((text) => english.includes(text))).toEqual([]);
    await expectNoEnglish(screen);
  });
});

test.describe("the check itself", () => {
  test("finds the English words of a screen that is still in English", async ({ page }) => {
    await start(page, "{}\n");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const screen = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(screen).toBeVisible();
    expect((await englishLeft(screen)).length).toBeGreaterThan(10);
    // And the tooltips are the English words of the schema.
    await expect(screen.getByRole("group", { name: "Sidebar side", exact: true })).toHaveAttribute(
      "title",
      "Which side of the window the sidebar is on.",
    );
  });
});
