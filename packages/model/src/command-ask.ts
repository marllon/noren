import { aiIsOn } from "./ai";
import type { AiChatMessage } from "./ai";
import { previewOfMessages } from "./ask-context";
import { redactSecrets } from "./redact";
import type { Redaction, RedactionKind } from "./redact";

// "? text" in the palette: the person says what they want in words and the AI answers with one
// command for the shell and the system of the pane. Two pure pieces: the message that goes out (the
// request with the shell and the system, redacted, and the exact preview of it) and the command
// taken out of the answer, which is one line and never holds a line break, so putting it at the
// prompt cannot press Enter. Nothing here runs anything and nothing throws.

/** The longest request. A longer one is refused, not cut: the person would not see what was dropped. */
export const MAX_COMMAND_REQUEST_CHARS = 1000;

/** The longest command that is taken from an answer. A longer one is refused. */
export const MAX_COMMAND_CHARS = 1000;

/** The longest name of a shell or a system. */
const MAX_LABEL_CHARS = 60;

/** The instructions that open every request, with the shell and the system the command is for. */
export function commandSystemPrompt(shell: string, os: string): string {
  return [
    "You are the assistant inside Noren, a terminal. The person describes what they want to do and you answer with one command for their shell.",
    `The shell is ${shell} and the system is ${os}; write the command for them.`,
    "Answer with the command alone, on one line, in one fenced code block. Do not explain it and do not add any other text.",
    "You cannot run anything: the person reads the command and decides whether to run it.",
  ].join("\n");
}

export interface CommandAskInput {
  /** The settings (`ai.enabled`) and the space the request is made in (`aiEnabled`): the AI has to be on in both. */
  settings: { ai?: { enabled?: boolean | undefined } | undefined };
  space: { aiEnabled: boolean };
  /** What the person wants, in their words (the text after the `?`). */
  request: string;
  /** The name of the shell of the pane, such as `PowerShell`. */
  shell: string;
  /** The system the pane runs on, such as `Windows`. */
  os: string;
}

export type CommandAskRefusal =
  /** The AI is off in the settings or for this space: nothing is built and nothing may be sent. */
  "ai-off" | "empty-request" | "request-too-long";

export type CommandAskMessage =
  | {
      ok: true;
      /** What is sent, exactly: the instructions, then the request. */
      messages: AiChatMessage[];
      /** `messages` written out for the person to read: the same text, role by role, nothing else. */
      preview: string;
      /** How many secrets were swapped for markers, in all of it. */
      redactions: number;
      /** The kinds of secret that were found. */
      redactionKinds: RedactionKind[];
    }
  | { ok: false; reason: CommandAskRefusal };

/** A name on one line, at most `MAX_LABEL_CHARS` characters; `fallback` when nothing is left. */
function label(text: string, fallback: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  if (chars.length === 0) return fallback;
  return chars.length > MAX_LABEL_CHARS ? `${chars.slice(0, MAX_LABEL_CHARS).join("")}…` : flat;
}

/**
 * Builds the messages of a request for a command: the instructions (with the shell and the system)
 * and the request, every text through `redactSecrets`. Refuses, building nothing, when the AI is off
 * for the space (`aiIsOn`), the request is blank, or it is longer than `MAX_COMMAND_REQUEST_CHARS`.
 * `preview` is what the person reads before anything is sent and is the messages themselves.
 */
export function buildCommandMessages(input: CommandAskInput): CommandAskMessage {
  if (!aiIsOn(input.settings, input.space)) return { ok: false, reason: "ai-off" };

  const request = redactSecrets(input.request.trim());
  if (request.text === "") return { ok: false, reason: "empty-request" };
  if ([...request.text].length > MAX_COMMAND_REQUEST_CHARS) {
    return { ok: false, reason: "request-too-long" };
  }

  const shell = redactSecrets(label(input.shell, "the shell"));
  const os = redactSecrets(label(input.os, "this system"));
  const found: Redaction[] = [request, shell, os];
  const messages: AiChatMessage[] = [
    { role: "system", content: commandSystemPrompt(shell.text, os.text) },
    { role: "user", content: request.text },
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
  };
}

export type ExtractedCommand =
  | {
      ok: true;
      /** The command: one line, with no line break and no control character in it. */
      command: string;
      /** The answer had more lines in the block (or after the line) than the one that was taken. */
      moreLines: boolean;
    }
  | { ok: false; reason: "empty" | "too-long" };

/** A fence of at least three backticks or tildes, with an optional language, alone on its line. */
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*$/;

/** A control character (C0, DEL, C1) or a Unicode line or paragraph separator: nothing that can end a line or press a key. */
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** A line of the answer made safe to put at a prompt: tabs are blanks, other controls go, edges trimmed. */
function clean(line: string): string {
  return [...line.replace(/\t/g, " ")]
    .filter((char) => !isControl(char.codePointAt(0) ?? 0))
    .join("")
    .trim();
}

/** The text of the first fenced block of `lines` (an unclosed one runs to the end), or `undefined` when there is none. */
function firstFenced(lines: readonly string[]): string[] | undefined {
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i] ?? "");
    const fence = open?.[1];
    if (fence === undefined) continue;
    const mark = fence.charAt(0);
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      const close = new RegExp(`^[ \\t]{0,3}\\${mark}{${fence.length},}[ \\t]*$`).test(line);
      if (close) break;
      body.push(line);
    }
    return body;
  }
  return undefined;
}

/**
 * The command in an answer of the AI: the first non-blank line of the first fenced block, or, when
 * the answer has no block, its first non-blank line (inside one pair of backticks if it came so, and
 * without a leading `$ `). The line has its control characters taken out, so it holds no `\r` and no
 * `\n`; an answer with no command or one that is too long is refused. Pure; it never throws.
 */
export function extractCommand(answer: string): ExtractedCommand {
  const lines = answer.split(/\r\n|\r|\n/);
  const fenced = firstFenced(lines);
  const source = fenced ?? lines;
  const filled = source.map(clean).filter((line) => line !== "");
  let command = filled[0] ?? "";
  if (fenced === undefined) {
    const inline = /^`+([^`]+)`+$/.exec(command);
    if (inline?.[1] !== undefined) command = inline[1].trim();
  }
  if (command.startsWith("$ ")) command = command.slice(2).trim();
  if (command === "") return { ok: false, reason: "empty" };
  if ([...command].length > MAX_COMMAND_CHARS) return { ok: false, reason: "too-long" };
  return { ok: true, command, moreLines: filled.length > 1 };
}

/**
 * The request in the text typed in the palette, when it starts with `?`: what comes after it,
 * trimmed (possibly empty, which is the person still typing). `undefined` for any other query.
 */
export function commandRequestOf(query: string): string | undefined {
  const text = query.trimStart();
  return text.startsWith("?") ? text.slice(1).trim() : undefined;
}
