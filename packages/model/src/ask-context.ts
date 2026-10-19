import { aiIsOn } from "./ai";
import type { AiChatMessage } from "./ai";
import { redactSecrets } from "./redact";
import type { Redaction, RedactionKind } from "./redact";

// The Ask panel's message: the context chips and the question become the messages that go to the
// provider, with the secrets redacted and each chip held to a size. What `buildAskMessages` returns
// is the whole truth about what leaves the computer: the messages, and `preview`, which is those same
// messages written out for the person to read before anything is sent. Pure; it never throws.

/** The most characters of one chip that go out (the text of a chip, after redaction). */
export const MAX_ASK_CHIP_CHARS = 6000;

/** The longest question. A longer one is refused, not cut: the person would not see what was dropped. */
export const MAX_ASK_QUESTION_CHARS = 4000;

/** The longest title of a tab chip. */
const MAX_TAB_TITLE_CHARS = 100;

/** The instructions that open every question. */
export const ASK_SYSTEM_PROMPT = [
  "You are the assistant inside Noren, a terminal. The person asks about their shell and their work.",
  "Context from their terminal may come first, in fenced blocks under headings; use it, and say so when it is not enough.",
  "Parts of it may have been cut, and secrets in it are replaced by [REDACTED:...] markers.",
  "When you suggest a command, put it in a fenced code block. You cannot run anything: the person decides what to run.",
  "Answer in the language of the question, briefly, in Markdown.",
].join("\n");

/**
 * A piece of context the person chose, with the text it stands for already read from its place by
 * the caller: this module only shapes it.
 */
export type AskChip =
  /** The text selected in the terminal. */
  | { kind: "selection"; text: string }
  /** The output of the last command, with the command line when it is known. */
  | { kind: "lastOutput"; text: string; command?: string | undefined }
  /** What is on the screen of the current pane. */
  | { kind: "screen"; text: string }
  /** Another tab (`@tab`): its title and the text of its terminal. */
  | { kind: "tab"; title: string; text: string };

/** Which end of a chip is dropped when it is too long: a selection loses its end, the rest lose their start (what happened last stays). */
export type AskCutFrom = "start" | "end";

/** A chip that was cut to fit: how much of it was left out, and from where. */
export interface AskCut {
  /** The position of the chip in the list given. */
  index: number;
  chip: AskChip["kind"];
  /** The characters left out (after redaction). */
  removed: number;
  /** The end of the chip that was dropped. */
  from: AskCutFrom;
}

export interface AskInput {
  /** The settings (`ai.enabled`) and the space the question is asked in (`aiEnabled`): the AI has to be on in both. */
  settings: { ai?: { enabled?: boolean | undefined } | undefined };
  space: { aiEnabled: boolean };
  question: string;
  /** In the order they will appear in the message. */
  chips: readonly AskChip[];
  /** The most characters of one chip that go out; `MAX_ASK_CHIP_CHARS` unless given. */
  maxChipChars?: number | undefined;
}

export type AskRefusal =
  /** The AI is off in the settings or for this space: nothing is built and nothing may be sent. */
  "ai-off" | "empty-question" | "question-too-long";

export type AskMessage =
  | {
      ok: true;
      /** What is sent, exactly: the system prompt, then the question with its context. */
      messages: AiChatMessage[];
      /** `messages` written out for the person to read: the same text, role by role, nothing else. */
      preview: string;
      /** How many secrets were swapped for markers, in all of it. */
      redactions: number;
      /** The kinds of secret that were found. */
      redactionKinds: RedactionKind[];
      /** The chips that were cut to the size limit. */
      cuts: AskCut[];
    }
  | { ok: false; reason: AskRefusal };

/** The heading of a chip in the message. `title` has already been redacted and put on one line. */
function chipHeading(chip: AskChip, title: string): string {
  switch (chip.kind) {
    case "selection":
      return "Selected text";
    case "lastOutput":
      return "Output of the last command";
    case "screen":
      return "Visible screen";
    case "tab":
      return `Tab: ${title}`;
  }
}

/** A title on one line, at most `MAX_TAB_TITLE_CHARS` characters. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > MAX_TAB_TITLE_CHARS
    ? `${chars.slice(0, MAX_TAB_TITLE_CHARS).join("")}…`
    : flat;
}

/** A fence long enough that nothing inside the text can close it. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** The text of a chip held to `limit` characters, with a line that says what was left out. */
function fit(text: string, limit: number, dropped: AskCutFrom): { text: string; removed: number } {
  const chars = [...text];
  if (chars.length <= limit) return { text, removed: 0 };
  const removed = chars.length - limit;
  if (dropped === "end") {
    return {
      text: `${chars.slice(0, limit).join("")}\n[... ${removed} more characters cut from the end]`,
      removed,
    };
  }
  return {
    text: `[... ${removed} characters cut from the start]\n${chars.slice(removed).join("")}`,
    removed,
  };
}

/** The messages written out for the person: each with its role, the text as it is sent. */
export function previewOfMessages(messages: readonly AiChatMessage[]): string {
  return messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n");
}

/**
 * Builds the messages of a question: the system prompt and one user message that holds the chips
 * in the order given, each under its heading, and then the question. Every text (chips, titles, the
 * question) goes through `redactSecrets`, and a chip longer than the limit is cut (a selection keeps
 * its start, any other chip keeps its end) with a line in the text saying so. Refuses, building
 * nothing, when the AI is off for the space (`aiIsOn`), the question is blank, or it is longer than
 * `MAX_ASK_QUESTION_CHARS`.
 */
export function buildAskMessages(input: AskInput): AskMessage {
  if (!aiIsOn(input.settings, input.space)) return { ok: false, reason: "ai-off" };

  const question = redactSecrets(input.question.trim());
  if (question.text === "") return { ok: false, reason: "empty-question" };
  if ([...question.text].length > MAX_ASK_QUESTION_CHARS) {
    return { ok: false, reason: "question-too-long" };
  }

  const limit = Math.max(1, Math.floor(input.maxChipChars ?? MAX_ASK_CHIP_CHARS));
  const found: Redaction[] = [question];
  const cuts: AskCut[] = [];
  const sections: string[] = [];

  input.chips.forEach((chip, index) => {
    const title = chip.kind === "tab" ? redactSecrets(oneLine(chip.title)) : undefined;
    const body = redactSecrets(chip.text);
    const command =
      chip.kind === "lastOutput" && chip.command !== undefined && chip.command.trim() !== ""
        ? redactSecrets(oneLine(chip.command))
        : undefined;
    for (const part of [title, body, command]) if (part !== undefined) found.push(part);

    const from: AskCutFrom = chip.kind === "selection" ? "end" : "start";
    const fitted = fit(body.text, limit, from);
    if (fitted.removed > 0) cuts.push({ index, chip: chip.kind, removed: fitted.removed, from });

    const lines = [`### ${chipHeading(chip, title?.text ?? "")}`];
    if (command !== undefined) lines.push(`Command: ${command.text}`);
    lines.push(fenced(fitted.text === "" ? "(empty)" : fitted.text));
    sections.push(lines.join("\n"));
  });

  const content =
    sections.length === 0
      ? question.text
      : `## Context\n\n${sections.join("\n\n")}\n\n## Question\n\n${question.text}`;
  const messages: AiChatMessage[] = [
    { role: "system", content: ASK_SYSTEM_PROMPT },
    { role: "user", content },
  ];
  const kinds: RedactionKind[] = [];
  for (const redaction of found) {
    for (const kind of redaction.kinds) if (!kinds.includes(kind)) kinds.push(kind);
  }
  return {
    ok: true,
    messages,
    preview: previewOfMessages(messages),
    redactions: found.reduce((sum, redaction) => sum + redaction.count, 0),
    redactionKinds: kinds,
    cuts,
  };
}
