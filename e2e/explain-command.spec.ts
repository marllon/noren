import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";
import { openCommandPalette } from "./palette-fixture";

// The two ways into the AI that do not start at the Ask panel: the Explain button on the mark of a
// command that failed (it opens the panel with that command and its output as a chip), and `? text`
// in the palette (it asks for a command for the shell and the system of the pane and puts it at the
// prompt, never with Enter). Both go through a preview of exactly what will be sent, and neither
// runs anything. The AI side is the fake one of the web build (a fake Ollama and a fake provider
// that records what it was sent); nothing reaches a network or the keychain of the system.

interface Hook {
  paneIds(): string[];
  lines(): string[];
  marks(): { state: string; failed: boolean; text: string }[];
  writes(): { id: number; data: string }[];
  aiChats(): {
    providerId: string;
    model: string | undefined;
    messages: { role: string; content: string }[];
  }[];
  aiCancels(): string[];
  setAiReply(text: string | null): void;
  holdAiAnswer(held: boolean): void;
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_AI_OLLAMA_KEY = "noren.web.ai-ollama";

/** The AI on: Ask on llama3, Explain on qwen2 and Command on mistral, all of the fake Ollama. */
const FILE_ON = `{
  "ai": {
    "enabled": true,
    "defaults": {
      "ask": { "provider": "ollama", "model": "llama3" },
      "explain": { "provider": "ollama", "model": "qwen2" },
      "command": { "provider": "ollama", "model": "mistral" }
    }
  }
}
`;
const FILE_OFF = `{ "notifications": { "enabled": true } }\n`;
/** The AI on and nobody named: Command finds the first model of the Ollama of the computer. */
const FILE_UNNAMED = `{ "ai": { "enabled": true } }\n`;

const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);
const writes = (page: Page): Promise<{ id: number; data: string }[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.writes() ?? []);
const chats = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.aiChats() ?? []);
const cancels = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.aiCancels() ?? []);
const marks = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.marks() ?? []);
const doneCommands = async (page: Page): Promise<number> =>
  (await marks(page)).filter((mark) => mark.state === "done").length;
const setReply = (page: Page, text: string | null): Promise<void> =>
  page.evaluate((reply) => (window as HookWindow).__norenTest?.setAiReply(reply), text);
const hold = (page: Page, held: boolean): Promise<void> =>
  page.evaluate((on) => (window as HookWindow).__norenTest?.holdAiAnswer(on), held);

/** What the person reads in a preview: the messages, role by role, as `previewOfMessages` writes them. */
const previewOf = (messages: { role: string; content: string }[]): string =>
  messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n");

/** The system the page says it runs on, as the dialog names it. */
const osOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const agent = navigator.userAgent;
    if (/windows/i.test(agent)) return "Windows";
    if (/mac os x|macintosh/i.test(agent)) return "macOS";
    return "Linux";
  });

const panel = (page: Page): Locator =>
  page.getByRole("complementary", { name: "Ask", exact: true });
const previewRegion = (page: Page): Locator =>
  panel(page).getByRole("region", { name: "Preview of what will be sent", exact: true });
const previewBox = (page: Page): Locator => panel(page).locator('[data-nr-part="ask-preview"]');
const exchange = (page: Page, state?: string): Locator =>
  panel(page).locator(
    state === undefined
      ? '[data-nr-part="ask-exchange"]'
      : `[data-nr-part="ask-exchange"][data-nr-state="${state}"]`,
  );
const button = (scope: Locator, name: string): Locator =>
  scope.getByRole("button", { name, exact: true });
const explainButtons = (page: Page): Locator =>
  page.locator('[data-nr-part="pane"]:visible [data-nr-part="explain-button"]');
const failedMarks = (page: Page): Locator =>
  page.locator(
    '[data-nr-part="pane"]:visible [data-nr-part="command-mark"][data-nr-state="failed"]',
  );
const terminalFocused = (page: Page): Locator =>
  page.locator("textarea.xterm-helper-textarea:focus");

const dialog = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Ask for a command", exact: true });
const dialogPreview = (page: Page): Locator =>
  dialog(page).locator('[data-nr-part="command-preview"]');
const paletteBox = (page: Page): Locator =>
  page.getByRole("combobox", { name: "Command palette", exact: true });

async function start(
  page: Page,
  options: { file?: string; ollama?: string[] | null } = {},
): Promise<void> {
  await seedConfig(page, options.file ?? FILE_ON);
  if (options.ollama !== null) {
    await page.addInitScript(
      ({ key, value }) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      {
        key: WEB_AI_OLLAMA_KEY,
        value: JSON.stringify(options.ollama ?? ["llama3", "qwen2", "mistral"]),
      },
    );
  }
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
  await expect.poll(async () => (await lines(page)).some((l) => l.startsWith("fake$"))).toBe(true);
  await page.locator('[data-nr-part="pane"]:visible').click();
}

/** Runs a command line in the terminal on screen and waits until it has ended. */
async function run(page: Page, line: string): Promise<void> {
  const before = await doneCommands(page);
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
  await expect.poll(() => doneCommands(page)).toBe(before + 1);
}

/** Opens the palette on `? <text>` and waits for its entry. */
async function askInPalette(page: Page, text: string): Promise<void> {
  await openCommandPalette(page);
  await expect(paletteBox(page)).toBeVisible();
  await paletteBox(page).fill(`? ${text}`);
}

/** Opens the dialog of the palette with this request and waits for its preview. */
async function openCommandDialog(page: Page, text: string): Promise<void> {
  await askInPalette(page, text);
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(dialogPreview(page)).toBeVisible();
}

test.describe("Explain on the mark of a failed command", () => {
  test("opens Ask with that command and its output, not the last one, and Explain answers it", async ({
    page,
  }) => {
    await start(page);
    await run(page, "nosuchcmd --flag");
    await run(page, "echo later-output");

    // Only the command that failed has the button; the one that worked has none.
    await expect(failedMarks(page)).toHaveCount(1);
    await expect(explainButtons(page)).toHaveCount(1);
    await expect(panel(page)).toHaveCount(0);

    await explainButtons(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator('[data-nr-part="ask-target"]')).toHaveText("Ollama · qwen2");
    await expect(panel(page).locator('[data-nr-part="ask-explain-chip"]')).toContainText(
      "Command: fake$ nosuchcmd --flag",
    );
    // The preview is open already, and nothing has gone to the provider.
    await expect(previewRegion(page)).toBeVisible();
    await expect(previewBox(page)).toContainText("### Output of a command");
    await expect(previewBox(page)).toContainText("Command: fake$ nosuchcmd --flag");
    await expect(previewBox(page)).toContainText("Exit code: 127");
    await expect(previewBox(page)).toContainText("fake: command not found: nosuchcmd");
    await expect(previewBox(page)).toContainText("Why did this command fail, and how do I fix it?");
    await expect(previewBox(page)).not.toContainText("later-output");
    expect(await chats(page)).toHaveLength(0);
    const shownInPreview = await previewBox(page).evaluate((element) => element.textContent ?? "");

    await button(previewRegion(page), "Send").click();
    await expect(exchange(page, "done")).toHaveCount(1);
    const sent = await chats(page);
    expect(sent).toHaveLength(1);
    // Explain has its own provider and model, not the one of Ask.
    expect(sent[0]?.providerId).toBe("ollama");
    expect(sent[0]?.model).toBe("qwen2");
    // What was sent is exactly what the preview showed.
    expect(shownInPreview).toBe(previewOf(sent[0]?.messages ?? []));
    // The chip is spent with the question: the next one is Ask's again.
    await expect(panel(page).locator('[data-nr-part="ask-explain-chip"]')).toHaveCount(0);
    await expect(panel(page).locator('[data-nr-part="ask-target"]')).toHaveText("Ollama · llama3");
  });

  test("is only a preview: Edit goes back to the question and nothing is sent", async ({
    page,
  }) => {
    await start(page);
    await run(page, "nosuchcmd");
    await explainButtons(page).click();
    await expect(previewRegion(page)).toBeVisible();
    await button(previewRegion(page), "Edit").click();
    await expect(previewRegion(page)).toHaveCount(0);
    await expect(panel(page).getByRole("textbox", { name: "Question", exact: true })).toHaveValue(
      "Why did this command fail, and how do I fix it?",
    );
    // The chip can be taken out, and the question is Ask's again.
    await button(panel(page), "Remove the command").click();
    await expect(panel(page).locator('[data-nr-part="ask-explain-chip"]')).toHaveCount(0);
    await expect(panel(page).locator('[data-nr-part="ask-target"]')).toHaveText("Ollama · llama3");
    expect(await chats(page)).toHaveLength(0);
  });

  test("the code block of the answer goes to the prompt without Enter, and nothing runs", async ({
    page,
  }) => {
    await start(page);
    await setReply(page, "It is not installed. Try:\n\n```sh\nwhich nosuchcmd\n```\n");
    await run(page, "nosuchcmd");
    await explainButtons(page).click();
    await button(previewRegion(page), "Send").click();
    await expect(exchange(page, "done")).toHaveCount(1);

    const before = (await writes(page)).length;
    const commands = await doneCommands(page);
    await button(panel(page), "Insert in terminal").click();
    await expect.poll(async () => (await writes(page)).length).toBe(before + 1);
    const written = (await writes(page)).slice(before).map((write) => write.data);
    expect(written).toEqual(["which nosuchcmd"]);
    expect(written.join("")).not.toMatch(/[\r\n]/);
    await expect(terminalFocused(page)).toHaveCount(1);
    expect(await doneCommands(page)).toBe(commands);
  });

  test("a second press replaces the first, and an output of its own comes with each command", async ({
    page,
  }) => {
    await start(page);
    await run(page, "firstbad");
    await run(page, "secondbad");
    await expect(explainButtons(page)).toHaveCount(2);

    await explainButtons(page).nth(0).click();
    await expect(previewBox(page)).toContainText("Command: fake$ firstbad");
    await expect(previewBox(page)).toContainText("fake: command not found: firstbad");
    await expect(previewBox(page)).not.toContainText("secondbad");

    await explainButtons(page).nth(1).click();
    await expect(previewBox(page)).toContainText("Command: fake$ secondbad");
    await expect(previewBox(page)).toContainText("fake: command not found: secondbad");
    await expect(previewBox(page)).not.toContainText("firstbad");
    expect(await chats(page)).toHaveLength(0);
  });

  test("a command that worked, and one that is still running, have no button", async ({ page }) => {
    await start(page);
    await run(page, "echo fine");
    await page.keyboard.type("sleep 30");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await marks(page)).some((mark) => mark.state === "running"))
      .toBe(true);
    await expect(explainButtons(page)).toHaveCount(0);
    await expect(failedMarks(page)).toHaveCount(0);
  });

  test("with no provider the panel gives the steps, with Explain in the last one", async ({
    page,
  }) => {
    await start(page, { file: `{ "ai": { "enabled": true } }\n`, ollama: null });
    await run(page, "nosuchcmd");
    await explainButtons(page).click();
    await expect(panel(page).locator('[data-nr-part="ask-steps"]')).toContainText(
      "choose the provider and the model for Explain",
    );
    expect(await chats(page)).toHaveLength(0);
  });
});

test.describe("Explain where the AI is off", () => {
  const switcher = (page: Page) => page.getByRole("navigation", { name: "Spaces", exact: true });
  const menu = (page: Page) => page.getByRole("menu", { name: "Main options", exact: true });
  const aiItem = (page: Page) =>
    menu(page).getByRole("menuitemcheckbox", { name: /^(✓ )?AI in this space$/ });

  test("off in the settings, a failed command has its mark and no button", async ({ page }) => {
    await start(page, { file: FILE_OFF });
    await run(page, "nosuchcmd");
    await expect(failedMarks(page)).toHaveCount(1);
    await expect(explainButtons(page)).toHaveCount(0);
    expect(await chats(page)).toHaveLength(0);
  });

  test("off for the space the button goes, and it comes back with the AI", async ({ page }) => {
    await start(page);
    await run(page, "nosuchcmd");
    await expect(explainButtons(page)).toHaveCount(1);

    await switcher(page).getByRole("button", { name: "Main", exact: true }).click({
      button: "right",
    });
    await aiItem(page).click();
    await expect(aiItem(page)).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(failedMarks(page)).toHaveCount(1);
    await expect(explainButtons(page)).toHaveCount(0);

    await switcher(page).getByRole("button", { name: "Main", exact: true }).click({
      button: "right",
    });
    await aiItem(page).click();
    await expect(aiItem(page)).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(explainButtons(page)).toHaveCount(1);
    expect(await chats(page)).toHaveLength(0);
  });

  test("the panel that Explain opened goes away with the AI, and nothing is sent", async ({
    page,
  }) => {
    await start(page);
    await run(page, "nosuchcmd");
    await explainButtons(page).click();
    await expect(previewRegion(page)).toBeVisible();

    await switcher(page).getByRole("button", { name: "Main", exact: true }).click({
      button: "right",
    });
    await aiItem(page).click();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(explainButtons(page)).toHaveCount(0);
    expect(await chats(page)).toHaveLength(0);
  });
});

test.describe("? text in the palette", () => {
  test("asks for a command for the shell and the system of the pane, and puts it at the prompt without Enter", async ({
    page,
  }) => {
    await start(page);
    await setReply(page, "```sh\nls -la\n```");
    await askInPalette(page, "list the big files here");
    const entry = page.getByRole("option", { name: /Ask for a command: list the big files here/ });
    await expect(entry).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(paletteBox(page)).toBeHidden();

    // The dialog shows what will be sent, and nothing has gone.
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText("This goes to Ollama · mistral.");
    const os = await osOf(page);
    await expect(dialogPreview(page)).toContainText(
      `The shell is Fake shell and the system is ${os}`,
    );
    await expect(dialogPreview(page)).toContainText("[user]\nlist the big files here");
    await expect(dialogPreview(page)).toContainText("command alone");
    await expect(dialog(page).locator('[data-nr-part="command-secrets"]')).toHaveText(
      "No secret was found in what will be sent.",
    );
    expect(await chats(page)).toHaveLength(0);
    const shownInPreview = await dialogPreview(page).evaluate(
      (element) => element.textContent ?? "",
    );

    await button(dialog(page), "Send").click();
    await expect(dialog(page).locator('[data-nr-part="command-text"]')).toHaveText("ls -la");
    const sent = await chats(page);
    expect(sent).toHaveLength(1);
    // Command has its own provider and model.
    expect(sent[0]?.providerId).toBe("ollama");
    expect(sent[0]?.model).toBe("mistral");
    // What was sent is exactly what the preview showed.
    expect(shownInPreview).toBe(previewOf(sent[0]?.messages ?? []));
    expect(sent[0]?.messages.map((message) => message.role)).toEqual(["system", "user"]);

    // The command is shown and nothing was written to the terminal yet.
    const before = (await writes(page)).length;
    const commands = await doneCommands(page);
    await button(dialog(page), "Insert at the prompt").click();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(async () => (await writes(page)).length).toBe(before + 1);
    const written = (await writes(page)).slice(before).map((write) => write.data);
    expect(written).toEqual(["ls -la"]);
    expect(written.join("")).not.toMatch(/[\r\n]/);
    // It sits at the prompt, not run: no command ended, and no output of `ls` came.
    await expect
      .poll(async () => (await lines(page)).some((l) => l.trim() === "fake$ ls -la"))
      .toBe(true);
    expect(await doneCommands(page)).toBe(commands);
    expect((await lines(page)).some((l) => l.includes("README.md"))).toBe(false);
    await expect(terminalFocused(page)).toHaveCount(1);
    expect(await chats(page)).toHaveLength(1);
  });

  test("takes one line out of an answer with words and several lines, and never a line break", async ({
    page,
  }) => {
    await start(page);
    await setReply(page, "Sure, here it is:\n\n```sh\r\ncd /tmp\r\nls\r\n```\n\nThat is all.");
    await openCommandDialog(page, "go to tmp and list");
    await button(dialog(page), "Send").click();
    await expect(dialog(page).locator('[data-nr-part="command-text"]')).toHaveText("cd /tmp");
    await expect(dialog(page)).toContainText(
      "The answer had more lines; only the first one is used.",
    );

    const before = (await writes(page)).length;
    await button(dialog(page), "Insert at the prompt").click();
    await expect.poll(async () => (await writes(page)).length).toBe(before + 1);
    const written = (await writes(page)).slice(before).map((write) => write.data);
    expect(written).toEqual(["cd /tmp"]);
    expect(written.join("")).not.toMatch(/[\r\n]/);
    expect(await doneCommands(page)).toBe(0);
  });

  test("an answer with no command is said so, and there is nothing to insert", async ({ page }) => {
    await start(page);
    await setReply(page, "```\n\n```");
    await openCommandDialog(page, "do something");
    await button(dialog(page), "Send").click();
    await expect(dialog(page).locator('[data-nr-part="command-problem"]')).toHaveText(
      "The answer had no command.",
    );
    await expect(button(dialog(page), "Insert at the prompt")).toHaveCount(0);
    expect((await writes(page)).every((write) => !/[\r\n]/.test(write.data))).toBe(true);
    await button(dialog(page), "Close").click();
    await expect(dialog(page)).toHaveCount(0);
  });

  test("swaps secrets in the request for markers before anything is sent, and says how many", async ({
    page,
  }) => {
    await start(page);
    await openCommandDialog(page, "upload with token=" + "abc123def456ghi789" + " to the server");
    await expect(dialogPreview(page)).toContainText("[REDACTED:token]");
    await expect(dialogPreview(page)).not.toContainText("abc123def456ghi789");
    await expect(dialog(page).locator('[data-nr-part="command-secrets"]')).toHaveText(
      "1 secret was replaced by a marker (token).",
    );
    await button(dialog(page), "Send").click();
    await expect(dialog(page).locator('[data-nr-part="command-text"]')).toBeVisible();
    const sent = JSON.stringify((await chats(page))[0]?.messages);
    expect(sent).toContain("[REDACTED:token]");
    expect(sent).not.toContain("abc123def456ghi789");
  });

  test("Escape and Cancel close it, and nothing is sent", async ({ page }) => {
    await start(page);
    await openCommandDialog(page, "something");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(terminalFocused(page)).toHaveCount(1);

    await openCommandDialog(page, "something else");
    await button(dialog(page), "Cancel").click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await chats(page)).toHaveLength(0);
    expect((await writes(page)).length).toBe(0);
  });

  test("Stop ends the request, and nothing is put at the prompt", async ({ page }) => {
    await start(page);
    await openCommandDialog(page, "a long one");
    await hold(page, true);
    await button(dialog(page), "Send").click();
    await expect(dialog(page).locator('[data-nr-part="command-waiting"]')).toBeVisible();
    await button(dialog(page), "Stop").click();
    await expect(dialog(page).locator('[data-nr-part="command-problem"]')).toHaveText("Stopped.");
    expect(await cancels(page)).toHaveLength(1);
    await expect(button(dialog(page), "Insert at the prompt")).toHaveCount(0);
    await hold(page, false);
  });

  test("a question mark with nothing after it only hints, and Enter opens nothing", async ({
    page,
  }) => {
    await start(page);
    await askInPalette(page, "");
    await expect(page.locator('[data-nr-part="palette-ask-hint"]')).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toHaveCount(0);
    expect(await chats(page)).toHaveLength(0);
  });

  test("with no provider it gives the steps and has no Send", async ({ page }) => {
    await start(page, { file: FILE_UNNAMED, ollama: null });
    await askInPalette(page, "anything");
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('[data-nr-part="command-steps"]')).toContainText(
      "choose the provider and the model for Command",
    );
    await expect(button(dialog(page), "Send")).toHaveCount(0);
    expect(await chats(page)).toHaveLength(0);
  });

  test("the hint of the search box says how to ask, and other searches are not touched", async ({
    page,
  }) => {
    await start(page);
    await openCommandPalette(page);
    await expect(paletteBox(page)).toHaveAttribute("placeholder", /\? ask for a command/);
    await paletteBox(page).fill("> new tab");
    await expect(page.getByRole("option").first()).toBeVisible();
    await expect(page.getByRole("option", { name: /Ask for a command/ })).toHaveCount(0);
  });
});

test.describe("? text where the AI is off", () => {
  const switcher = (page: Page) => page.getByRole("navigation", { name: "Spaces", exact: true });
  const menu = (page: Page) => page.getByRole("menu", { name: "Main options", exact: true });
  const aiItem = (page: Page) =>
    menu(page).getByRole("menuitemcheckbox", { name: /^(✓ )?AI in this space$/ });

  test("off in the settings the question mark is an ordinary search", async ({ page }) => {
    await start(page, { file: FILE_OFF });
    await openCommandPalette(page);
    await expect(paletteBox(page)).not.toHaveAttribute("placeholder", /ask for a command/);
    await paletteBox(page).fill("? list the big files");
    await expect(page.getByRole("option", { name: /Ask for a command/ })).toHaveCount(0);
    await expect(page.locator('[data-nr-part="palette-ask-hint"]')).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toHaveCount(0);
    expect(await chats(page)).toHaveLength(0);
  });

  test("off for the space the question mark does nothing, and on again it asks", async ({
    page,
  }) => {
    await start(page);
    await switcher(page).getByRole("button", { name: "Main", exact: true }).click({
      button: "right",
    });
    await aiItem(page).click();
    await expect(aiItem(page)).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");

    await page.locator('[data-nr-part="pane"]:visible').click();
    await askInPalette(page, "list files");
    await expect(page.getByRole("option", { name: /Ask for a command/ })).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(await chats(page)).toHaveLength(0);

    await switcher(page).getByRole("button", { name: "Main", exact: true }).click({
      button: "right",
    });
    await aiItem(page).click();
    await expect(aiItem(page)).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.locator('[data-nr-part="pane"]:visible').click();
    await openCommandDialog(page, "list files");
    expect(await chats(page)).toHaveLength(0);
  });

  test("the dialog goes away when the AI is turned off under it, and nothing is sent", async ({
    page,
  }) => {
    await start(page);
    await openCommandDialog(page, "list files");
    // The dialog holds the keyboard; the space menu is out of reach, so the setting changes under it.
    await page.evaluate(() => {
      const hook = window as HookWindow & {
        __norenTest?: { setConfig(text: string | null): void };
      };
      hook.__norenTest?.setConfig(`{ "notifications": { "enabled": true } }\n`);
    });
    await expect(dialog(page)).toHaveCount(0);
    expect(await chats(page)).toHaveLength(0);
  });
});
