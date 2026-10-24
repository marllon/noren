import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { closeShortcutsScreen, openShortcutsScreen, seedConfig } from "./settings-fixture";
import { afterNextFrame } from "./frames";
import { expectNoAxeViolations } from "./axe-fixture";
import { numberTheTabs } from "./numbered-tabs";
import { openCommandPalette } from "./palette-fixture";

test.beforeEach(numberTheTabs);

// The Ask panel (Ctrl+Shift+A): chips that read the terminal, the preview of exactly what will be
// sent (with the secrets already swapped for markers), the answer in pieces drawn as Markdown, the
// Stop button, and the button that puts a code block at the prompt without Enter. The AI side is the
// fake one of the web build (a fake Ollama seeded here, a fake provider that answers a word at a
// time and records what it was sent); nothing reaches a network or the keychain of the system.

interface Hook {
  paneIds(): string[];
  lines(): string[];
  marks(): { state: string }[];
  writes(): { id: number; data: string }[];
  aiChats(): {
    providerId: string;
    model: string | undefined;
    messages: { role: string; content: string }[];
  }[];
  aiCancels(): string[];
  setAiReply(text: string | null): void;
  holdAiAnswer(held: boolean): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_AI_OLLAMA_KEY = "noren.web.ai-ollama";

/** The AI on, with Ollama named for Ask (its models are seeded, so the fake provider answers). */
const FILE_ON = `{
  "ai": { "enabled": true, "defaults": { "ask": { "provider": "ollama", "model": "llama3" } } }
}
`;
/** The AI on, and nobody named: Ask finds the first model of the Ollama of the computer. */
const FILE_UNNAMED = `{ "ai": { "enabled": true } }\n`;
const FILE_OFF = `{ "notifications": { "enabled": true } }\n`;

const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);
const writes = (page: Page): Promise<{ id: number; data: string }[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.writes() ?? []);
const chats = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.aiChats() ?? []);
const cancels = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.aiCancels() ?? []);
const doneCommands = async (page: Page): Promise<number> =>
  (await page.evaluate(() => (window as HookWindow).__norenTest?.marks() ?? [])).filter(
    (mark) => mark.state === "done",
  ).length;
const setReply = (page: Page, text: string | null): Promise<void> =>
  page.evaluate((reply) => (window as HookWindow).__norenTest?.setAiReply(reply), text);
const hold = (page: Page, held: boolean): Promise<void> =>
  page.evaluate((on) => (window as HookWindow).__norenTest?.holdAiAnswer(on), held);

/** What the person reads in a preview: the messages, role by role, as `previewOfMessages` writes them. */
const previewOf = (messages: { role: string; content: string }[]): string =>
  messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n");

const panel = (page: Page): Locator =>
  page.getByRole("complementary", { name: "Ask", exact: true });
const questionBox = (page: Page): Locator =>
  panel(page).getByRole("textbox", { name: "Question", exact: true });
const previewBox = (page: Page): Locator => panel(page).locator('[data-nr-part="ask-preview"]');
const previewRegion = (page: Page): Locator =>
  panel(page).getByRole("region", { name: "Preview of what will be sent", exact: true });
const exchange = (page: Page, state?: string): Locator =>
  panel(page).locator(
    state === undefined
      ? '[data-nr-part="ask-exchange"]'
      : `[data-nr-part="ask-exchange"][data-nr-state="${state}"]`,
  );
const button = (scope: Locator, name: string): Locator =>
  scope.getByRole("button", { name, exact: true });
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
const terminalFocused = (page: Page): Locator =>
  page.locator("textarea.xterm-helper-textarea:focus");

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
      { key: WEB_AI_OLLAMA_KEY, value: JSON.stringify(options.ollama ?? ["llama3"]) },
    );
  }
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
  await expect.poll(async () => (await lines(page)).some((l) => l.startsWith("fake$"))).toBe(true);
  await page.locator('[data-nr-part="pane"]:visible').click();
}

/** Runs `echo <word>` in the terminal on screen and waits for its output. */
async function say(page: Page, word: string): Promise<void> {
  await page.keyboard.type(`echo ${word}`);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await lines(page)).includes(word)).toBe(true);
}

async function openAsk(page: Page): Promise<void> {
  await page.keyboard.press("Control+Shift+A");
  await expect(panel(page)).toBeVisible();
  await expect(questionBox(page)).toBeFocused();
}

/** Types the question and goes to the preview, which is what Enter does. */
async function previewQuestion(page: Page, question: string): Promise<void> {
  await questionBox(page).fill(question);
  await questionBox(page).press("Enter");
  await expect(previewRegion(page)).toBeVisible();
}

/** Sends the previewed question and waits for the answer to end. */
async function send(page: Page, state = "done"): Promise<void> {
  await button(previewRegion(page), "Send").click();
  await expect(exchange(page, state)).toHaveCount(1);
}

test.describe("the context chips and the preview", () => {
  test("a question with an @tab sends the text of that tab, and the preview is what was sent", async ({
    page,
  }) => {
    await start(page);
    await say(page, "needle-beta");
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect
      .poll(async () => (await lines(page)).some((l) => l.startsWith("fake$")))
      .toBe(true);
    await say(page, "gamma-out");

    await openAsk(page);
    await expect(panel(page).locator('[data-nr-part="ask-target"]')).toHaveText("Ollama · llama3");
    await button(panel(page), "@ Tab").click();
    const list = panel(page).getByRole("group", { name: "Tabs to add", exact: true });
    // Only the other tab can be added.
    await expect(list.getByRole("button")).toHaveText(["Tab 1"]);
    await button(list, "Tab 1").click();
    await expect(panel(page).locator('[data-nr-part="ask-tab-chip"]')).toHaveText("@Tab 1");

    await previewQuestion(page, "what did the other tab print?");
    await expect(previewBox(page)).toContainText("### Tab: Tab 1");
    await expect(previewBox(page)).toContainText("needle-beta");
    await expect(previewBox(page)).toContainText("what did the other tab print?");
    // The tab on screen is not part of it.
    await expect(previewBox(page)).not.toContainText("gamma-out");
    const shownInPreview = await previewBox(page).evaluate((element) => element.textContent ?? "");
    // Previewing sends nothing.
    expect(await chats(page)).toHaveLength(0);

    await send(page);
    const sent = await chats(page);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.providerId).toBe("ollama");
    expect(sent[0]?.model).toBe("llama3");
    const user = sent[0]?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain("needle-beta");
    expect(user).toContain("what did the other tab print?");
    expect(user).not.toContain("gamma-out");
    // The preview was exactly what went out.
    expect(shownInPreview).toBe(previewOf(sent[0]?.messages ?? []));
  });

  test("the chips read the selection, the last output and the screen of the terminal", async ({
    page,
  }) => {
    await start(page);
    await say(page, "one-line");
    // Select the output of the last command (the palette action), then open the panel.
    await openCommandPalette(page);
    const palette = page.getByRole("combobox", { name: "Command palette", exact: true });
    await palette.fill("> Select command output");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    // The terminal takes the keyboard back as the palette goes; the panel opens after that.
    await expect(terminalFocused(page)).toHaveCount(1);
    // The closing palette may give the focus back at once; the app's own hand-back comes a frame
    // later and would take the keyboard from the panel opened before it.
    await afterNextFrame(page);

    await openAsk(page);
    const context = panel(page).getByRole("group", { name: "Context", exact: true });
    for (const name of ["Selection", "Last output", "Screen"]) {
      await expect(button(context, name)).toHaveAttribute("aria-pressed", "false");
      await button(context, name).click();
      await expect(button(context, name)).toHaveAttribute("aria-pressed", "true");
    }
    await previewQuestion(page, "explain");
    const text = (await previewBox(page).textContent()) ?? "";
    // In the order of the chips: the selection, the last output with its command, the screen.
    const at = (heading: string) => text.indexOf(heading);
    expect(at("### Selected text")).toBeGreaterThan(-1);
    expect(at("### Output of the last command")).toBeGreaterThan(at("### Selected text"));
    expect(at("### Visible screen")).toBeGreaterThan(at("### Output of the last command"));
    expect(at("## Question")).toBeGreaterThan(at("### Visible screen"));
    expect(text).toContain("Command: fake$ echo one-line");
    expect(text).toMatch(/### Selected text\n`{3}\none-line\n`{3}/);
    expect(text).toMatch(/### Output of the last command\nCommand: .*\n`{3}\none-line\n`{3}/);
    expect(text).toContain("fake$ echo one-line");
  });

  test("a chip that is on and has nothing to read is left out, and the preview says so", async ({
    page,
  }) => {
    await start(page);
    await openAsk(page);
    await button(panel(page), "Selection").click();
    await button(panel(page), "Last output").click();
    await previewQuestion(page, "anything?");
    await expect(previewBox(page)).not.toContainText("### Selected text");
    await expect(previewBox(page)).not.toContainText("### Output of the last command");
    await expect(previewRegion(page)).toContainText(
      "Selection: nothing is selected in the terminal.",
    );
    await expect(previewRegion(page)).toContainText(
      "Last output: no command has finished in this pane yet.",
    );
  });

  test("the preview counts the secrets it swapped, and what is sent has the markers, not the secrets", async ({
    page,
  }) => {
    await start(page);
    await say(page, "token=" + "abc123def456ghi789");
    await openAsk(page);
    await button(panel(page), "Screen").click();
    await previewQuestion(page, "why does this fail? password=correct-horse-9");
    await expect(previewBox(page)).toContainText("[REDACTED:password]");
    await expect(previewBox(page)).toContainText("[REDACTED:token]");
    await expect(previewBox(page)).not.toContainText("correct-horse-9");
    await expect(previewBox(page)).not.toContainText("abc123def456ghi789");
    // The screen holds the command and its output: two tokens there, and one password in the question.
    await expect(panel(page).locator('[data-nr-part="ask-secrets"]')).toHaveText(
      /^\d+ secrets were replaced by markers \((?:password|token)(?:, (?:password|token))?\)\.$/,
    );

    await send(page);
    const sent = JSON.stringify((await chats(page))[0]?.messages);
    expect(sent).toContain("[REDACTED:password]");
    expect(sent).not.toContain("correct-horse-9");
    expect(sent).not.toContain("abc123def456ghi789");
    // The line of the preview said no secret was left in it.
    await expect(exchange(page)).toHaveCount(1);
  });

  test("a clean question says no secret was found", async ({ page }) => {
    await start(page);
    await openAsk(page);
    await previewQuestion(page, "how do I list files?");
    await expect(panel(page).locator('[data-nr-part="ask-secrets"]')).toHaveText(
      "No secret was found in what will be sent.",
    );
  });

  test("Edit goes back to the question, which is still there, and nothing is sent", async ({
    page,
  }) => {
    await start(page);
    await openAsk(page);
    await previewQuestion(page, "first thoughts");
    await button(previewRegion(page), "Edit").click();
    await expect(previewRegion(page)).toHaveCount(0);
    await expect(questionBox(page)).toHaveValue("first thoughts");
    expect(await chats(page)).toHaveLength(0);
    // Escape in the preview also steps back to the question rather than closing the panel.
    await questionBox(page).press("Enter");
    await expect(previewRegion(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(previewRegion(page)).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
  });

  test("an empty question is refused with a word, and the preview does not open", async ({
    page,
  }) => {
    await start(page);
    await openAsk(page);
    await button(panel(page), "Preview").click();
    await expect(panel(page).getByRole("alert")).toHaveText("Type a question first.");
    await expect(previewRegion(page)).toHaveCount(0);
  });
});

test.describe("the answer", () => {
  test("arrives in pieces and is drawn as Markdown, and HTML in it stays text", async ({
    page,
  }) => {
    await start(page);
    await setReply(
      page,
      [
        "## Plan",
        "",
        "Use **strong** and *soft* words with `inline` code.",
        "",
        "1. First <b>not bold</b>",
        "2. Second",
        "",
        "- a bullet",
        "",
        "<script>window.__pwned = 1</script>",
      ].join("\n"),
    );
    await openAsk(page);
    await hold(page, true);
    await previewQuestion(page, "show me");
    await button(previewRegion(page), "Send").click();
    // Held after its first piece: part of the answer is on screen while it is still streaming.
    await expect(exchange(page, "streaming")).toHaveCount(1);
    await expect(exchange(page, "streaming")).toContainText("##");
    await hold(page, false);
    await expect(exchange(page, "done")).toHaveCount(1);

    const answer = panel(page).locator('[data-nr-part="ask-answer"]');
    await expect(answer.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
    await expect(answer.locator("strong")).toHaveText("strong");
    await expect(answer.locator("em")).toHaveText("soft");
    await expect(answer.locator("p code")).toHaveText("inline");
    await expect(answer.locator("ol > li")).toHaveCount(2);
    await expect(answer.locator("ul > li")).toHaveText(["a bullet"]);
    // The tags are the text they are, not elements.
    await expect(answer.locator("ol > li").first()).toHaveText("First <b>not bold</b>");
    await expect(answer.locator("b")).toHaveCount(0);
    await expect(answer.locator("script")).toHaveCount(0);
    await expect(answer).toContainText("<script>window.__pwned = 1</script>");
    expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
  });

  test("Stop ends the answer in the middle, keeps what had come and says it was stopped", async ({
    page,
  }) => {
    await start(page);
    await setReply(page, "one two three four five six");
    await hold(page, true);
    await openAsk(page);
    await previewQuestion(page, "count to six");
    await button(previewRegion(page), "Send").click();
    const answerOf = (state: string) =>
      exchange(page, state).locator('[data-nr-part="ask-answer"]');
    await expect(answerOf("streaming")).toContainText("one");
    // While it streams the question box is closed and Stop takes the place of Preview.
    await expect(questionBox(page)).toBeDisabled();
    await expect(button(panel(page), "Preview")).toHaveCount(0);
    expect(await cancels(page)).toEqual([]);

    await button(panel(page), "Stop").click();
    await expect(exchange(page, "stopped")).toHaveCount(1);
    await expect(exchange(page, "stopped").locator('[data-nr-part="ask-status"]')).toHaveText(
      "Stopped.",
    );
    const requestId = (await cancels(page))[0] ?? "";
    expect(requestId).toMatch(/^ask-[a-z0-9]+-\d+$/);
    // What had come stays, and not the rest.
    await expect(answerOf("stopped")).toContainText("one");
    await expect(answerOf("stopped")).not.toContainText("six");
    // The panel is ready for the next question.
    await expect(questionBox(page)).toBeEnabled();
    await expect(button(panel(page), "Preview")).toBeVisible();
    await hold(page, false);
  });

  test("a provider that cannot answer is an alert in the answer, not a silent end", async ({
    page,
  }) => {
    // Ollama is named for Ask but is not running on this fake computer.
    await start(page, { ollama: null });
    await openAsk(page);
    await previewQuestion(page, "hello?");
    await send(page, "failed");
    await expect(exchange(page, "failed").getByRole("alert")).toHaveText(
      "could not reach the provider: connection refused",
    );
    await expect(questionBox(page)).toBeEnabled();
  });

  test("with nobody named, the first model of the Ollama of the computer answers", async ({
    page,
  }) => {
    await start(page, { file: FILE_UNNAMED, ollama: ["qwen2", "llama3"] });
    await openAsk(page);
    await expect(panel(page).locator('[data-nr-part="ask-target"]')).toHaveText("Ollama · qwen2");
    await previewQuestion(page, "hi");
    await send(page);
    expect((await chats(page))[0]).toMatchObject({ providerId: "ollama", model: "qwen2" });
  });

  test("with nobody to answer, the panel shows the steps and no way to ask", async ({ page }) => {
    await start(page, { file: FILE_UNNAMED, ollama: null });
    await page.keyboard.press("Control+Shift+A");
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator('[data-nr-part="ask-target"]')).toHaveText("No provider");
    await expect(panel(page).locator('[data-nr-part="ask-steps"]')).toContainText("Install Ollama");
    await expect(questionBox(page)).toHaveCount(0);
    await expect(button(panel(page), "Preview")).toHaveCount(0);
    expect(await chats(page)).toHaveLength(0);
  });
});

test.describe("Insert in terminal", () => {
  const REPLY = "Try this:\n\n```sh\nls -la\n```\n\nThen look at the result.";

  test("writes the block at the prompt without Enter, and nothing runs", async ({ page }) => {
    await start(page);
    await setReply(page, REPLY);
    await openAsk(page);
    await previewQuestion(page, "list the files");
    await send(page);

    const before = (await writes(page)).length;
    const commands = await doneCommands(page);
    const insert = button(panel(page), "Insert in terminal");
    await expect(insert).toBeEnabled();
    await insert.click();

    // Exactly the text of the block was written: no \r, no \n, nothing else.
    await expect.poll(async () => (await writes(page)).length).toBe(before + 1);
    const written = (await writes(page)).slice(before);
    expect(written.map((write) => write.data)).toEqual(["ls -la"]);
    expect(written[0]?.data).not.toMatch(/[\r\n]/);
    // It sits at the prompt, not run: no command ended, and no output of `ls` came.
    await expect
      .poll(async () => (await lines(page)).some((l) => l.trim() === "fake$ ls -la"))
      .toBe(true);
    expect(await doneCommands(page)).toBe(commands);
    expect((await lines(page)).some((l) => l.includes("README.md"))).toBe(false);
    // The terminal has the keyboard back, so Enter would be the person's.
    await expect(terminalFocused(page)).toHaveCount(1);
    await expect(panel(page).locator('[data-nr-part="ask-note"]')).toHaveText(
      "Put at the prompt. It runs only when you press Enter in the terminal.",
    );
  });

  test("a block of several lines asks first, writes nothing if the person says no, and never ends in Enter", async ({
    page,
  }) => {
    await start(page);
    await setReply(page, "Do this:\n\n```sh\ncd /tmp\nls\n```\n");
    await openAsk(page);
    await previewQuestion(page, "two steps");
    await send(page);

    const before = (await writes(page)).length;
    await button(panel(page), "Insert in terminal").click();
    const dialog = page.getByRole("dialog", { name: "Paste 2 lines?", exact: true });
    await expect(dialog).toBeVisible();
    expect((await writes(page)).length).toBe(before);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await writes(page)).length).toBe(before);
    expect(await doneCommands(page)).toBe(0);

    // Said yes, it is the same paste as any other: the lines go in, and the last one has no Enter.
    await button(panel(page), "Insert in terminal").click();
    await dialog.getByRole("button", { name: "Paste", exact: true }).click();
    await expect.poll(async () => (await writes(page)).length).toBe(before + 1);
    const pasted = (await writes(page)).at(-1)?.data ?? "";
    expect(pasted).toBe("cd /tmp\rls");
    expect(pasted).not.toMatch(/[\r\n]$/);
    // The last line waits at the prompt.
    await expect
      .poll(async () => (await lines(page)).some((l) => l.trim() === "fake$ ls"))
      .toBe(true);
  });

  test("takes the control characters out of the text, and puts nothing for an empty block", async ({
    page,
  }) => {
    await start(page);
    await setReply(page, "```\nls\u001b[2J\u0003\u0004 -l\n```\n\n```\n   \n```\n");
    await openAsk(page);
    await previewQuestion(page, "tricky");
    await send(page);

    const inserts = button(panel(page), "Insert in terminal");
    await expect(inserts).toHaveCount(2);
    // The block with only blanks has nothing to insert.
    await expect(inserts.nth(1)).toBeDisabled();
    const before = (await writes(page)).length;
    await inserts.first().click();
    await expect.poll(async () => (await writes(page)).length).toBe(before + 1);
    expect((await writes(page)).at(-1)?.data).toBe("ls[2J -l");
  });

  test("waits for the whole answer: a block still arriving cannot be inserted", async ({
    page,
  }) => {
    await start(page);
    await setReply(page, "```sh\necho start\necho end\n```");
    await hold(page, true);
    await openAsk(page);
    await previewQuestion(page, "slow");
    await button(previewRegion(page), "Send").click();
    // The block has begun and is not closed: its button waits for the rest.
    await expect(exchange(page, "streaming").locator(".md-code")).toBeVisible();
    await expect(button(panel(page), "Insert in terminal")).toBeDisabled();
    await hold(page, false);
    await expect(exchange(page, "done")).toHaveCount(1);
    await expect(button(panel(page), "Insert in terminal")).toBeEnabled();
  });
});

test.describe("where the AI is off", () => {
  const switcher = (page: Page) => page.getByRole("navigation", { name: "Spaces", exact: true });
  const menu = (page: Page) => page.getByRole("menu", { name: "Main options", exact: true });
  const aiItem = (page: Page) =>
    menu(page).getByRole("menuitemcheckbox", { name: /^(✓ )?AI in this space$/ });
  const askEntry = (page: Page) => page.getByRole("option", { name: /Ask the AI/ });

  async function paletteAsk(page: Page): Promise<Locator> {
    await openCommandPalette(page);
    const box = page.getByRole("combobox", { name: "Command palette", exact: true });
    await box.fill("> ask the ai");
    return box;
  }

  test("turned off for the space, the open panel goes away and nothing calls the provider", async ({
    page,
  }) => {
    await start(page);
    await openAsk(page);
    await previewQuestion(page, "before it goes off");
    await send(page);
    expect(await chats(page)).toHaveLength(1);

    await switcher(page).getByRole("button", { name: "Main", exact: true }).click({
      button: "right",
    });
    await aiItem(page).click();
    await expect(aiItem(page)).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);

    // The key says why it does nothing; the panel does not come back, and nobody is asked.
    await page.locator('[data-nr-part="pane"]:visible').click();
    await page.keyboard.press("Control+Shift+A");
    await expect(notice(page)).toHaveText(
      "The AI is off for this space. Turn it on in the space menu.",
    );
    await expect(panel(page)).toHaveCount(0);
    // The palette does not offer it.
    const box = await paletteAsk(page);
    await expect(askEntry(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(box).toBeHidden();
    expect(await chats(page)).toHaveLength(1);

    // On again, the key works again.
    await switcher(page).getByRole("button", { name: "Main", exact: true }).click({
      button: "right",
    });
    await aiItem(page).click();
    await expect(aiItem(page)).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.locator('[data-nr-part="pane"]:visible').click();
    await openAsk(page);
  });

  test("off in the settings, the key says so, the palette has no entry, and no panel opens", async ({
    page,
  }) => {
    await start(page, { file: FILE_OFF });
    await page.keyboard.press("Control+Shift+A");
    await expect(notice(page)).toHaveText(
      "The AI is off. Turn it on in Settings, in the AI section.",
    );
    await expect(panel(page)).toHaveCount(0);
    const box = await paletteAsk(page);
    await expect(askEntry(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(box).toBeHidden();
    expect(await chats(page)).toHaveLength(0);
  });

  test("a space where the AI is off has no panel even when another space had it open", async ({
    page,
  }) => {
    await start(page);
    await openAsk(page);
    // A new space has the AI on; turn it off there, then come back to Main.
    await page.getByRole("button", { name: "New space", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New space", exact: true });
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Quiet");
    await dialog.getByRole("button", { name: "Create space", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await switcher(page).getByRole("button", { name: "Quiet", exact: true }).click({
      button: "right",
    });
    await page
      .getByRole("menu", { name: "Quiet options", exact: true })
      .getByRole("menuitemcheckbox", { name: /^(✓ )?AI in this space$/ })
      .click();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await page.locator('[data-nr-part="pane"]:visible').click();
    await page.keyboard.press("Control+Shift+A");
    await expect(panel(page)).toHaveCount(0);
    await expect(notice(page)).toHaveText(
      "The AI is off for this space. Turn it on in the space menu.",
    );

    // Back in Main, where the AI is on, the key opens the panel as it always did.
    await switcher(page).getByRole("button", { name: "Main", exact: true }).click();
    await expect(panel(page)).toHaveCount(0);
    await page.locator('[data-nr-part="pane"]:visible').click();
    await openAsk(page);
    expect(await chats(page)).toHaveLength(0);
  });
});

test.describe("opening, closing and the shortcut", () => {
  test("Ctrl+Shift+A opens and closes it, the close button and Escape too, and the terminal gets the keyboard back", async ({
    page,
  }) => {
    await start(page);
    await expect(panel(page)).toHaveCount(0);
    await openAsk(page);
    await page.keyboard.press("Control+Shift+A");
    await expect(panel(page)).toHaveCount(0);
    await expect(terminalFocused(page)).toHaveCount(1);

    await openAsk(page);
    await button(panel(page), "Close Ask").click();
    await expect(panel(page)).toHaveCount(0);
    await expect(terminalFocused(page)).toHaveCount(1);

    await openAsk(page);
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(terminalFocused(page)).toHaveCount(1);
  });

  test("the palette lists Ask the AI with its key and opens the panel", async ({ page }) => {
    await start(page);
    await openCommandPalette(page);
    const box = page.getByRole("combobox", { name: "Command palette", exact: true });
    await box.fill("> ask the ai");
    const entry = page.getByRole("option", { name: /Ask the AI/ });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("Ctrl+Shift+A");
    await page.keyboard.press("Enter");
    await expect(box).toBeHidden();
    await expect(panel(page)).toBeVisible();
    await expect(questionBox(page)).toBeFocused();
  });

  test("closing the panel while an answer is coming cancels it", async ({ page }) => {
    await start(page);
    await setReply(page, "one two three");
    await hold(page, true);
    await openAsk(page);
    await previewQuestion(page, "slow one");
    await button(previewRegion(page), "Send").click();
    await expect(exchange(page, "streaming")).toHaveCount(1);
    await button(panel(page), "Close Ask").click();
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(() => cancels(page).then((ids) => ids.length)).toBe(1);
    await hold(page, false);
  });

  test("is listed in the shortcuts screen and can be recorded anew", async ({ page }) => {
    await start(page);
    const screen = await openShortcutsScreen(page);
    await expect(screen.getByLabel("Shortcut for Ask the AI", { exact: true })).toHaveText(
      "Ctrl+Shift+A",
    );
    await screen.getByRole("button", { name: "Record shortcut for Ask the AI" }).click();
    await page.keyboard.press("Control+Alt+K");
    await expect(screen.getByLabel("Shortcut for Ask the AI", { exact: true })).toHaveText(
      "Ctrl+Alt+K",
    );
    await closeShortcutsScreen(page);

    await page.locator('[data-nr-part="pane"]:visible').click();
    // The old chord is the terminal's again; the new one opens the panel.
    await page.keyboard.press("Control+Shift+A");
    await expect(panel(page)).toHaveCount(0);
    await page.keyboard.press("Control+Alt+K");
    await expect(panel(page)).toBeVisible();
  });
});

test.describe("accessibility", () => {
  test("axe: the panel open and empty, with the chips and the question, has no violation", async ({
    page,
  }) => {
    await start(page);
    await openAsk(page);
    await expectNoAxeViolations(page, "Ask panel, empty");
    await button(panel(page), "@ Tab").click();
    await expect(
      panel(page).getByRole("group", { name: "Tabs to add", exact: true }),
    ).toBeVisible();
    await expectNoAxeViolations(page, "Ask panel, with the list of tabs to add");
  });

  test("axe: the preview, the answer drawn as Markdown with a code block and the failure have no violation", async ({
    page,
  }) => {
    await start(page);
    await say(page, "needle-beta");
    await setReply(
      page,
      "## Plan\n\nUse **strong** and `inline`.\n\n1. First\n2. Second\n\n- a bullet\n\n```sh\nls -la\n```\n",
    );
    await openAsk(page);
    await button(panel(page), "Last output").click();
    await previewQuestion(page, "show me");
    await expectNoAxeViolations(page, "Ask panel, preview");
    await send(page);
    await expect(
      panel(page).locator('[data-nr-part="ask-answer"]').getByRole("heading", { name: "Plan" }),
    ).toBeVisible();
    await expectNoAxeViolations(page, "Ask panel, answer");
  });

  test("axe: a provider that cannot answer and a panel with nobody to ask have no violation", async ({
    page,
  }) => {
    await start(page, { ollama: null });
    await openAsk(page);
    await previewQuestion(page, "hello?");
    await send(page, "failed");
    await expect(exchange(page, "failed").getByRole("alert")).toBeVisible();
    await expectNoAxeViolations(page, "Ask panel, failure");
  });

  test("axe: the panel with no provider, only the steps, has no violation", async ({ page }) => {
    await start(page, { file: FILE_UNNAMED, ollama: null });
    await page.keyboard.press("Control+Shift+A");
    await expect(panel(page).locator('[data-nr-part="ask-steps"]')).toBeVisible();
    await expectNoAxeViolations(page, "Ask panel, no provider");
  });
});
