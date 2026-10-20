import { FakeBackend, createPreviewPane } from "@noren/model";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewPane, PreviewView } from "./PreviewPane";
import { setLanguage } from "./i18n";
import type { PreviewContent } from "./preview-view";

// Rendered to markup on the server side of React: what each answer of the backend turns into. The
// read itself, the picture from memory, the reload and the stacking need a page with a layout and
// are in e2e/preview-pane.spec.ts.

const PATH = "/home/me/notes.md";

afterEach(() => setLanguage("en"));

const view = (content: PreviewContent, imageUrl?: string, path: string = PATH): string =>
  renderToStaticMarkup(<PreviewView path={path} content={content} imageUrl={imageUrl} />);

describe("a preview pane", () => {
  it("is a group with the path on top and the contents in a region the keyboard can scroll", () => {
    const markup = view({ type: "text", text: "hello" });
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="File preview"');
    expect(markup).toMatch(/<div class="preview-path"[^>]*title="\/home\/me\/notes.md"/);
    expect(markup).toContain(PATH);
    expect(markup).toMatch(/<div class="preview-body"[^>]*tabindex="0"/);
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Contents of notes.md"');
    // The path comes before the contents.
    expect(markup.indexOf("preview-path")).toBeLessThan(markup.indexOf("preview-body"));
  });

  it("starts as a note that the file is being read, with no shell and no read before it is drawn", () => {
    const backend = new FakeBackend({ files: {} });
    const markup = renderToStaticMarkup(
      <PreviewPane backend={backend} pane={createPreviewPane("p1", PATH)} />,
    );
    expect(markup).toContain("Reading the file…");
    expect(markup).toContain('data-nr-kind="loading"');
    expect(backend.callsTo("createSession")).toEqual([]);
  });

  it("draws plain text in a monospaced block, whatever it holds", () => {
    const markup = view({ type: "text", text: '"><img src=x onerror=alert(1)>\n<b>bold</b>' });
    expect(markup).toContain('<pre class="preview-text"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("&quot;&gt;&lt;img");
  });

  it("warns above JSON that is shown as text", () => {
    const markup = view({ type: "text", text: "{", warning: "Not JSON." });
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Not JSON.");
    expect(markup.indexOf("Not JSON.")).toBeLessThan(markup.indexOf("preview-text"));
    expect(view({ type: "text", text: "{}" })).not.toContain("preview-warning");
  });

  it("draws markdown as elements: headings, lists and code, and no HTML, link or picture", () => {
    const source = [
      "# Title",
      "",
      "Some **bold**, *emphasis* and `code`.",
      "",
      "- one",
      "- two",
      "",
      "```sh",
      "echo hi",
      "```",
      "",
      "![tracker](https://evil.example/pixel.png) [click](https://evil.example) <script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
    ].join("\n");
    const markup = view({ type: "markdown", text: source });
    expect(markup).toContain('data-nr-part="preview-markdown"');
    expect(markup).toContain("<h3>Title</h3>");
    expect(markup).toContain("<strong>bold</strong>");
    expect(markup).toContain("<em>emphasis</em>");
    expect(markup).toContain("<code>code</code>");
    expect(markup).toContain("<li>");
    expect(markup).toContain("echo hi");
    // Nothing of the file became an element that loads or runs.
    expect(markup).not.toMatch(/<img|<script|<a |<iframe|<link|<svg/);
    // No attribute that points anywhere: the address of the "picture" and the "link" are text.
    expect(markup).not.toMatch(/<[a-z][^>]*\s(?:src|href|srcset|style|on\w+)=/);
    expect(markup).toContain("![tracker](https://evil.example/pixel.png)");
    expect(markup).toContain("&lt;script&gt;");
    // The block of code carries no button: nothing here is typed into a terminal.
    expect(markup).not.toContain("<button");
  });

  it("draws a picture from the address in memory, with the name of the file as its alt", () => {
    const markup = view({ type: "image", mime: "image/png" }, "blob:null/1234", "/home/me/pic.png");
    expect(markup).toMatch(/<img[^>]*src="blob:null\/1234"/);
    expect(markup).toContain('alt="pic.png"');
    expect(markup).toContain('draggable="false"');
    // Until the address exists there is no picture and no empty source.
    const waiting = view({ type: "image", mime: "image/png" }, undefined, "/home/me/pic.png");
    expect(waiting).not.toContain("<img");
  });

  it("says why a file is refused, as an alert with the reason on it", () => {
    const markup = view({
      type: "refused",
      reason: "binary",
      message: "This looks like a binary file, so it is not previewed.",
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-nr-reason="binary"');
    expect(markup).toContain("This looks like a binary file, so it is not previewed.");
  });

  it("says an empty file is empty and a failed read failed", () => {
    expect(view({ type: "empty" })).toContain("This file is empty.");
    const failed = view({ type: "failed", message: "The file could not be read: boom" });
    expect(failed).toContain('data-nr-reason="failed"');
    expect(failed).toContain("The file could not be read: boom");
  });

  it("speaks the language in force", () => {
    setLanguage("pt-BR");
    const markup = view({ type: "empty" });
    expect(markup).toContain('aria-label="Prévia de arquivo"');
    expect(markup).toContain('aria-label="Conteúdo de notes.md"');
    expect(markup).toContain("Caminho do arquivo");
    expect(markup).toContain("Este arquivo está vazio.");
  });
});
