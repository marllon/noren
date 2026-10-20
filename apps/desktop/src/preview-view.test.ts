import { FakeBackend, MAX_PREVIEW_IMAGE_BYTES, MAX_PREVIEW_TEXT_BYTES } from "@noren/model";
import type { FilePreview } from "@noren/model";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "./i18n";
import { contentOf, formatBytes, loadPreview, previewTitle, refusalText } from "./preview-view";
import type { PreviewState } from "./preview-view";

afterEach(() => setLanguage("en"));

const ready = (preview: FilePreview): PreviewState => ({ status: "ready", preview });

describe("loadPreview", () => {
  it("answers with what the backend read, a refusal included", async () => {
    const backend = new FakeBackend({ files: { "/a/x.txt": new TextEncoder().encode("hi") } });
    expect(await loadPreview(backend, "/a/x.txt")).toEqual({
      status: "ready",
      preview: { kind: "text", text: "hi" },
    });
    expect(await loadPreview(backend, "/a/none.txt")).toEqual({
      status: "ready",
      preview: { kind: "refused", reason: "missing" },
    });
  });

  it("turns a failure of the shell into a state instead of throwing", async () => {
    const reader = { readFilePreview: () => Promise.reject(new Error("the shell is gone")) };
    expect(await loadPreview(reader, "/a/x.txt")).toEqual({
      status: "failed",
      reason: "the shell is gone",
    });
    const odd = { readFilePreview: () => Promise.reject("nope") };
    expect(await loadPreview(odd, "/a/x.txt")).toEqual({ status: "failed", reason: "nope" });
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [320, "320 B"],
    [1023, "1023 B"],
    [1024, "1 KiB"],
    [1025, "1.1 KiB"],
    [1536, "1.5 KiB"],
    [MAX_PREVIEW_TEXT_BYTES, "1 MiB"],
    [MAX_PREVIEW_TEXT_BYTES + 1, "1.1 MiB"],
    [MAX_PREVIEW_TEXT_BYTES * 2.5, "2.5 MiB"],
    [MAX_PREVIEW_IMAGE_BYTES, "10 MiB"],
  ])("writes %d as %s", (size, text) => {
    expect(formatBytes(size)).toBe(text);
  });
});

describe("what the pane draws", () => {
  it("is a note while the file is being read", () => {
    expect(contentOf({ status: "loading" })).toEqual({ type: "loading" });
  });

  it("is markdown as it came, and plain text as it came", () => {
    expect(contentOf(ready({ kind: "markdown", text: "# Hi" }))).toEqual({
      type: "markdown",
      text: "# Hi",
    });
    expect(contentOf(ready({ kind: "text", text: "line one\nline two" }))).toEqual({
      type: "text",
      text: "line one\nline two",
    });
  });

  it("is a picture, with the kind its bytes said", () => {
    expect(
      contentOf(ready({ kind: "image", mime: "image/webp", bytes: new Uint8Array(3) })),
    ).toEqual({ type: "image", mime: "image/webp" });
  });

  it("writes valid JSON out with an indent and no warning", () => {
    expect(contentOf(ready({ kind: "json", text: '{"a":[1,2],"b":{}}' }))).toEqual({
      type: "text",
      text: '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {}\n}',
    });
  });

  it("shows JSON that is not valid as it is, with a warning in the language in force", () => {
    const broken = '{"a": 1,}';
    expect(contentOf(ready({ kind: "json", text: broken }))).toEqual({
      type: "text",
      text: broken,
      warning: "This file is not valid JSON. It is shown as plain text.",
    });
    setLanguage("pt-BR");
    expect(contentOf(ready({ kind: "json", text: broken }))).toMatchObject({
      warning: "Este arquivo não é um JSON válido. Ele está sendo mostrado como texto simples.",
    });
  });

  it("says an empty file is empty, of any kind of text", () => {
    for (const kind of ["markdown", "json", "text"] as const) {
      expect(contentOf(ready({ kind, text: "" }))).toEqual({ type: "empty" });
    }
    expect(contentOf(ready({ kind: "json", text: " \n " }))).toEqual({ type: "empty" });
  });

  it("gives the reason a file is refused, in words", () => {
    expect(contentOf(ready({ kind: "refused", reason: "missing" }))).toEqual({
      type: "refused",
      reason: "missing",
      message: "There is no file at this path.",
    });
  });

  it("gives the failure of the shell with its reason", () => {
    expect(contentOf({ status: "failed", reason: "boom" })).toEqual({
      type: "failed",
      message: "The file could not be read: boom",
    });
  });
});

describe("the reasons a file is refused", () => {
  const reasons: [Extract<FilePreview, { kind: "refused" }>, string, string][] = [
    [
      { kind: "refused", reason: "relative" },
      "The path is not a full path to a file on this computer.",
      "O caminho não é um caminho completo de um arquivo neste computador.",
    ],
    [
      { kind: "refused", reason: "network" },
      "Network and device paths are not previewed.",
      "Caminhos de rede e de dispositivo não têm prévia.",
    ],
    [
      { kind: "refused", reason: "invalid" },
      "The path is empty, too long or has a control character.",
      "O caminho está vazio, é longo demais ou tem um caractere de controle.",
    ],
    [
      { kind: "refused", reason: "directory" },
      "This is a folder, not a file.",
      "Isto é uma pasta, não um arquivo.",
    ],
    [
      { kind: "refused", reason: "missing" },
      "There is no file at this path.",
      "Não há arquivo neste caminho.",
    ],
    [
      { kind: "refused", reason: "binary" },
      "This looks like a binary file, so it is not previewed.",
      "Parece um arquivo binário, por isso não tem prévia.",
    ],
    [
      { kind: "refused", reason: "too-large", size: 3 * 1024 * 1024 },
      "This file is 3 MiB. A preview shows text up to 1 MiB and pictures up to 10 MiB.",
      "Este arquivo tem 3 MiB. A prévia mostra texto até 1 MiB e imagens até 10 MiB.",
    ],
    [
      { kind: "refused", reason: "too-large" },
      "This file is too large to preview. A preview shows text up to 1 MiB and pictures up to 10 MiB.",
      "Este arquivo é grande demais para a prévia. Ela mostra texto até 1 MiB e imagens até 10 MiB.",
    ],
    [
      { kind: "refused", reason: "unreadable", detail: "Access is denied." },
      "The file could not be read: Access is denied.",
      "Não foi possível ler o arquivo: Access is denied.",
    ],
    [
      { kind: "refused", reason: "unreadable" },
      "The file could not be read.",
      "Não foi possível ler o arquivo.",
    ],
  ];

  it.each(reasons)("says %j in English and in Portuguese", (refusal, english, portuguese) => {
    expect(refusalText(refusal)).toBe(english);
    setLanguage("pt-BR");
    expect(refusalText(refusal)).toBe(portuguese);
  });
});

describe("the title of a preview pane", () => {
  it("is the name of its file", () => {
    expect(previewTitle("/home/me/notes.md")).toBe("notes.md");
    expect(previewTitle("C:\\Users\\me\\pic.png")).toBe("pic.png");
  });

  it("is a word when there is no path", () => {
    expect(previewTitle(undefined)).toBe("File preview");
    setLanguage("pt-BR");
    expect(previewTitle(undefined)).toBe("Prévia de arquivo");
  });
});
