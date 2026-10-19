import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_COMMAND_CHARS,
  MAX_COMMAND_REQUEST_CHARS,
  buildCommandMessages,
  commandRequestOf,
  commandSystemPrompt,
  extractCommand,
} from "./command-ask";
import type { CommandAskInput, CommandAskMessage } from "./command-ask";

const ON = { settings: { ai: { enabled: true } }, space: { aiEnabled: true } } as const;
// A made-up key, built from pieces so no line of this file looks like a real credential.
const KEY = "AK" + "IA" + "IOSFODNN7EXAMPLE";

function built(request: string, more: Partial<CommandAskInput> = {}) {
  const result = buildCommandMessages({
    ...ON,
    request,
    shell: "PowerShell",
    os: "Windows",
    ...more,
  });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

describe("buildCommandMessages", () => {
  it("is the instructions with the shell and the system, and the request as it was typed", () => {
    const result = built("  list the big files  ");
    expect(result.messages).toEqual([
      { role: "system", content: commandSystemPrompt("PowerShell", "Windows") },
      { role: "user", content: "list the big files" },
    ]);
    expect(result.messages[0]?.content).toContain("PowerShell");
    expect(result.messages[0]?.content).toContain("Windows");
    expect(result.redactions).toBe(0);
  });

  it("asks for the command alone", () => {
    const prompt = commandSystemPrompt("bash", "Linux");
    expect(prompt).toContain("command alone");
    expect(prompt).toContain("one line");
  });

  it("the preview is the messages written out, role by role", () => {
    const result = built("find large files");
    expect(result.preview).toBe(
      `[system]\n${commandSystemPrompt("PowerShell", "Windows")}\n\n[user]\nfind large files`,
    );
  });

  it("swaps secrets for markers and counts them", () => {
    const result = built(`copy to s3 with the key ${KEY}`);
    const text = JSON.stringify(result.messages);
    expect(text).not.toContain(KEY);
    expect(result.redactions).toBeGreaterThan(0);
    expect(result.redactionKinds).toContain("aws-access-key");
    expect(result.preview).not.toContain(KEY);
  });

  it("holds a shell name to one line", () => {
    const result = built("go", { shell: "My\nshell\r\n  name" });
    expect(result.messages[0]?.content).toContain("The shell is My shell name and");
  });

  it("says something when the shell or the system is not known", () => {
    const result = built("go", { shell: "  ", os: "" });
    expect(result.messages[0]?.content).toContain(
      "The shell is the shell and the system is this system;",
    );
  });

  it("refuses when the AI is off in the settings or for the space", () => {
    const refusal = (more: Partial<CommandAskInput>): CommandAskMessage =>
      buildCommandMessages({
        ...ON,
        request: "x",
        shell: "bash",
        os: "Linux",
        ...more,
      });
    expect(refusal({ settings: { ai: { enabled: false } } })).toEqual({
      ok: false,
      reason: "ai-off",
    });
    expect(refusal({ settings: {} })).toEqual({ ok: false, reason: "ai-off" });
    expect(refusal({ space: { aiEnabled: false } })).toEqual({ ok: false, reason: "ai-off" });
  });

  it("refuses a blank request and a request that is too long", () => {
    expect(buildCommandMessages({ ...ON, request: " \n ", shell: "bash", os: "Linux" })).toEqual({
      ok: false,
      reason: "empty-request",
    });
    expect(
      buildCommandMessages({
        ...ON,
        request: "x".repeat(MAX_COMMAND_REQUEST_CHARS + 1),
        shell: "bash",
        os: "Linux",
      }),
    ).toEqual({ ok: false, reason: "request-too-long" });
  });

  it("never throws and a refusal builds nothing (property)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.boolean(), (request, shell, os, on) => {
        const result = buildCommandMessages({
          settings: { ai: { enabled: on } },
          space: { aiEnabled: on },
          request,
          shell,
          os,
        });
        if (!on) expect(result).toEqual({ ok: false, reason: "ai-off" });
        else if (result.ok) {
          expect(result.messages).toHaveLength(2);
          expect(result.preview).toContain(result.messages[1]?.content ?? "");
        }
      }),
    );
  });
});

/** Whether the text holds a control character or a line or paragraph separator. */
const hasControl = (text: string): boolean =>
  [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  });

describe("extractCommand", () => {
  const command = (answer: string): string => {
    const result = extractCommand(answer);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    return result.command;
  };

  it("takes the line of a fenced block", () => {
    expect(command("```powershell\nGet-ChildItem -Recurse\n```")).toBe("Get-ChildItem -Recurse");
  });

  it("prefers the block to the words around it", () => {
    expect(command("Here is the command:\n\n```bash\nls -la\n```\nIt lists everything.")).toBe(
      "ls -la",
    );
  });

  it("takes the first line of the answer when there is no block", () => {
    expect(command("ls -la\nThis lists all the files.")).toBe("ls -la");
    expect(command("\n\n  git status  \n")).toBe("git status");
  });

  it("takes a command written inside backticks, and drops a leading dollar", () => {
    expect(command("`git log --oneline`")).toBe("git log --oneline");
    expect(command("$ ls -la")).toBe("ls -la");
    expect(command("```\n$ ls -la\n```")).toBe("ls -la");
  });

  it("a variable of PowerShell is not a prompt", () => {
    expect(command("$env:PATH")).toBe("$env:PATH");
  });

  it("takes the first non-blank line of a block of several lines, and says there were more", () => {
    const result = extractCommand("```sh\ncd /tmp\nls\n```");
    expect(result).toEqual({ ok: true, command: "cd /tmp", moreLines: true });
    expect(extractCommand("```sh\nls\n```")).toEqual({ ok: true, command: "ls", moreLines: false });
  });

  it("reads a block with a longer fence, a tilde fence, and one that never closed", () => {
    expect(command("````\necho ```hi```\n````")).toBe("echo ```hi```");
    expect(command("~~~\npwd\n~~~")).toBe("pwd");
    expect(command("```bash\nls -la")).toBe("ls -la");
  });

  it("takes out line breaks, tabs and other control characters", () => {
    expect(command("```\nls\t-la\u0007\u001b[31m\n```")).toBe("ls -la[31m");
    expect(command("echo a\r\necho b")).toBe("echo a");
    expect(command("echo a\u2028echo b")).toBe("echo aecho b");
  });

  it("refuses an answer with no command", () => {
    expect(extractCommand("")).toEqual({ ok: false, reason: "empty" });
    expect(extractCommand(" \n\t\n ")).toEqual({ ok: false, reason: "empty" });
    expect(extractCommand("```\n\n```")).toEqual({ ok: false, reason: "empty" });
    expect(extractCommand("```\n```")).toEqual({ ok: false, reason: "empty" });
    expect(extractCommand("\u0007\u0000")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses a command that is too long", () => {
    expect(extractCommand("a".repeat(MAX_COMMAND_CHARS + 1))).toEqual({
      ok: false,
      reason: "too-long",
    });
    expect(extractCommand("a".repeat(MAX_COMMAND_CHARS)).ok).toBe(true);
  });

  it("never throws and never gives a command with a line break or a control character (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (answer) => {
        const result = extractCommand(answer);
        if (result.ok) {
          expect(hasControl(result.command)).toBe(false);
          expect(result.command).not.toBe("");
          expect(result.command).toBe(result.command.trim());
          expect([...result.command].length).toBeLessThanOrEqual(MAX_COMMAND_CHARS);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("a fenced command comes through unchanged whatever it holds (property)", () => {
    const safe = fc
      .string({ minLength: 1, maxLength: 80 })
      .filter((text) => !/[`~]/.test(text) && !hasControl(text))
      .filter((text) => text.trim() !== "" && !text.trim().startsWith("$ "));
    fc.assert(
      fc.property(safe, (text) => {
        expect(command("```\n" + text + "\n```")).toBe(text.trim());
      }),
    );
  });
});

describe("commandRequestOf", () => {
  it("is the text after the question mark, trimmed", () => {
    expect(commandRequestOf("? find big files")).toBe("find big files");
    expect(commandRequestOf("   ?find")).toBe("find");
    expect(commandRequestOf("?")).toBe("");
    expect(commandRequestOf("? ")).toBe("");
  });

  it("is nothing for any other query", () => {
    expect(commandRequestOf("")).toBeUndefined();
    expect(commandRequestOf("find ?")).toBeUndefined();
    expect(commandRequestOf("> ?")).toBeUndefined();
  });
});
