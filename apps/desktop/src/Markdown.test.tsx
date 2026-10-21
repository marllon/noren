import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

// The answer of the AI is untrusted text. These tests render it to markup and hold the one promise
// that matters: whatever it says, it comes out as text, never as an element of its own.

const html = (source: string, options: { insert?: boolean; complete?: boolean } = {}): string =>
  renderToStaticMarkup(
    <Markdown
      source={source}
      complete={options.complete ?? true}
      onInsert={options.insert === true ? () => undefined : undefined}
    />,
  );

describe("the elements an answer is drawn with", () => {
  it("draws paragraphs, strong, emphasis and inline code", () => {
    expect(html("a **b** *c* `d`")).toContain(
      "<p>a <strong>b</strong> <em>c</em> <code>d</code></p>",
    );
  });

  it("puts the headings of an answer below the title of the panel, never skipping a level", () => {
    const markup = html("# one\n\n## two\n\n#### four\n\n###### six");
    expect(markup).toContain("<h3>one</h3>");
    expect(markup).toContain("<h4>two</h4>");
    expect(markup).toContain("<h5>four</h5>");
    expect(markup).toContain("<h6>six</h6>");
    expect(markup).not.toContain("<h1");
    expect(markup).not.toContain("<h2");
  });

  it("starts at a level 3 whatever level the answer began with, and steps back by what was written", () => {
    const markup = html("### a\n\n#### b\n\n##### c\n\n### d");
    expect(markup).toContain("<h3>a</h3>");
    expect(markup).toContain("<h4>b</h4>");
    expect(markup).toContain("<h5>c</h5>");
    expect(markup).toContain("<h3>d</h3>");
    expect(html("## only")).toContain("<h3>only</h3>");
  });

  it("draws lists, numbered ones from where they start", () => {
    const markup = html("- a\n- b\n\n3. c\n4. d");
    expect(markup).toContain("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
    expect(markup).toContain('<ol start="3"><li><p>c</p></li><li><p>d</p></li></ol>');
  });

  it("draws a code block with its language and its text, and the button only when it is handed a way to insert", () => {
    const source = "```sh\nls -la\n```";
    const without = html(source);
    expect(without).toContain('<span class="md-code-lang">sh</span>');
    expect(without).toContain("<pre><code>ls -la</code></pre>");
    expect(without).not.toContain("<button");
    const withButton = html(source, { insert: true });
    expect(withButton).toContain("Insert in terminal");
    expect(withButton).not.toContain("disabled");
  });

  it("holds the button of a block until the whole answer is there and the block is closed", () => {
    expect(html("```sh\nls", { insert: true, complete: true })).toMatch(
      /<button[^>]*disabled=""[^>]*>Insert in terminal/,
    );
    expect(html("```sh\nls\n```", { insert: true, complete: false })).toMatch(
      /<button[^>]*disabled=""[^>]*>Insert in terminal/,
    );
    expect(html("```\n   \n```", { insert: true })).toMatch(
      /<button[^>]*disabled=""[^>]*>Insert in terminal/,
    );
  });
});

describe("what an answer cannot do", () => {
  it("shows HTML as text: every angle bracket is escaped and no tag of the answer is in the markup", () => {
    const attack =
      '<script>alert(1)</script><img src=x onerror=alert(1)><iframe src="//evil"></iframe><a href="javascript:alert(1)">x</a>';
    for (const source of [
      attack,
      `**${attack}**`,
      `# ${attack}`,
      `- ${attack}`,
      `\`${attack}\``,
      `\`\`\`html\n${attack}\n\`\`\``,
      `\`\`\`${attack}\n${attack}\n\`\`\``,
    ]) {
      const markup = html(source, { insert: true });
      expect(markup).not.toMatch(/<(script|img|iframe|a)[\s>]/i);
      expect(markup).not.toContain("onerror=alert(1)>");
      expect(markup).toContain("&lt;");
    }
  });

  it("makes no link of a link: the address stays text and nothing is clickable", () => {
    const markup = html("[click](javascript:alert(1)) and https://example.com and ![x](y.png)");
    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("[click](javascript:alert(1))");
  });

  it("does not take a language name that is not a name", () => {
    const markup = html('```"><script>x</script>\nls\n```');
    expect(markup).toContain('<span class="md-code-lang"></span>');
    expect(markup).not.toContain("<script");
  });

  it("is the only way an answer reaches the page: no source file sets HTML by hand", () => {
    const here = new URL("./", import.meta.url);
    const sources = readdirSync(here).filter(
      (name) => /\.tsx?$/.test(name) && !/\.test\./.test(name),
    );
    expect(sources.length).toBeGreaterThan(10);
    for (const name of sources) {
      const text = readFileSync(new URL(name, here), "utf8");
      expect(text, name).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML/);
    }
  });
});
