import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { BENCH_MODEL_CATALOG, recommendedBenchModels } from "../packages/model/src/bench-models";
import type { BenchHardware } from "../packages/model/src/bench-models";
import { cancelSettings, openSettings, seedConfig } from "./settings-fixture";

// The recommended models in the AI section of the settings screen: the memory of the computer is
// seeded under the `noren.web.hardware` key of the web build (a browser cannot read it), the list is
// the one `recommendedBenchModels` chooses for it, and the install button shows the `ollama pull`
// command and asks first. Only after the person confirms is the text put at the prompt of the
// terminal, never with Enter; nothing here runs it and nothing reaches a network.

interface Hook {
  paneIds(): string[];
  focusedPaneId(): string | undefined;
  lines(): string[];
  marks(): { state: string }[];
  writes(): { id: number; data: string }[];
  hardwareReads(): number;
  sendOutput(paneId: string, text: string): boolean;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_HARDWARE_KEY = "noren.web.hardware";
const GIB = 1024 ** 3;
const PT = '{ "language": "pt-BR" }\n';

const ram = (gib: number, vramGib: number | null = null): BenchHardware => ({
  ramBytes: gib * GIB,
  vramBytes: vramGib === null ? null : vramGib * GIB,
});

const models = (screen: Locator) => screen.locator('[data-nr-part="settings-ai-models"]');
const rowsOf = (scope: Locator) => scope.locator('[data-nr-part="settings-models-row"]');
const noteOf = (scope: Locator) => scope.locator('[data-nr-part="settings-models-note"]');
const warningOf = (scope: Locator) => scope.locator('[data-nr-part="settings-models-warning"]');
const button = (scope: Locator, name: string) => scope.getByRole("button", { name, exact: true });
const question = (page: Page, name: string) => page.getByRole("alertdialog", { name, exact: true });

const writes = (page: Page): Promise<{ id: number; data: string }[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.writes() ?? []);
const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);
const hardwareReads = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.hardwareReads() ?? -1);
const doneCommands = async (page: Page): Promise<number> =>
  (await page.evaluate(() => (window as HookWindow).__norenTest?.marks() ?? [])).filter(
    (mark) => mark.state === "done",
  ).length;

/** Seeds the memory of the computer before the page loads (only on the first load of a test). */
async function seedHardware(page: Page, hardware: BenchHardware): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_HARDWARE_KEY, value: JSON.stringify(hardware) },
  );
}

async function start(
  page: Page,
  options: { hardware?: BenchHardware; file?: string } = {},
): Promise<void> {
  if (options.file !== undefined) await seedConfig(page, options.file);
  if (options.hardware !== undefined) await seedHardware(page, options.hardware);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
}

/** Opens the settings screen and returns the recommended models part of its AI section. */
async function openModels(page: Page): Promise<Locator> {
  const screen = await openSettings(page);
  const part = models(screen.getByRole("region", { name: "AI", exact: true }));
  await expect(part).toBeVisible();
  return part;
}

/** Opens the settings screen of a page in Brazilian Portuguese and returns the models part. */
async function openModelsPt(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  const screen = page.getByRole("dialog", { name: "Configurações", exact: true });
  await expect(screen).toBeVisible();
  const part = models(screen.getByRole("region", { name: "IA", exact: true }));
  await expect(part).toBeVisible();
  return part;
}

/** The ids the choice makes for a computer, in its order. */
function chosenIds(hardware: BenchHardware): string[] {
  const chosen = recommendedBenchModels(hardware);
  if (!chosen.ok) throw new Error("the reading is valid");
  return chosen.models.map((entry) => entry.model.id);
}

async function shownIds(part: Locator): Promise<(string | null)[]> {
  return rowsOf(part).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-nr-model")));
}

const PHI = "phi4-mini:latest";
const PHI_COMMAND = `ollama pull ${PHI}`;

test.describe("the list for the computer", () => {
  const machines: { name: string; hardware: BenchHardware; count: number; best: string }[] = [
    { name: "4 GiB of RAM", hardware: ram(4), count: 1, best: "qwen2.5-coder:1.5b" },
    { name: "8 GiB of RAM, no video memory", hardware: ram(8), count: 5, best: PHI },
    { name: "32 GiB of RAM", hardware: ram(32), count: 11, best: "qwen3:14b" },
    { name: "6 GiB of video memory", hardware: ram(16, 6), count: 5, best: PHI },
    { name: "24 GiB of video memory", hardware: ram(16, 24), count: 13, best: "qwen2.5-coder:32b" },
  ];

  for (const machine of machines) {
    test(`shows the models of a computer with ${machine.name}, in the order of the choice`, async ({
      page,
    }) => {
      await start(page, { hardware: machine.hardware });
      const part = await openModels(page);
      await expect(rowsOf(part)).toHaveCount(machine.count);
      const ids = await shownIds(part);
      expect(ids).toEqual(chosenIds(machine.hardware));
      expect(ids[0]).toBe(machine.best);
      // Not the whole catalog, unless the computer holds all of it.
      expect(ids.length <= BENCH_MODEL_CATALOG.length).toBe(true);
      await expect(rowsOf(part).first()).toHaveAttribute("data-nr-reason", "largest-fit");
      if (machine.count > 1) {
        await expect(rowsOf(part).nth(1)).toHaveAttribute("data-nr-reason", "fits");
      }
      expect(await hardwareReads(page)).toBe(1);
    });
  }

  test("two computers get different lists", async ({ page }) => {
    await start(page, { hardware: ram(8) });
    const small = await shownIds(await openModels(page));
    await cancelSettings(page);
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key ?? "", value ?? ""),
      [WEB_HARDWARE_KEY, JSON.stringify(ram(16, 24))],
    );
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
      .toBeGreaterThan(0);
    const large = await shownIds(await openModels(page));
    expect(small).toHaveLength(5);
    expect(large).toHaveLength(13);
    expect(large).not.toEqual(small);
  });

  test("says in words what the computer has and what a model may take", async ({ page }) => {
    await start(page, { hardware: ram(8) });
    const part = await openModels(page);
    await expect(part.locator('[data-nr-part="settings-models-hardware"]')).toHaveText(
      "This computer: 8.0 GiB of RAM, video memory not known.",
    );
    await expect(part.locator('[data-nr-part="settings-models-budget"]')).toHaveText(
      "Chosen for the RAM: a model may take 4.8 GiB of it (60%).",
    );
    await cancelSettings(page);

    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key ?? "", value ?? ""),
      [WEB_HARDWARE_KEY, JSON.stringify(ram(16, 24))],
    );
    await page.reload();
    const gpu = await openModels(page);
    await expect(gpu.locator('[data-nr-part="settings-models-hardware"]')).toHaveText(
      "This computer: 16.0 GiB of RAM and 24.0 GiB of video memory.",
    );
    await expect(gpu.locator('[data-nr-part="settings-models-budget"]')).toHaveText(
      "Chosen for the video memory: a model may take 21.6 GiB of it (90%).",
    );
  });

  test("shows, for each model, its name, download, memory, uses, license and why", async ({
    page,
  }) => {
    await start(page, { hardware: ram(8) });
    const part = await openModels(page);
    const first = rowsOf(part).first();
    await expect(first.getByRole("rowheader")).toHaveText(PHI);
    await expect(first.getByRole("cell")).toHaveText([
      "2.3 GiB",
      "3.5 GiB",
      "Ask, Explain, Command",
      "MIT",
      "The most capable that fits, 1.3 GiB to spare",
      "Install",
    ]);
    const second = rowsOf(part).nth(1);
    await expect(second.getByRole("cell").nth(4)).toContainText(/^Fits, .+ to spare$/);
    await expect(
      part.getByRole("table", { name: "Recommended models for this computer" }),
    ).toBeVisible();
  });

  test("says why when nothing fits, and offers nothing to install", async ({ page }) => {
    await start(page, { hardware: ram(1) });
    const part = await openModels(page);
    await expect(part.locator('[data-nr-part="settings-models-empty"]')).toHaveText(
      "No model of the list fits this computer: a model may take 614.4 MiB and the smallest one needs 2.0 GiB.",
    );
    await expect(rowsOf(part)).toHaveCount(0);
    await expect(part.getByRole("table")).toHaveCount(0);
    await expect(part.getByRole("button")).toHaveCount(0);
  });

  test("warns, without breaking the screen, when the memory of the computer is not known", async ({
    page,
  }) => {
    await start(page);
    const screen = await openSettings(page);
    const part = models(screen.getByRole("region", { name: "AI", exact: true }));
    await expect(warningOf(part)).toHaveText(
      "The memory of this computer is not known (a browser cannot read it), so Noren cannot say which models fit it.",
    );
    await expect(warningOf(part)).toHaveAttribute("role", "alert");
    await expect(rowsOf(part)).toHaveCount(0);
    await expect(part.getByRole("button")).toHaveCount(0);
    expect(await hardwareReads(page)).toBe(1);
    // The rest of the screen still works.
    await expect(screen.getByRole("heading", { name: "Model bench" })).toBeVisible();
    await cancelSettings(page);
  });

  test("a value that is no memory is no reading: the same warning", async ({ page }) => {
    await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
      key: WEB_HARDWARE_KEY,
      value: JSON.stringify({ ramBytes: -5, vramBytes: null }),
    });
    await start(page);
    const part = await openModels(page);
    await expect(warningOf(part)).toContainText("The memory of this computer is not known");
    await expect(rowsOf(part)).toHaveCount(0);
  });
});

test.describe("the guided install", () => {
  test("shows the command, asks first and writes nothing before the answer", async ({ page }) => {
    await start(page, { hardware: ram(8) });
    const part = await openModels(page);
    const before = (await writes(page)).length;

    await button(part, `Install ${PHI}`).click();
    const dialog = question(page, `Install ${PHI}?`);
    await expect(dialog).toBeVisible();
    // The text that would be put at the prompt is shown as it is.
    await expect(dialog.locator("pre")).toHaveText(PHI_COMMAND);
    await expect(dialog).toContainText("It does not press Enter");
    await expect(dialog).toContainText("2.3 GiB to download");
    await expect(button(dialog, "Cancel")).toBeFocused();
    expect((await writes(page)).length).toBe(before);
  });

  test("on confirm, puts the exact text at the prompt, with no Enter, and runs nothing", async ({
    page,
  }) => {
    await start(page, { hardware: ram(8) });
    const part = await openModels(page);
    const before = (await writes(page)).length;
    const commands = await doneCommands(page);

    await button(part, `Install ${PHI}`).click();
    await button(question(page, `Install ${PHI}?`), "Put at the prompt").click();

    await expect(question(page, `Install ${PHI}?`)).toHaveCount(0);
    // Exactly the text of the command was written: no \r, no \n, nothing else.
    await expect.poll(async () => (await writes(page)).length).toBe(before + 1);
    const written = (await writes(page)).slice(before);
    expect(written.map((write) => write.data)).toEqual([PHI_COMMAND]);
    expect(written[0]?.data).not.toMatch(/[\r\n]/);
    // It sits at the prompt, not run: no command ended and nothing answered.
    await expect
      .poll(async () => (await lines(page)).some((line) => line.trim() === `fake$ ${PHI_COMMAND}`))
      .toBe(true);
    expect(await doneCommands(page)).toBe(commands);
    expect((await writes(page)).length).toBe(before + 1);
    // The screen says so, stays open, and keeps the keyboard on its own button.
    await expect(noteOf(part)).toHaveText(
      `Put at the prompt: ${PHI_COMMAND}. It runs only when you press Enter in the terminal.`,
    );
    await expect(button(part, `Install ${PHI}`)).toBeFocused();
    await expect(page.locator("textarea.xterm-helper-textarea:focus")).toHaveCount(0);
    await cancelSettings(page);
    // Back in the terminal, Enter would be the person's.
    expect((await writes(page)).length).toBe(before + 1);
  });

  test("on cancel, nothing is written and nothing is said", async ({ page }) => {
    await start(page, { hardware: ram(8) });
    const part = await openModels(page);
    const before = (await writes(page)).length;

    await button(part, `Install ${PHI}`).click();
    await button(question(page, `Install ${PHI}?`), "Cancel").click();

    await expect(question(page, `Install ${PHI}?`)).toHaveCount(0);
    await expect(noteOf(part)).toHaveText("");
    await expect(button(part, `Install ${PHI}`)).toBeFocused();
    expect((await writes(page)).length).toBe(before);
    expect((await lines(page)).some((line) => line.includes("ollama pull"))).toBe(false);
  });

  test("Esc closes only the question: nothing is written and the settings stay open", async ({
    page,
  }) => {
    await start(page, { hardware: ram(8) });
    const screen = await openSettings(page);
    const part = models(screen.getByRole("region", { name: "AI", exact: true }));
    const before = (await writes(page)).length;

    await button(part, `Install ${PHI}`).click();
    await expect(question(page, `Install ${PHI}?`)).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(question(page, `Install ${PHI}?`)).toHaveCount(0);
    await expect(screen).toBeVisible();
    expect((await writes(page)).length).toBe(before);
  });

  test("each model puts its own command: another row, another text", async ({ page }) => {
    await start(page, { hardware: ram(16, 24) });
    const part = await openModels(page);
    const before = (await writes(page)).length;
    const id = "qwen2.5-coder:32b";

    await button(part, `Install ${id}`).click();
    await expect(question(page, `Install ${id}?`).locator("pre")).toHaveText(`ollama pull ${id}`);
    await button(question(page, `Install ${id}?`), "Put at the prompt").click();

    await expect.poll(async () => (await writes(page)).length).toBe(before + 1);
    expect((await writes(page)).slice(before).map((write) => write.data)).toEqual([
      `ollama pull ${id}`,
    ]);
  });

  test("every model of the list has an install button", async ({ page }) => {
    await start(page, { hardware: ram(16, 24) });
    const part = await openModels(page);
    await expect(rowsOf(part)).toHaveCount(13);
    await expect(part.getByRole("button", { name: /^Install / })).toHaveCount(13);
  });

  test("without a terminal to receive it, says so and writes nothing", async ({ page }) => {
    await start(page, { hardware: ram(8) });
    // Ctrl+click on a link in the output opens a browser pane beside the terminal; a click inside it
    // gives that pane the focus, and a browser pane is not a terminal.
    const [paneId = ""] = await page.evaluate(
      () => (window as HookWindow).__norenTest?.paneIds() ?? [],
    );
    await page.evaluate(
      (id) =>
        (window as HookWindow).__norenTest?.sendOutput(id, "[2J[Hdocs: https://example.com/a end"),
      paneId,
    );
    const screenArea = page.locator(".xterm-screen:visible").first();
    const box = await screenArea.boundingBox();
    if (box === null) throw new Error("the terminal is not on screen");
    const y = box.y + box.height / 24 / 2;
    await page.keyboard.down("Control");
    try {
      await page.mouse.move(box.x + 80, y);
      await page.mouse.move(box.x + 90, y);
      await page.mouse.click(box.x + 90, y);
    } finally {
      await page.keyboard.up("Control");
    }
    const address = page.getByRole("textbox", { name: "Address", exact: true });
    await expect(address).toBeVisible();
    await address.click();
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.focusedPaneId()))
      .not.toBe(paneId);

    const part = await openModels(page);
    const before = (await writes(page)).length;
    await button(part, `Install ${PHI}`).click();
    await button(question(page, `Install ${PHI}?`), "Put at the prompt").click();

    await expect(noteOf(part)).toHaveText(
      "There is no terminal to put the command in. Open a terminal tab and try again.",
    );
    await expect(noteOf(part)).toHaveAttribute("role", "alert");
    expect((await writes(page)).length).toBe(before);
  });
});

test.describe("in Portuguese", () => {
  test("the whole part is in pt-BR, and the install asks and puts the command at the prompt", async ({
    page,
  }) => {
    await start(page, { hardware: ram(8), file: PT });
    const part = await openModelsPt(page);
    await expect(part.getByRole("heading", { name: "Modelos recomendados" })).toBeVisible();
    await expect(part.locator('[data-nr-part="settings-models-hardware"]')).toHaveText(
      "Este computador: 8.0 GiB de RAM, memória de vídeo desconhecida.",
    );
    await expect(part.locator('[data-nr-part="settings-models-budget"]')).toHaveText(
      "Escolhidos pela RAM: um modelo pode usar 4.8 GiB dela (60%).",
    );
    const first = rowsOf(part).first();
    await expect(first.getByRole("cell").nth(2)).toHaveText("Perguntar, Explicar, Comando");
    await expect(first.getByRole("cell").nth(4)).toHaveText(
      "O mais capaz que cabe, com folga de 1.3 GiB",
    );
    const before = (await writes(page)).length;

    await button(part, `Instalar ${PHI}`).click();
    const dialog = question(page, `Instalar ${PHI}?`);
    await expect(dialog).toContainText("Não aperta Enter");
    await expect(dialog.locator("pre")).toHaveText(PHI_COMMAND);
    await button(dialog, "Colocar no prompt").click();

    await expect.poll(async () => (await writes(page)).length).toBe(before + 1);
    expect((await writes(page)).slice(before).map((write) => write.data)).toEqual([PHI_COMMAND]);
    await expect(noteOf(part)).toHaveText(
      `Colocado no prompt: ${PHI_COMMAND}. Só roda quando você apertar Enter no terminal.`,
    );
  });

  test("with no memory known, the warning is in pt-BR", async ({ page }) => {
    await start(page, { file: PT });
    const part = await openModelsPt(page);
    await expect(warningOf(part)).toContainText("A memória deste computador não é conhecida");
  });

  test("when nothing fits, the reason is in pt-BR", async ({ page }) => {
    await start(page, { hardware: ram(1), file: PT });
    const part = await openModelsPt(page);
    await expect(part.locator('[data-nr-part="settings-models-empty"]')).toContainText(
      "Nenhum modelo da lista cabe neste computador",
    );
  });
});
