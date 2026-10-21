import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { openSettings, seedConfig, settingsScreen } from "./settings-fixture";
import { seedSidebarState } from "./sidebar-fixture";

// axe-core on every section of the settings screen (NOR-F20-01b). The sections share one dialog,
// so each test opens it on a file that fills the section with content (the AI on with a provider
// and a fake Ollama, a notification and archive setup, a second space), scrolls the section into
// view as a user would reach it, and runs axe on the whole page: a violation of any impact fails.

const WEB_AI_OLLAMA_KEY = "noren.web.ai-ollama";

/** A file that gives the sections something to show. */
const FILE = `{
  "profiles": [
    { "id": "dev", "name": "Dev Shell", "program": "pwsh.exe", "args": ["-NoLogo"] },
    { "id": "ops", "name": "Ops", "program": "bash" }
  ],
  "notifications": { "enabled": true },
  "ai": {
    "enabled": true,
    "providers": [
      { "id": "work", "kind": "openai-compatible", "baseUrl": "https://llm.example.com/v1", "model": "big" }
    ],
    "defaults": { "ask": { "provider": "work", "model": "big" } }
  }
}
`;

/** The sections, by the name the screen gives them. */
const SECTIONS = [
  "Appearance",
  "Window",
  "Background",
  "Terminal options",
  "Profiles",
  "Shortcuts",
  "Notifications",
  "Auto-archive",
  "AI",
  "Mods",
  "Gallery",
  "Sync",
  "Import",
] as const;

async function start(page: Page): Promise<void> {
  await seedConfig(page, FILE);
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_AI_OLLAMA_KEY, value: JSON.stringify(["llama3", "qwen2"]) },
  );
  await seedSidebarState(page, { split: true, secondSpace: true });
  await page.goto("/");
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeAttached();
}

for (const name of SECTIONS) {
  test(`axe: the "${name}" section of the settings has no axe violation`, async ({ page }) => {
    await start(page);
    const screen = await openSettings(page);
    const section = screen.getByRole("region", { name, exact: true });
    await section.scrollIntoViewIfNeeded();
    await expect(section).toBeVisible();
    await expect(settingsScreen(page)).toBeVisible();
    await expectNoAxeViolations(page, `settings: ${name}`);
  });
}

test("axe: the Profiles section with a profile just added has no axe violation", async ({
  page,
}) => {
  await start(page);
  const screen = await openSettings(page);
  const section = screen.getByRole("region", { name: "Profiles", exact: true });
  await section.getByRole("button", { name: "Add profile", exact: true }).click();
  await expect(section.getByRole("group", { name: "New profile 3", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "settings: Profiles with a new profile");
});

test("axe: the AI section with the form to add a provider has no axe violation", async ({
  page,
}) => {
  await start(page);
  const screen = await openSettings(page);
  const section = screen.getByRole("region", { name: "AI", exact: true });
  await section.scrollIntoViewIfNeeded();
  const add = section.getByRole("group", { name: "Add a provider", exact: true });
  await expect(add).toBeVisible();
  await expectNoAxeViolations(page, "settings: AI with the form to add a provider");
});
