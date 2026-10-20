import { FakeBackend, createDiffPane, parseGitDiff } from "@noren/model";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { DiffPane, DiffView } from "./DiffPane";
import { MAX_DIFF_ROWS_SHOWN } from "./diff-view";
import type { DiffContent } from "./diff-view";
import { setLanguage } from "./i18n";

// Rendered to markup on the server side of React: what each answer of the backend turns into. The
// read itself, the choice of a file, the refresh button, the reload and the stacking need a page
// with a layout and are in e2e/diff-pane.spec.ts.

const FOLDER = "/work/repo";

afterEach(() => setLanguage("en"));

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@ function a() {",
  " keep",
  "-before",
  "+after",
  " end",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+hello",
  "\\ No newline at end of file",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
  "",
].join("\n");

const files = (text = DIFF): DiffContent => ({ type: "files", files: parseGitDiff(text) });

const view = (
  content: DiffContent,
  options: { selected?: string; expanded?: string; cwd?: string } = {},
): string =>
  renderToStaticMarkup(
    <DiffView
      cwd={options.cwd ?? FOLDER}
      content={content}
      selected={options.selected}
      onSelect={() => undefined}
      onRefresh={() => undefined}
      expanded={options.expanded}
      onExpand={() => undefined}
    />,
  );

describe("a diff pane", () => {
  it("is a group with the folder and the refresh button on top", () => {
    const markup = view(files());
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Git diff"');
    expect(markup).toMatch(/<span class="diff-path"[^>]*title="\/work\/repo"/);
    expect(markup).toMatch(/<button[^>]*class="diff-refresh"[^>]*aria-label="Refresh the diff"/);
    expect(markup.indexOf("diff-head")).toBeLessThan(markup.indexOf("diff-body"));
  });

  it("starts as a note that the changes are being read, with no shell and no read before it is drawn", () => {
    const backend = new FakeBackend({ gitDiffs: { [FOLDER]: DIFF } });
    const markup = renderToStaticMarkup(
      <DiffPane backend={backend} pane={createDiffPane("p1", FOLDER)} visible />,
    );
    expect(markup).toContain("Reading the changes…");
    expect(markup).toContain('data-nr-kind="loading"');
    expect(backend.callsTo("createSession")).toEqual([]);
    expect(backend.callsTo("readGitDiff")).toEqual([]);
  });

  it("lists every changed file with its letter, its name and its counts", () => {
    const markup = view(files());
    const buttons = [...markup.matchAll(/<button[^>]*data-nr-part="diff-file"[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toContain('data-nr-status="modified"');
    expect(buttons[0]).toContain('data-nr-path="src/a.ts"');
    expect(buttons[1]).toContain('data-nr-status="added"');
    expect(markup).toContain(">+1 −1<");
    expect(markup).toContain(">+1 −0<");
    // A screen reader hears what the letter and the counts mean.
    expect(markup).toContain("Modified: ");
    expect(markup).toContain("1 added, 1 removed");
    expect(markup).toContain('<ul class="diff-files"');
    expect(markup).toContain('aria-label="Changed files"');
  });

  it("marks the first file as current when none is picked, and the picked one when one is", () => {
    const first = view(files());
    expect(first).toMatch(
      /aria-current="true"[^>]*data-nr-status="modified"|data-nr-status="modified"[^>]*aria-current="true"/,
    );
    const second = view(files(), { selected: "new.txt" });
    const current = [...second.matchAll(/<button[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes('aria-current="true"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('data-nr-path="new.txt"');
    // A key that names no file falls back to the first.
    expect(view(files(), { selected: "gone.txt" })).toContain('aria-label="Changes in src/a.ts"');
  });

  it("sets the old file on the left and the new one on the right, in a table with headings", () => {
    const markup = view(files());
    expect(markup).toContain('<table class="diff-table"');
    expect(markup).toContain('<caption class="sr-only">Changes in src/a.ts</caption>');
    expect(markup).toMatch(
      /<th scope="col" colSpan="2">Last commit<\/th>|<th scope="col" colspan="2">Last commit<\/th>/,
    );
    expect(markup).toContain("Working tree");
    expect(markup).toContain("@@ -1,3 +1,3 @@ function a() {");
    const rows = [...markup.matchAll(/<tr class="diff-row"[^>]*data-nr-row="(\w+)"/g)].map(
      (match) => match[1],
    );
    expect(rows).toEqual(["context", "change", "context"]);
    // The deleted line is on the old side and the added one on the new side of the same row.
    expect(markup).toMatch(/data-nr-side="old" data-nr-kind="del"[^>]*>.*?before/);
    expect(markup).toMatch(/data-nr-side="new" data-nr-kind="add"[^>]*>.*?after/);
  });

  it("draws the other file when it is picked, and says when a file ends with no line break", () => {
    const markup = view(files(), { selected: "new.txt" });
    expect(markup).toContain("hello");
    expect(markup).toContain("no newline at end of file");
    expect(markup).toContain("Added");
    expect(markup).not.toContain("before");
    // The old side of an added line is empty.
    expect(markup).toContain('data-nr-side="old" data-nr-kind="empty"');
  });

  it("says a binary file has no lines to show", () => {
    const markup = view(files(), { selected: "logo.png" });
    expect(markup).toContain("Git does not show the lines of a binary file.");
    expect(markup).not.toContain("<table");
    expect(markup).toContain(">binary<");
  });

  it("draws the path of a renamed file with the name it had", () => {
    const text = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
      "",
    ].join("\n");
    const markup = view(files(text));
    expect(markup).toContain("old.txt → new.txt");
    expect(markup).toContain("100% alike");
    expect(markup).toContain("The content did not change.");
  });

  it("draws the text of a file as text, whatever it holds", () => {
    const text = [
      "diff --git a/x.html b/x.html",
      "--- a/x.html",
      "+++ b/x.html",
      "@@ -1 +1 @@",
      "-<img src=x onerror=alert(1)>",
      "+<script>alert(2)</script>",
      "",
    ].join("\n");
    const markup = view(files(text));
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  it("makes the region of the lines reachable by the keyboard, since it scrolls", () => {
    const markup = view(files());
    expect(markup).toMatch(/<div class="diff-file"[^>]*tabindex="0"/);
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Changes in src/a.ts"');
  });

  it("shows no more than the cap of rows of a file and offers the rest", () => {
    const lines = Array.from({ length: MAX_DIFF_ROWS_SHOWN + 500 }, (_, n) => `+line ${n}`);
    const text = [
      "diff --git a/big.txt b/big.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/big.txt",
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines,
      "",
    ].join("\n");
    const markup = view(files(text));
    const rows = markup.match(/data-nr-row="change"/g) ?? [];
    // The hunk row counts toward the cap.
    expect(rows).toHaveLength(MAX_DIFF_ROWS_SHOWN - 1);
    expect(markup).toContain(
      `Showing the first ${MAX_DIFF_ROWS_SHOWN} of ${lines.length + 1} rows.`,
    );
    expect(markup).toContain("Show all rows");
    const all = view(files(text), { expanded: "big.txt" });
    expect(all.match(/data-nr-row="change"/g)).toHaveLength(lines.length);
    expect(all).not.toContain("Show all rows");
  });

  it("says nothing changed, and that files git does not track are not listed", () => {
    const markup = view({ type: "clean" });
    expect(markup).toContain("No changes");
    expect(markup).toContain("Files git does not track yet are not listed.");
    expect(markup).not.toContain("<table");
    expect(markup).toContain('data-nr-kind="clean"');
  });

  it("says why there is no diff, as an alert, and keeps the folder and the refresh button", () => {
    const markup = view({
      type: "refused",
      reason: "not-a-repository",
      message: "This folder is not in a git repository.",
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-nr-reason="not-a-repository"');
    expect(markup).toContain("This folder is not in a git repository.");
    expect(markup).toContain("diff-refresh");
    expect(markup).toContain(FOLDER);
    const failed = view({ type: "failed", message: "The diff could not be read: boom" });
    expect(failed).toContain('data-nr-reason="failed"');
  });

  it("speaks Portuguese when the language says so", () => {
    setLanguage("pt-BR");
    const markup = view(files());
    expect(markup).toContain('aria-label="Diff do git"');
    expect(markup).toContain("Atualizar o diff");
    expect(markup).toContain("Arquivos alterados");
    expect(markup).toContain("Último commit");
    expect(markup).toContain("Árvore de trabalho");
    expect(markup).toContain("Modificado: ");
  });
});
