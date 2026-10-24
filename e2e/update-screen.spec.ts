import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { closeSettings, openSettings, seedConfig, settingsScreen } from "./settings-fixture";
import { openCommandPalette } from "./palette-fixture";

// The screen of the update of the app (NOR-F20-02b), in the web build with the `FakeBackend` and
// the release seeded under `noren.web.update`: the Updates section of the settings, the palette
// command "Check for updates", the notice of a new version with its notes, the install (only on a
// click, after the app saved what closing it saves), the bar of the download and the sentence of
// every refusal, in English and in Brazilian Portuguese. Each state is also run through axe, which
// fails on a violation of any impact. The layers below are tested in Rust (`update/tests.rs`)
// against a local server and a signed package; `e2e/update.spec.ts` keeps the rule that the page
// never checks or installs by itself.

interface Hook {
  paneIds(): string[];
  split(dir: "row" | "column", paneId?: string): string | undefined;
  updateCalls(): string[];
  installedUpdates(): string[];
  backendCalls(methods: string[]): string[];
  holdUpdateInstall(): void;
  releaseUpdateInstall(): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_UPDATE_KEY = "noren.web.update";

const NOTES = "Faster start\n- fixes the tab bar\n- a new theme";
const RELEASE = {
  version: "0.2.0",
  notes: NOTES,
  publishedAt: 1_792_584_000,
  bytes: 4 * 1024 * 1024,
};

const SIGNATURE_REFUSAL = "the signature does not match the package and the update key";

async function start(page: Page, seed: unknown, config?: string): Promise<void> {
  // Only on the first load, so a reload would find what the app left.
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_UPDATE_KEY, value: JSON.stringify(seed) },
  );
  if (config !== undefined) await seedConfig(page, config);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
}

const calls = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.updateCalls() ?? []);
const installed = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.installedUpdates() ?? []);

/** The Updates section of the open settings screen. */
const updates = (page: Page): Locator =>
  settingsScreen(page).getByRole("region", { name: "Updates", exact: true });
const statusLine = (section: Locator): Locator => section.locator('[data-nr-part="update-status"]');
const checkButton = (section: Locator, name = "Check for updates"): Locator =>
  section.getByRole("button", { name, exact: true });
const installButton = (section: Locator, name = "Download and install"): Locator =>
  section.getByRole("button", { name, exact: true });
const progress = (section: Locator): Locator => section.locator("progress");

async function openUpdates(page: Page): Promise<Locator> {
  await openSettings(page);
  const section = updates(page);
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
  return section;
}

/** Opens the settings screen of a page in Brazilian Portuguese, and the Updates section of it. */
async function openUpdatesPt(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
  await expect(screen).toBeVisible();
  const section = screen.getByRole("region", { name: "Atualizações", exact: true });
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
  return section;
}

const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');

async function runCommand(page: Page, query: string, title: string): Promise<void> {
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await openCommandPalette(page);
  await expect(palette(page)).toBeVisible();
  const box = palette(page).getByRole("combobox", { name: "Command palette", exact: true });
  await expect(box).toBeFocused();
  await box.fill(`>${query}`);
  await expect(palette(page).getByRole("option").first().locator(".palette-title")).toHaveText(
    title,
  );
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
}

test.describe("the Updates section", () => {
  test("offers the check and says nothing until it is used", async ({ page }) => {
    await start(page, { release: RELEASE });
    const section = await openUpdates(page);
    await expect(section).toContainText("Noren looks for a new version only when you ask");
    await expect(checkButton(section)).toBeEnabled();
    await expect(statusLine(section)).toHaveCount(0);
    await expect(installButton(section)).toHaveCount(0);
    expect(await calls(page)).toEqual([]);
    await expectNoAxeViolations(page, "settings: Updates, idle");
  });

  test("says there is nothing new, with the version that runs", async ({ page }) => {
    await start(page, { currentVersion: "0.1.0", release: { version: "0.1.0" } });
    const section = await openUpdates(page);
    await checkButton(section).click();
    await expect(statusLine(section)).toHaveText("Noren 0.1.0 is the latest version.");
    await expect(installButton(section)).toHaveCount(0);
    await expect(section.getByText("Release notes")).toHaveCount(0);
    expect(await installed(page)).toEqual([]);
    await expectNoAxeViolations(page, "settings: Updates, nothing new");
  });

  test("says there is nothing new when the feed has no release at all", async ({ page }) => {
    await start(page, {});
    const section = await openUpdates(page);
    await checkButton(section).click();
    await expect(statusLine(section)).toHaveText("Noren 0.1.0 is the latest version.");
  });

  test("announces a newer version with its notes and installs nothing", async ({ page }) => {
    await start(page, { release: RELEASE });
    const section = await openUpdates(page);
    await checkButton(section).click();
    await expect(statusLine(section)).toHaveText("Noren 0.2.0 is available. You have 0.1.0.");
    await expect(section).toContainText("Released October 21, 2026.");
    const notes = section.getByRole("group", { name: "Release notes", exact: true });
    await expect(notes).toHaveText(NOTES);
    await expect(installButton(section)).toBeEnabled();
    expect(await calls(page)).toEqual(["updateCheck"]);
    expect(await installed(page)).toEqual([]);
    await expectNoAxeViolations(page, "settings: Updates, a new version");
  });

  test("a release without notes says so", async ({ page }) => {
    await start(page, { release: { version: "0.2.0" } });
    const section = await openUpdates(page);
    await checkButton(section).click();
    await expect(section.getByRole("group", { name: "Release notes", exact: true })).toHaveText(
      "This release has no notes.",
    );
    await expect(section).not.toContainText("Released");
  });

  test("a new version waits for a click: nothing installs by itself, even after the screen closes and opens", async ({
    page,
  }) => {
    await start(page, { release: RELEASE });
    const section = await openUpdates(page);
    await checkButton(section).click();
    await expect(installButton(section)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await installed(page)).toEqual([]);
    expect(await calls(page)).toEqual(["updateCheck"]);
    // The found update is kept while the settings are closed; opening them shows it again.
    await closeSettings(page);
    await page.waitForTimeout(300);
    const again = await openUpdates(page);
    await expect(statusLine(again)).toHaveText("Noren 0.2.0 is available. You have 0.1.0.");
    expect(await installed(page)).toEqual([]);
    expect((await calls(page)).filter((call) => call === "updateInstall")).toEqual([]);
  });

  test("installs on a click and shows the progress of the download", async ({ page }) => {
    await start(page, { release: RELEASE });
    const section = await openUpdates(page);
    await checkButton(section).click();
    await page.evaluate(() => (window as HookWindow).__norenTest?.holdUpdateInstall());
    await installButton(section).click();
    // A quarter of the package has come; the rest waits.
    await expect(statusLine(section)).toHaveText("Downloading Noren 0.2.0...");
    const bar = progress(section);
    await expect(bar).toHaveAccessibleName("Download of the update");
    await expect(bar).toHaveJSProperty("value", 25);
    await expect(section).toContainText("25% (1.0 MiB of 4.0 MiB)");
    await expect(installButton(section)).toHaveCount(0);
    await expect(checkButton(section)).toBeDisabled();
    expect(await installed(page)).toEqual([]);
    await expectNoAxeViolations(page, "settings: Updates, downloading");
    await page.evaluate(() => (window as HookWindow).__norenTest?.releaseUpdateInstall());
    await expect(statusLine(section)).toHaveText(
      "Noren 0.2.0 is installed. Restart Noren to use it.",
    );
    await expect(progress(section)).toHaveCount(0);
    await expect(checkButton(section)).toBeEnabled();
    expect(await installed(page)).toEqual(["0.2.0"]);
    await expectNoAxeViolations(page, "settings: Updates, installed");
  });

  test("the bar follows the download: it moves and it ends", async ({ page }) => {
    await start(page, { release: RELEASE });
    const section = await openUpdates(page);
    await checkButton(section).click();
    await page.evaluate(() => (window as HookWindow).__norenTest?.holdUpdateInstall());
    await installButton(section).click();
    await expect(progress(section)).toHaveJSProperty("value", 25);
    await page.evaluate(() => (window as HookWindow).__norenTest?.releaseUpdateInstall());
    // The rest comes at once; the install ends and the bar goes away.
    await expect(progress(section)).toHaveCount(0);
    await expect(statusLine(section)).toContainText("is installed");
  });

  test("saves the state and the snapshots before the installer is asked for (finding 302)", async ({
    page,
  }) => {
    await start(page, { release: RELEASE });
    const section = await openUpdates(page);
    await checkButton(section).click();
    await expect(installButton(section)).toBeEnabled();
    // A change that waits for its write (the state is written 500 ms after a change), and the
    // click, in the same turn: whatever the app writes before the install is written because of it.
    await page.evaluate(() => {
      const hook = (window as HookWindow).__norenTest;
      hook?.split("row");
      const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
      buttons.find((b) => b.textContent === "Download and install")?.click();
    });
    await expect(statusLine(section)).toContainText("is installed");
    const order = await page.evaluate(() =>
      (window as HookWindow).__norenTest?.backendCalls([
        "updateCheck",
        "saveState",
        "saveScrollback",
        "updateInstall",
      ]),
    );
    const afterCheck = (order ?? []).slice((order ?? []).indexOf("updateCheck") + 1);
    const install = afterCheck.indexOf("updateInstall");
    expect(install).toBeGreaterThan(0);
    // The state was written (the same path as closing) before the installer was asked for.
    expect(afterCheck.slice(0, install)).toContain("saveState");
    expect(afterCheck.slice(install)).toEqual(["updateInstall"]);
  });

  test("refuses a package whose signature does not match and installs nothing", async ({
    page,
  }) => {
    await start(page, { release: { ...RELEASE, refusal: SIGNATURE_REFUSAL } });
    const section = await openUpdates(page);
    await checkButton(section).click();
    await installButton(section).click();
    await expect(statusLine(section)).toHaveText(
      "The update was refused: its signature does not match the package and the update key of this build. Nothing was installed.",
    );
    await expect(progress(section)).toHaveCount(0);
    await expect(installButton(section)).toHaveCount(0);
    await expect(checkButton(section)).toBeEnabled();
    expect(await installed(page)).toEqual([]);
    await expectNoAxeViolations(page, "settings: Updates, signature refused");
  });

  test("refuses a build with no update key, in words a person can act on", async ({ page }) => {
    await start(page, { configured: false, release: RELEASE });
    const section = await openUpdates(page);
    await checkButton(section).click();
    await expect(statusLine(section)).toHaveText(
      "This build cannot update yet: it has no update key to check an update against. Nothing was checked or installed.",
    );
    await expect(installButton(section)).toHaveCount(0);
    expect(await installed(page)).toEqual([]);
    await expectNoAxeViolations(page, "settings: Updates, no key");
  });

  test("says when the server cannot be reached, and a new check works again", async ({ page }) => {
    await start(page, {
      release: RELEASE,
      failure: "the update server could not be reached: offline",
    });
    const section = await openUpdates(page);
    await checkButton(section).click();
    await expect(statusLine(section)).toHaveText(
      "The update server could not be reached. Check your connection and try again.",
    );
    await expect(checkButton(section)).toBeEnabled();
    await expectNoAxeViolations(page, "settings: Updates, server down");
  });

  const OTHER_REFUSALS: [string, string][] = [
    ["the update server answered 404", "The update server answered with an error (404)."],
    ["the update server took too long to answer", "The update server took too long to answer."],
    [
      "the update feed is not usable: it does not follow the format of the updater",
      "The list of releases could not be read",
    ],
  ];
  for (const [failure, text] of OTHER_REFUSALS) {
    test(`says "${failure}" in its own words`, async ({ page }) => {
      await start(page, { release: RELEASE, failure });
      const section = await openUpdates(page);
      await checkButton(section).click();
      await expect(statusLine(section)).toContainText(text);
    });
  }
});

test.describe("the palette command", () => {
  test("Check for updates opens the section and shows the version found, installing nothing", async ({
    page,
  }) => {
    await start(page, { release: RELEASE });
    await runCommand(page, "check for updates", "Check for updates");
    const section = updates(page);
    await expect(section).toBeVisible();
    await expect(statusLine(section)).toHaveText("Noren 0.2.0 is available. You have 0.1.0.");
    await expect(section).toBeInViewport();
    expect(await calls(page)).toEqual(["updateCheck"]);
    expect(await installed(page)).toEqual([]);
    await expectNoAxeViolations(page, "settings opened by the palette, a new version");
    // The install is still the click of the button.
    await installButton(section).click();
    await expect(statusLine(section)).toContainText("is installed");
    expect(await installed(page)).toEqual(["0.2.0"]);
  });

  test("says there is nothing new", async ({ page }) => {
    await start(page, { release: { version: "0.1.0" } });
    await runCommand(page, "check for updates", "Check for updates");
    await expect(statusLine(updates(page))).toHaveText("Noren 0.1.0 is the latest version.");
    await closeSettings(page);
  });

  test("a build with no key says so from the palette too", async ({ page }) => {
    await start(page, { configured: false, release: RELEASE });
    await runCommand(page, "check for updates", "Check for updates");
    await expect(statusLine(updates(page))).toContainText("This build cannot update yet");
    expect(await installed(page)).toEqual([]);
  });
});

test.describe("in Brazilian Portuguese", () => {
  const PT = '{ "language": "pt-BR" }';

  test("the section, the notice, the progress and the refusals are in the language", async ({
    page,
  }) => {
    await start(page, { release: RELEASE }, PT);
    const section = await openUpdatesPt(page);
    await expect(section).toContainText("O Noren só procura uma versão nova quando você pede");
    await checkButton(section, "Verificar atualizações").click();
    await expect(statusLine(section)).toHaveText(
      "O Noren 0.2.0 está disponível. Você tem a 0.1.0.",
    );
    await expect(section).toContainText("Lançada em 21 de outubro de 2026.");
    await expect(
      section.getByRole("group", { name: "Notas da versão", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => (window as HookWindow).__norenTest?.holdUpdateInstall());
    await installButton(section, "Baixar e instalar").click();
    await expect(progress(section)).toHaveAccessibleName("Download da atualização");
    await expect(section).toContainText("25% (1.0 MiB de 4.0 MiB)");
    await expectNoAxeViolations(page, "settings: Updates in Portuguese, downloading");
    await page.evaluate(() => (window as HookWindow).__norenTest?.releaseUpdateInstall());
    await expect(statusLine(section)).toHaveText(
      "O Noren 0.2.0 está instalado. Reinicie o Noren para usá-lo.",
    );
  });

  test("the refusals by signature and by a missing key are in the language", async ({ page }) => {
    await start(page, { release: { ...RELEASE, refusal: SIGNATURE_REFUSAL } }, PT);
    const section = await openUpdatesPt(page);
    await checkButton(section, "Verificar atualizações").click();
    await installButton(section, "Baixar e instalar").click();
    await expect(statusLine(section)).toHaveText(
      "A atualização foi recusada: a assinatura não corresponde ao pacote e à chave de atualização desta versão. Nada foi instalado.",
    );
    expect(await installed(page)).toEqual([]);
  });

  test("a build with no key says so in the language", async ({ page }) => {
    await start(page, { configured: false }, PT);
    const section = await openUpdatesPt(page);
    await checkButton(section, "Verificar atualizações").click();
    await expect(statusLine(section)).toContainText("Esta versão ainda não consegue se atualizar");
    await expectNoAxeViolations(page, "settings: Updates in Portuguese, no key");
  });
});
