import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { BenchRun } from "../packages/model/src/bench-runner";
import { BENCH_CSV_HEADER } from "../packages/model/src/bench-scoreboard";
import { parseConfigText } from "../packages/model/src/config";
import { BIG, GONE, LLAMA, PHI_CANCELLED, QWEN, seedBench } from "./bench-fixture";
import { expectNoAxeViolations } from "./axe-fixture";
import { cancelSettings, configText, openSettings, seedConfig } from "./settings-fixture";

// The bench scoreboard in the AI section of the settings screen: the saved results (seeded as files
// of the web build), the rows in the order of the board, the model recommended as the default, the
// button that makes a row the default of Ask, Explain and Command in config.jsonc, the refusal of a
// provider the settings do not list, and the CSV copied to the clipboard. The bench is never run
// from the screen and nothing reaches a network.

interface Hook {
  configSaves(): number;
  paneIds(): string[];
}
type HookWindow = Window & { __norenTest?: Hook };

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

/** A file with comments of every kind and one provider of its own. */
const FILE = `// My Noren settings, keep this line.
{
  "notifications": { "enabled": true }, // quiet
  // The AI stays off until I say so.
  "ai": {
    "providers": [
      // my work server
      { "id": "work", "kind": "openai-compatible", "baseUrl": "https://llm.example.com/v1", "model": "big" }, // keep
    ],
  },
}
`;

const PT = '{ "language": "pt-BR" }\n';

const bench = (screen: Locator) => screen.locator('[data-nr-part="settings-ai-bench"]');
const rowsOf = (scope: Locator) => scope.locator('[data-nr-part="settings-bench-row"]');
const noteOf = (scope: Locator) => scope.locator('[data-nr-part="settings-bench-note"]');
const button = (scope: Locator, name: string) => scope.getByRole("button", { name, exact: true });

const configSaves = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.configSaves() ?? -1);

async function start(
  page: Page,
  options: { file?: string; runs?: readonly BenchRun[] } = {},
): Promise<void> {
  if (options.file !== undefined) await seedConfig(page, options.file);
  if (options.runs !== undefined) await seedBench(page, options.runs);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
}

/** Opens the settings screen and returns the bench part of its AI section. */
async function openBench(page: Page): Promise<Locator> {
  const screen = await openSettings(page);
  const part = bench(screen.getByRole("region", { name: "AI", exact: true }));
  await expect(part).toBeVisible();
  return part;
}

/** `ai.defaults` of the saved text, as the app reads it. */
async function savedDefaults(page: Page): Promise<unknown> {
  const parsed = parseConfigText((await configText(page)) ?? "");
  if (!parsed.ok) throw new Error(`config.jsonc has a problem: ${JSON.stringify(parsed.errors)}`);
  return parsed.config.ai?.defaults;
}

const target = (provider: string, model: string) => ({ provider, model });

test.describe("the scoreboard", () => {
  test("says how results come about when there are none", async ({ page }) => {
    await start(page, { file: FILE });
    const part = await openBench(page);
    await expect(part.locator('[data-nr-part="settings-bench-empty"]')).toContainText(
      "No bench results yet. A bench run saves its result in the bench-results folder",
    );
    await expect(rowsOf(part)).toHaveCount(0);
    await expect(part.getByRole("table")).toHaveCount(0);
    await expect(button(part, "Use the recommended model")).toHaveCount(0);
    await expect(button(part, "Copy scoreboard as CSV")).toHaveCount(0);
    await cancelSettings(page);
  });

  test("lists the models in the order of the board and marks the recommended one", async ({
    page,
  }) => {
    // Seeded out of order: the order is the board's, not the files'.
    await start(page, { file: FILE, runs: [BIG, QWEN, LLAMA] });
    const part = await openBench(page);
    const rows = rowsOf(part);
    await expect(rows).toHaveCount(3);
    await expect(rows).toContainText(["qwen2", "llama3", "big"]);
    await expect(rows.nth(0)).toContainText("ollama");
    await expect(rows.nth(2)).toContainText("work");

    // Only the first one is recommended, and it says so in words.
    await expect(rows.nth(0)).toHaveAttribute("data-nr-recommended", "true");
    await expect(rows.nth(1)).toHaveAttribute("data-nr-recommended", "false");
    await expect(rows.nth(2)).toHaveAttribute("data-nr-recommended", "false");
    await expect(part.locator('[data-nr-part="settings-bench-badge"]')).toHaveCount(1);
    await expect(rows.nth(0).locator('[data-nr-part="settings-bench-badge"]')).toHaveText(
      "Recommended",
    );
    await expect(part.locator('[data-nr-part="settings-bench-recommendation"]')).toHaveText(
      "Recommended as the default: qwen2 (ollama).",
    );

    // The numbers of the first row: accuracy overall and by kind, medians, tokens and memory.
    const first = rows.nth(0).locator("td");
    await expect(first).toHaveText([
      "ollama",
      "100%",
      "100%",
      "100%",
      "100%",
      "50 ms",
      "900 ms",
      "44.4 (counted by the server)",
      "5.0 GiB, 2.5 GiB in video memory",
      "Finished1 run",
      "Use as default",
    ]);
    // The second one has estimated tokens and no memory reading; the third has 3 of 6 right.
    await expect(rows.nth(1).locator("td").nth(7)).toHaveText("133.3 (estimated)");
    await expect(rows.nth(1).locator("td").nth(8)).toHaveText("—");
    await expect(rows.nth(2).locator("td").nth(1)).toHaveText("50%");
    await cancelSettings(page);
  });

  test("lists a cancelled run and never recommends it", async ({ page }) => {
    await start(page, { file: FILE, runs: [QWEN, LLAMA, BIG, PHI_CANCELLED] });
    const part = await openBench(page);
    const rows = rowsOf(part);
    // phi3 got both of its tasks right and is the fastest, so it is first on the board...
    await expect(rows).toContainText(["phi3", "qwen2", "llama3", "big"]);
    await expect(rows.nth(0)).toContainText("Cancelled, 2 of 6 tasks");
    await expect(rows.nth(0)).toHaveAttribute("data-nr-state", "cancelled");
    // ...and the recommendation goes to the best model of a finished run.
    await expect(rows.nth(0)).toHaveAttribute("data-nr-recommended", "false");
    await expect(rows.nth(1)).toHaveAttribute("data-nr-recommended", "true");
    await expect(part.locator('[data-nr-part="settings-bench-recommendation"]')).toHaveText(
      "Recommended as the default: qwen2 (ollama).",
    );
    await expect(part.locator('[data-nr-part="settings-bench-badge"]')).toHaveCount(1);
    await cancelSettings(page);
  });

  test("recommends nothing when only a cancelled run is saved", async ({ page }) => {
    await start(page, { file: FILE, runs: [PHI_CANCELLED] });
    const part = await openBench(page);
    await expect(rowsOf(part)).toHaveCount(1);
    await expect(rowsOf(part).first()).toHaveAttribute("data-nr-recommended", "false");
    await expect(part.locator('[data-nr-part="settings-bench-recommendation"]')).toContainText(
      "No model can be recommended yet",
    );
    await expect(button(part, "Use the recommended model")).toHaveCount(0);
    // The row can still be used by hand.
    await expect(button(part, "Use phi3 (ollama) as the default")).toBeVisible();
    await cancelSettings(page);
  });
});

test.describe("making a model the default", () => {
  test("writes Ask, Explain and Command with one click on the recommended model, keeping the comments", async ({
    page,
  }) => {
    await start(page, { file: FILE, runs: [QWEN, LLAMA, BIG] });
    const part = await openBench(page);
    const before = await configSaves(page);
    await button(part, "Use the recommended model").click();
    await expect(noteOf(part)).toHaveText(
      "qwen2 (ollama) is now the default of Ask, Explain and Command. config.jsonc is written.",
    );
    expect(await savedDefaults(page)).toEqual({
      ask: target("ollama", "qwen2"),
      explain: target("ollama", "qwen2"),
      command: target("ollama", "qwen2"),
    });
    expect(await configSaves(page)).toBe(before + 1);

    // The text is edited, not rewritten: every comment and the provider are where they were.
    const text = (await configText(page)) ?? "";
    expect(text).toContain("// My Noren settings, keep this line.");
    expect(text).toContain('"notifications": { "enabled": true }, // quiet');
    expect(text).toContain("// The AI stays off until I say so.");
    expect(text).toContain("// my work server");
    expect(text).toContain("}, // keep");
    // It does not turn the AI on.
    expect(text).not.toContain('"enabled": true,\n    "providers"');
    const parsed = parseConfigText(text);
    expect(parsed.ok && parsed.config.ai?.enabled).toBeFalsy();
    await cancelSettings(page);
  });

  test("a row's own button makes that row the default, with a provider of the settings file", async ({
    page,
  }) => {
    await start(page, { file: FILE, runs: [QWEN, LLAMA, BIG] });
    const part = await openBench(page);
    await button(part, "Use big (work) as the default").click();
    await expect(noteOf(part)).toHaveText(
      "big (work) is now the default of Ask, Explain and Command. config.jsonc is written.",
    );
    expect(await savedDefaults(page)).toEqual({
      ask: target("work", "big"),
      explain: target("work", "big"),
      command: target("work", "big"),
    });
    // The next click replaces it.
    await button(part, "Use llama3 (ollama) as the default").click();
    await expect(noteOf(part)).toContainText("llama3 (ollama) is now the default");
    expect(await savedDefaults(page)).toEqual({
      ask: target("ollama", "llama3"),
      explain: target("ollama", "llama3"),
      command: target("ollama", "llama3"),
    });
    expect((await configText(page)) ?? "").toContain("// my work server");
    await cancelSettings(page);
  });

  test("refuses a provider the settings do not list, and writes nothing", async ({ page }) => {
    await start(page, { file: FILE, runs: [GONE, LLAMA] });
    const part = await openBench(page);
    // gone/m1 is the best model on the board, so it is the recommended one.
    await expect(rowsOf(part).first()).toHaveAttribute("data-nr-recommended", "true");
    const before = await configSaves(page);
    await button(part, "Use the recommended model").click();
    const note = noteOf(part);
    await expect(note).toHaveAttribute("role", "alert");
    await expect(note).toHaveText(
      "The default was not changed: the provider gone is not Ollama and is not listed in the providers above.",
    );
    expect(await configText(page)).toBe(FILE);
    expect(await configSaves(page)).toBe(before);

    // The row's own button is refused the same way; a model of a known provider still works.
    await button(part, "Use m1 (gone) as the default").click();
    await expect(note).toContainText("the provider gone is not Ollama");
    expect(await configText(page)).toBe(FILE);
    await button(part, "Use llama3 (ollama) as the default").click();
    await expect(note).toHaveAttribute("role", "status");
    await expect(note).toContainText("llama3 (ollama) is now the default");
    await cancelSettings(page);
  });

  test("says why when config.jsonc cannot be edited, and writes nothing", async ({ page }) => {
    const broken = '{ "ai": { "defaults": [ }\n';
    await start(page, { file: broken, runs: [QWEN] });
    const part = await openBench(page);
    const before = await configSaves(page);
    await button(part, "Use the recommended model").click();
    const note = noteOf(part);
    await expect(note).toHaveAttribute("role", "alert");
    await expect(note).toContainText("The default was not changed: ");
    expect(await configText(page)).toBe(broken);
    expect(await configSaves(page)).toBe(before);
    await cancelSettings(page);
  });
});

test.describe("exporting", () => {
  test("copies the CSV with the fixed header and a line for each model", async ({ page }) => {
    await start(page, { file: FILE, runs: [QWEN, LLAMA, BIG, PHI_CANCELLED] });
    const part = await openBench(page);
    await button(part, "Copy scoreboard as CSV").click();
    await expect(noteOf(part)).toHaveText("Copied the scoreboard as CSV: 4 models.");

    // The clipboard of Windows hands every line break back as CRLF; the app writes LF.
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const csv = copied.replaceAll("\r\n", "\n");
    expect(csv.endsWith("\n")).toBe(true);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(BENCH_CSV_HEADER.join(","));
    expect(lines).toHaveLength(1 + 4);
    // One record for each model, in the order of the board; the third cell is the model.
    expect(lines.slice(1).map((line) => line.split(",")[2])).toEqual([
      "phi3",
      "qwen2",
      "llama3",
      "big",
    ]);
    // Only the recommended model says `true` in the last column, and a cancelled run says so.
    expect(lines.slice(1).map((line) => line.split(",").at(-1))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    expect(lines[1]).toContain(",cancelled,");
    // Copying changes nothing in the settings.
    expect(await configText(page)).toBe(FILE);
    await cancelSettings(page);
  });
});

test.describe("in Portuguese", () => {
  /** Opens the settings screen of a page in Brazilian Portuguese and returns the bench part. */
  async function openBenchPt(page: Page): Promise<Locator> {
    await page.getByRole("button", { name: "Configurações", exact: true }).click();
    const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
    await expect(screen).toBeVisible();
    const part = bench(screen.getByRole("region", { name: "IA", exact: true }));
    await expect(part).toBeVisible();
    return part;
  }

  test("shows the empty text in Brazilian Portuguese", async ({ page }) => {
    await start(page, { file: PT });
    const part = await openBenchPt(page);
    await expect(
      part.getByRole("heading", { name: "Bench de modelos", exact: true }),
    ).toBeVisible();
    await expect(part.locator('[data-nr-part="settings-bench-empty"]')).toContainText(
      "Ainda não há resultados do bench.",
    );
  });

  test("shows the table, the cancelled run and the note in Brazilian Portuguese", async ({
    page,
  }) => {
    await start(page, { file: PT, runs: [QWEN, PHI_CANCELLED] });
    const part = await openBenchPt(page);
    await expect(rowsOf(part).nth(0)).toContainText("Cancelada, 2 de 6 tarefas");
    await expect(part.getByRole("table", { name: "Placar do bench", exact: true })).toBeVisible();
    await expect(part.locator('[data-nr-part="settings-bench-badge"]')).toHaveText("Recomendado");
    await button(part, "Usar o modelo recomendado").click();
    await expect(noteOf(part)).toContainText("agora é o padrão de Perguntar, Explicar e Comando");
  });
});

test.describe("accessibility", () => {
  test("axe: the scoreboard with no result has no violation", async ({ page }) => {
    await start(page, { file: FILE });
    const part = await openBench(page);
    await part.scrollIntoViewIfNeeded();
    await expectNoAxeViolations(page, "bench scoreboard, empty");
  });

  test("axe: the scoreboard with finished and cancelled runs, and with its notes, has no violation", async ({
    page,
  }) => {
    await start(page, { file: FILE, runs: [BIG, QWEN, LLAMA, PHI_CANCELLED, GONE] });
    const part = await openBench(page);
    await expect(rowsOf(part)).toHaveCount(5);
    await part.scrollIntoViewIfNeeded();
    await expectNoAxeViolations(page, "bench scoreboard, with results");
    await button(part, "Use the recommended model").click();
    await expect(noteOf(part)).toBeVisible();
    await expectNoAxeViolations(page, "bench scoreboard, with a note");
  });

  test("axe: the scoreboard with only a cancelled run has no violation", async ({ page }) => {
    await start(page, { file: FILE, runs: [PHI_CANCELLED] });
    const part = await openBench(page);
    await expect(rowsOf(part)).toHaveCount(1);
    await expectNoAxeViolations(page, "bench scoreboard, cancelled run only");
  });
});
