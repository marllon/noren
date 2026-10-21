import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { cancelSettings, configText, openSettings, seedConfig } from "./settings-fixture";

// The AI providers in the settings screen (Ollama and its models, the providers of the file with
// their key and a connection test, the form that adds one, the steps when nothing can answer yet),
// what the page hands to the AI side (`ai.configure`), and the switch of the AI for one space in the
// menu of the space. The AI side is the fake one of the web build: a fake Ollama (seeded here), a
// fake keychain and fake answers. Nothing reaches a network or the keychain of the system.

interface Hook {
  configSaves(): number;
  setConfig(text: string | null): void;
  aiConfigures(): string[][];
  aiKeyCalls(): string[];
  storedAiKey(providerId: string): string | undefined;
  paneIds(): string[];
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_AI_OLLAMA_KEY = "noren.web.ai-ollama";
const WEB_STATE_KEY = "noren.web.state";
const KEY = "sk-test-e2e-0123456789";

/** A file with comments of every kind, two providers, and the AI off. */
const FILE = `// My Noren settings, keep this line.
{
  "notifications": { "enabled": true }, // quiet
  // The AI stays off until I say so.
  "ai": {
    "providers": [
      // my work server
      { "id": "work", "kind": "openai-compatible", "baseUrl": "https://llm.example.com/v1", "model": "big" }, // keep
      { "id": "spare", "kind": "anthropic", "baseUrl": "https://api.anthropic.com", "model": "small" },
    ],
  },
}
`;

/** The same, with Ask using "work". */
const FILE_WITH_DEFAULT = FILE.replace(
  "    ],\n  },\n}",
  `    ],
    "defaults": { "ask": { "provider": "work", "model": "big" } },
  },
}`,
);

const section = (screen: Locator, name: string) =>
  screen.getByRole("region", { name, exact: true });
const group = (scope: Locator, name: string) => scope.getByRole("group", { name, exact: true });
const button = (scope: Locator, name: string) => scope.getByRole("button", { name, exact: true });
const field = (scope: Locator, name: string) => scope.getByLabel(name, { exact: true });
const note = (scope: Locator) => scope.locator('[data-nr-part="settings-ai-provider-note"]');
const steps = (scope: Locator) => scope.locator('[data-nr-part="settings-ai-steps"]');
const status = (scope: Locator) => scope.locator('[data-nr-part="settings-ai-providers-status"]');

const configures = (page: Page): Promise<string[][]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.aiConfigures() ?? []);
const keyCalls = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.aiKeyCalls() ?? []);
const storedKey = (page: Page, id: string): Promise<string | undefined> =>
  page.evaluate((who) => (window as HookWindow).__norenTest?.storedAiKey(who), id);
const configSaves = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.configSaves() ?? -1);
/** Everything the page keeps in its browser storage, as one text. */
const everythingStored = (page: Page): Promise<string> =>
  page.evaluate(() =>
    Object.entries(window.localStorage)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n"),
  );

/** Seeds the models of the fake Ollama before the page loads (without it there is no Ollama). */
async function seedOllama(page: Page, models: string[]): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_AI_OLLAMA_KEY, value: JSON.stringify(models) },
  );
}

async function start(
  page: Page,
  options: { file?: string; ollama?: string[] } = {},
): Promise<void> {
  if (options.file !== undefined) await seedConfig(page, options.file);
  if (options.ollama !== undefined) await seedOllama(page, options.ollama);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
}

/** Opens the settings screen and returns its AI section. */
async function openAi(page: Page): Promise<Locator> {
  return section(await openSettings(page), "AI");
}

test.describe("Ollama and the steps to a first provider", () => {
  test("lists the models of the Ollama of this computer, and tests the connection", async ({
    page,
  }) => {
    await start(page, { ollama: ["llama3", "qwen2"] });
    const ai = await openAi(page);
    const ollama = group(ai, "Ollama");
    await expect(ollama.getByRole("status").first()).toContainText(
      "Ollama is running, with 2 models",
    );
    await expect(
      ollama.getByRole("list", { name: "Ollama models", exact: true }).getByRole("listitem"),
    ).toHaveText(["llama3", "qwen2"]);
    // Something can answer, so the steps are not shown.
    await expect(steps(ai)).toHaveCount(0);

    await button(ollama, "Test connection to Ollama").click();
    await expect(note(ollama)).toHaveText("The connection works.");
    await cancelSettings(page);
  });

  test("shows the steps when the file lists no provider and Ollama is not there", async ({
    page,
  }) => {
    await start(page);
    const ai = await openAi(page);
    await expect(steps(ai)).toBeVisible();
    await expect(steps(ai).getByRole("listitem")).toHaveCount(3);
    await expect(steps(ai)).toContainText("install it, start it, and install a model");
    await expect(steps(ai)).toContainText("never to config.jsonc");
    const ollama = group(ai, "Ollama");
    await expect(ollama.getByRole("status").first()).toHaveText(
      "Ollama was not found on this computer.",
    );
    // Ollama is still listed, and a test of it says why it fails.
    await button(ollama, "Test connection to Ollama").click();
    await expect(note(ollama)).toContainText("The connection failed");
    await cancelSettings(page);
  });

  test("shows the steps when Ollama has no model, and drops them once a provider is listed", async ({
    page,
  }) => {
    await start(page, { ollama: [] });
    const ai = await openAi(page);
    await expect(steps(ai)).toBeVisible();
    await expect(group(ai, "Ollama").getByRole("status").first()).toContainText(
      "no model is installed",
    );

    // The file gains a provider (an edit by hand): the steps go away, the screen stays open.
    await page.evaluate((text) => (window as HookWindow).__norenTest?.setConfig(text), FILE);
    await expect(group(ai, "work")).toBeVisible();
    await expect(steps(ai)).toHaveCount(0);
    await cancelSettings(page);
  });
});

test.describe("handing the providers to the AI side", () => {
  test("hands over the providers of the file at the start, and the new list when the file changes", async ({
    page,
  }) => {
    await start(page, { file: FILE });
    await expect.poll(() => configures(page)).toEqual([["work", "spare"]]);

    await page.evaluate(
      (text) => (window as HookWindow).__norenTest?.setConfig(text),
      FILE.replace(/ {6}\{ "id": "spare".*\n/, ""),
    );
    await expect.poll(() => configures(page)).toEqual([["work", "spare"], ["work"]]);

    // A change that leaves the list alone hands nothing over.
    await page.evaluate(
      (text) => (window as HookWindow).__norenTest?.setConfig(text),
      FILE.replace(/ {6}\{ "id": "spare".*\n/, "").replace('"enabled": true', '"enabled": false'),
    );
    await expect.poll(() => configText(page)).toContain('"enabled": false');
    expect(await configures(page)).toHaveLength(2);
  });

  test("hands over an empty list when there is no file", async ({ page }) => {
    await start(page);
    await expect.poll(() => configures(page)).toEqual([[]]);
  });
});

test.describe("the providers of the file", () => {
  test("lists them with the key state, tests the connection and says why it fails", async ({
    page,
  }) => {
    await start(page, { file: FILE });
    const ai = await openAi(page);
    const work = group(ai, "work");
    await expect(work).toContainText("OpenAI-compatible, https://llm.example.com/v1, model big");
    await expect(work).toContainText("No API key is stored.");
    await button(work, "Test connection to work").click();
    await expect(note(work)).toHaveText("The connection works.");

    // This provider needs a key, so the fake one fails until there is one.
    const spare = group(ai, "spare");
    await button(spare, "Test connection to spare").click();
    await expect(note(spare)).toContainText(
      "The connection failed: this provider needs an API key",
    );
    await field(spare, "API key for spare").fill(KEY);
    await button(spare, "Store key of spare").click();
    await expect(note(spare)).toHaveText("The key is stored in the keychain.");
    await expect(spare).toContainText("An API key is stored in the keychain.");
    await expect(field(spare, "API key for spare")).toHaveValue("");
    await button(spare, "Test connection to spare").click();
    await expect(note(spare)).toHaveText("The connection works.");

    // The key is in the keychain, was never written to the file, and the page keeps no copy of it.
    expect(await storedKey(page, "spare")).toBe(KEY);
    expect(await keyCalls(page)).toEqual(["spare"]);
    expect(await configText(page)).toBe(FILE);
    expect(await everythingStored(page)).not.toContain(KEY);

    await button(spare, "Remove key of spare").click();
    await expect(note(spare)).toHaveText("The key is removed from the keychain.");
    await expect(spare).toContainText("No API key is stored.");
    expect(await storedKey(page, "spare")).toBeUndefined();
    await cancelSettings(page);
  });

  test("asks for the key before storing one", async ({ page }) => {
    await start(page, { file: FILE });
    const ai = await openAi(page);
    const work = group(ai, "work");
    await button(work, "Store key of work").click();
    await expect(note(work)).toHaveText("Paste the key in the box first.");
    expect(await keyCalls(page)).toEqual([]);
    await cancelSettings(page);
  });

  test("Enter in the key box stores the key and does not save the rest of the screen", async ({
    page,
  }) => {
    await start(page, { file: FILE });
    const screen = await openSettings(page);
    const ai = section(screen, "AI");
    const work = group(ai, "work");
    await field(work, "API key for work").fill(KEY);
    await field(work, "API key for work").press("Enter");
    await expect(note(work)).toHaveText("The key is stored in the keychain.");
    await expect(screen).toBeVisible();
    expect(await configSaves(page)).toBe(0);
    expect(await storedKey(page, "work")).toBe(KEY);
    await cancelSettings(page);
  });
});

test.describe("adding and removing a provider", () => {
  test("adds one into config.jsonc keeping the comments, stores its key only in the keychain, and tests it", async ({
    page,
  }) => {
    await start(page, { file: FILE });
    const screen = await openSettings(page);
    const ai = section(screen, "AI");
    const form = group(ai, "Add a provider");
    await field(form, "Provider id").fill("my-openai");
    await field(form, "Provider kind").selectOption("openai-compatible");
    await field(form, "Provider address").fill("https://api.openai.com/v1");
    await field(form, "Provider model").fill("gpt-x");
    await field(form, "Provider API key (optional)").fill(KEY);
    await button(form, "Add provider").click();

    await expect(status(ai)).toHaveText("Added my-openai, and its key is stored in the keychain.");
    const mine = group(ai, "my-openai");
    await expect(mine).toContainText("OpenAI-compatible, https://api.openai.com/v1, model gpt-x");
    await expect(mine).toContainText("An API key is stored in the keychain.");
    // The form is empty again, and the key box too.
    await expect(field(form, "Provider id")).toHaveValue("");
    await expect(field(form, "Provider API key (optional)")).toHaveValue("");

    const text = (await configText(page)) ?? "";
    expect(text).toContain("// My Noren settings, keep this line.");
    expect(text).toContain('"notifications": { "enabled": true }, // quiet');
    expect(text).toContain("// The AI stays off until I say so.");
    expect(text).toContain("// my work server");
    expect(text).toContain("}, // keep");
    expect(text).toMatch(/"id": "my-openai"/);
    expect(text).toMatch(/"baseUrl": "https:\/\/api\.openai\.com\/v1"/);
    expect(text).toMatch(/"model": "gpt-x"/);
    // The key is only in the keychain: not in the file, not in anything else the page stored.
    expect(text).not.toContain(KEY);
    expect(await everythingStored(page)).not.toContain(KEY);
    expect(await storedKey(page, "my-openai")).toBe(KEY);
    expect(await keyCalls(page)).toEqual(["my-openai"]);

    // The AI side got the new list, and the connection to the new provider works.
    await expect
      .poll(() => configures(page))
      .toEqual([
        ["work", "spare"],
        ["work", "spare", "my-openai"],
      ]);
    await button(mine, "Test connection to my-openai").click();
    await expect(note(mine)).toHaveText("The connection works.");

    // The provider can be chosen as a default at once.
    await expect(field(ai, "Ask provider").locator("option")).toHaveText([
      "No provider",
      "Ollama",
      "work",
      "spare",
      "my-openai",
    ]);
    await cancelSettings(page);
  });

  test("adds one with no key, and the first one makes the list when the file has none", async ({
    page,
  }) => {
    await start(page, {
      file: '// Mine.\n{\n  "notifications": { "enabled": true }, // quiet\n}\n',
    });
    const ai = await openAi(page);
    const form = group(ai, "Add a provider");
    await field(form, "Provider id").fill("local-vllm");
    await field(form, "Provider address").fill("http://localhost:8000/v1");
    await field(form, "Provider model").fill("some-model");
    await field(form, "Provider id").press("Enter");
    await expect(status(ai)).toHaveText("Added local-vllm.");
    const text = (await configText(page)) ?? "";
    expect(text).toContain("// Mine.");
    expect(text).toContain("// quiet");
    expect(text).toContain('"id": "local-vllm"');
    expect(await keyCalls(page)).toEqual([]);
    await expect.poll(() => configures(page)).toEqual([[], ["local-vllm"]]);
    await cancelSettings(page);
  });

  test("refuses a repeated id, ollama and a bad address where they are typed, and writes nothing", async ({
    page,
  }) => {
    await start(page, { file: FILE });
    const screen = await openSettings(page);
    const ai = section(screen, "AI");
    const form = group(ai, "Add a provider");
    await field(form, "Provider id").fill("work");
    await field(form, "Provider address").fill("ftp://host/v1");
    await field(form, "Provider model").fill("m");
    await button(form, "Add provider").click();
    await expect(field(form, "Provider id")).toHaveAttribute("aria-invalid", "true");
    await expect(form).toContainText('The id "work" is used by another provider');
    await expect(field(form, "Provider address")).toHaveAttribute("aria-invalid", "true");
    await expect(form).toContainText("Must start with http:// or https://");

    await field(form, "Provider id").fill("ollama");
    await expect(form).toContainText("is the Ollama of this computer");

    await field(form, "Provider id").fill("fresh");
    await field(form, "Provider address").fill("https://me:secret@host/v1");
    await expect(form).toContainText("hold no user name or password");

    await field(form, "Provider address").fill("https://host/v1");
    await field(form, "Provider model").fill("");
    await expect(form).toContainText("Type the model this provider uses.");

    expect(await configSaves(page)).toBe(0);
    expect(await keyCalls(page)).toEqual([]);
    await cancelSettings(page);
    expect(await configText(page)).toBe(FILE);
  });

  test("removes a provider keeping the rest of the file, and takes its key out of the keychain", async ({
    page,
  }) => {
    await start(page, { file: FILE });
    const ai = await openAi(page);
    const spare = group(ai, "spare");
    await field(spare, "API key for spare").fill(KEY);
    await button(spare, "Store key of spare").click();
    await expect(spare).toContainText("An API key is stored in the keychain.");

    await button(spare, "Remove provider spare").click();
    await expect(group(ai, "spare")).toHaveCount(0);
    await expect(status(ai)).toHaveText("Removed spare.");
    const text = (await configText(page)) ?? "";
    expect(text).not.toContain("spare");
    expect(text).toContain("// my work server");
    expect(text).toContain("}, // keep");
    expect(text).toContain("// The AI stays off until I say so.");
    await expect.poll(() => storedKey(page, "spare")).toBeUndefined();
    await expect.poll(() => configures(page)).toEqual([["work", "spare"], ["work"]]);
    await cancelSettings(page);
  });

  test("refuses to remove a provider that a function uses, and says which", async ({ page }) => {
    await start(page, { file: FILE_WITH_DEFAULT });
    const ai = await openAi(page);
    const work = group(ai, "work");
    await button(work, "Remove provider work").click();
    await expect(note(work)).toContainText('"work" is the provider of Ask.');
    await expect(note(work)).toContainText("Choose another provider for it (or none) and save");
    await expect(work).toBeVisible();
    expect(await configSaves(page)).toBe(0);
    await cancelSettings(page);
    expect(await configText(page)).toBe(FILE_WITH_DEFAULT);
  });
});

test.describe("the AI in one space", () => {
  const switcher = (page: Page) => page.getByRole("navigation", { name: "Spaces", exact: true });
  const menu = (page: Page) => page.getByRole("menu", { name: "Main options", exact: true });
  // A checked item has its mark in the name too ("✓ AI in this space").
  const aiItem = (page: Page) =>
    menu(page).getByRole("menuitemcheckbox", { name: /^(✓ )?AI in this space$/ });

  /** How many spaces the saved state says have the AI off. */
  const spacesWithAiOff = (page: Page): Promise<number> =>
    page.evaluate((key) => {
      const text = window.localStorage.getItem(key) ?? "";
      return (text.match(/"aiEnabled":\s*false/g) ?? []).length;
    }, WEB_STATE_KEY);

  test("turns the AI off and on for the space in its menu", async ({ page }) => {
    await start(page, { file: FILE });
    await switcher(page).getByRole("button", { name: "Main", exact: true }).click({
      button: "right",
    });
    await expect(menu(page)).toBeVisible();
    // On for a new space.
    await expect(aiItem(page)).toHaveAttribute("aria-checked", "true");

    await aiItem(page).click();
    await expect(aiItem(page)).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => spacesWithAiOff(page)).toBe(1);

    await aiItem(page).click();
    await expect(aiItem(page)).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => spacesWithAiOff(page)).toBe(0);

    // It is the space's own choice: it survives a reload.
    await aiItem(page).click();
    await expect.poll(() => spacesWithAiOff(page)).toBe(1);
    await page.keyboard.press("Escape");
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
      .toBeGreaterThan(0);
    await switcher(page).getByRole("button", { name: "Main", exact: true }).click({
      button: "right",
    });
    await expect(aiItem(page)).toHaveAttribute("aria-checked", "false");
  });

  test("tells in the menu that the AI is off in the settings", async ({ page }) => {
    await start(page, { file: FILE });
    await switcher(page).getByRole("button", { name: "Main", exact: true }).click({
      button: "right",
    });
    await expect(aiItem(page)).toHaveAttribute(
      "title",
      "The AI is off in the settings, so it is off in every space",
    );
  });
});

test.describe("accessibility", () => {
  test("axe: Ollama with its models and the providers of the file, with their notes, have no violation", async ({
    page,
  }) => {
    await start(page, { file: FILE, ollama: ["llama3", "qwen2"] });
    const ai = await openAi(page);
    await expect(group(ai, "Ollama").getByRole("status").first()).toContainText("with 2 models");
    await group(ai, "Ollama").scrollIntoViewIfNeeded();
    await expectNoAxeViolations(page, "AI providers");
    const spare = group(ai, "spare");
    await button(spare, "Test connection to spare").click();
    await expect(note(spare)).toContainText("The connection failed");
    await button(group(ai, "work"), "Store key of work").click();
    await expect(note(group(ai, "work"))).toHaveText("Paste the key in the box first.");
    await spare.scrollIntoViewIfNeeded();
    await expectNoAxeViolations(page, "AI providers, with notes");
    await field(spare, "API key for spare").fill(KEY);
    await button(spare, "Store key of spare").click();
    await expect(note(spare)).toHaveText("The key is stored in the keychain.");
    await expectNoAxeViolations(page, "AI providers, with a key stored");
  });

  test("axe: the steps when nothing can answer have no violation", async ({ page }) => {
    await start(page);
    const ai = await openAi(page);
    await expect(steps(ai)).toBeVisible();
    await steps(ai).scrollIntoViewIfNeeded();
    await expectNoAxeViolations(page, "AI providers, steps");
  });

  test("axe: the form that adds a provider, with its refusals, has no violation", async ({
    page,
  }) => {
    await start(page, { file: FILE });
    const ai = await openAi(page);
    const form = group(ai, "Add a provider");
    await form.scrollIntoViewIfNeeded();
    await expectNoAxeViolations(page, "add provider form");
    await field(form, "Provider id").fill("work");
    await field(form, "Provider address").fill("ftp://host/v1");
    await field(form, "Provider model").fill("m");
    await button(form, "Add provider").click();
    await expect(field(form, "Provider id")).toHaveAttribute("aria-invalid", "true");
    await expectNoAxeViolations(page, "add provider form, with refusals");
  });
});
