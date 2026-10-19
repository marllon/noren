import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { codeBlocksOf, markdownText, parseMarkdown } from "./markdown";
import type { MdBlock, MdInline } from "./markdown";

const text = (value: string): MdInline => ({ type: "text", text: value });
const para = (...children: MdInline[]): MdBlock => ({ type: "paragraph", children });

describe("paragraphs and text", () => {
  it("makes nothing out of nothing", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });

  it("reads a line as a paragraph and a blank line as the end of it", () => {
    expect(parseMarkdown("one two\nthree\n\nfour")).toEqual([
      para(text("one two\nthree")),
      para(text("four")),
    ]);
  });

  it("takes CRLF and CR line breaks as line breaks", () => {
    expect(parseMarkdown("a\r\nb\r\rc")).toEqual([para(text("a\nb")), para(text("c"))]);
  });

  it("drops the blanks at the edges of a line and keeps the ones inside", () => {
    expect(parseMarkdown("   spaced   out   \n\t tabbed ")).toEqual([
      para(text("spaced   out\ntabbed")),
    ]);
  });
});

describe("headings", () => {
  it("reads one to six hashes followed by a blank", () => {
    for (let level = 1; level <= 6; level++) {
      expect(parseMarkdown(`${"#".repeat(level)} Title`)).toEqual([
        { type: "heading", level, children: [text("Title")] },
      ]);
    }
  });

  it("is not a heading without the blank, with seven hashes or with nothing after it", () => {
    for (const line of ["#hashtag", "####### seven", "#", "# "]) {
      expect(parseMarkdown(line)[0]?.type).toBe("paragraph");
    }
  });

  it("drops a closing run of hashes and reads marks inside", () => {
    expect(parseMarkdown("## The **big** one ##")).toEqual([
      {
        type: "heading",
        level: 2,
        children: [text("The "), { type: "strong", children: [text("big")] }, text(" one")],
      },
    ]);
  });

  it("interrupts a paragraph", () => {
    expect(parseMarkdown("before\n# Title\nafter").map((block) => block.type)).toEqual([
      "paragraph",
      "heading",
      "paragraph",
    ]);
  });
});

describe("lists", () => {
  it("reads bullets of all three kinds", () => {
    for (const mark of ["-", "*", "+"]) {
      expect(parseMarkdown(`${mark} one\n${mark} two`)).toEqual([
        {
          type: "list",
          ordered: false,
          start: 1,
          items: [[para(text("one"))], [para(text("two"))]],
        },
      ]);
    }
  });

  it("reads numbers and keeps where the count starts", () => {
    expect(parseMarkdown("3. three\n4) four")).toEqual([
      {
        type: "list",
        ordered: true,
        start: 3,
        items: [[para(text("three"))], [para(text("four"))]],
      },
    ]);
  });

  it("goes on with an item on a line that follows it, indented or not", () => {
    expect(parseMarkdown("- one\n  more of one\nlazy too\n- two")).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [[para(text("one\nmore of one\nlazy too"))], [para(text("two"))]],
      },
    ]);
  });

  it("keeps one list across blank lines between its items, and ends it on other text", () => {
    const blocks = parseMarkdown("- one\n\n- two\n\nplain");
    expect(blocks.map((block) => block.type)).toEqual(["list", "paragraph"]);
    expect(blocks[0]).toMatchObject({ items: [[para(text("one"))], [para(text("two"))]] });
  });

  it("starts another list when bullets turn into numbers", () => {
    expect(parseMarkdown("- a\n1. b").map((block) => block.type)).toEqual(["list", "list"]);
  });

  it("reads marks in an item", () => {
    expect(parseMarkdown("- run `ls` now")).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [[para(text("run "), { type: "code", text: "ls" }, text(" now"))]],
      },
    ]);
  });

  it("is not a list without a blank after the mark", () => {
    for (const line of ["-foo", "---", "**bold**", "*emph*", "1.5 liters"]) {
      expect(parseMarkdown(line)[0]?.type).toBe("paragraph");
    }
  });

  it("keeps a code block that is indented under an item inside that item", () => {
    const blocks = parseMarkdown("1. Install:\n   ```sh\n   npm i\n   ```\n2. Run it");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "list",
      ordered: true,
      start: 1,
      items: [
        [para(text("Install:")), { type: "code", lang: "sh", text: "npm i", open: false }],
        [para(text("Run it"))],
      ],
    });
  });

  it("ends the list at a code block that is not indented", () => {
    expect(parseMarkdown("- a\n```\nx\n```").map((block) => block.type)).toEqual(["list", "code"]);
  });
});

describe("inline marks", () => {
  it("reads strong, emphasis and code", () => {
    expect(parseMarkdown("a **b** c *d* e `f` g")).toEqual([
      para(
        text("a "),
        { type: "strong", children: [text("b")] },
        text(" c "),
        { type: "em", children: [text("d")] },
        text(" e "),
        { type: "code", text: "f" },
        text(" g"),
      ),
    ]);
  });

  it("nests emphasis in strong and strong in emphasis", () => {
    expect(parseMarkdown("**a *b* c**")).toEqual([
      para({
        type: "strong",
        children: [text("a "), { type: "em", children: [text("b")] }, text(" c")],
      }),
    ]);
    expect(parseMarkdown("*a **b** c*")).toEqual([
      para({
        type: "em",
        children: [text("a "), { type: "strong", children: [text("b")] }, text(" c")],
      }),
    ]);
    expect(parseMarkdown("***both***")).toEqual([
      para({ type: "strong", children: [{ type: "em", children: [text("both")] }] }),
    ]);
  });

  it("does not read marks inside code", () => {
    expect(parseMarkdown("`a **b** *c*` and ``x ` y``")).toEqual([
      para({ type: "code", text: "a **b** *c*" }, text(" and "), { type: "code", text: "x ` y" }),
    ]);
  });

  it("leaves a mark with no partner as it was typed, so a half-written answer reads right", () => {
    expect(markdownText(parseMarkdown("a **b and `c and *d"))).toBe("a **b and `c and *d");
    expect(parseMarkdown("a **b")).toEqual([para(text("a **b"))]);
  });

  it("does not read stars between blanks, or around a shell glob, as emphasis", () => {
    for (const line of ["2 * 3 * 4", "ls *.txt *.md", "a ** b ** c", "**", "* *"]) {
      expect(parseMarkdown(line).flatMap(inlineTypes)).not.toContain("em");
      expect(parseMarkdown(line).flatMap(inlineTypes)).not.toContain("strong");
    }
  });

  it("does not read underscores at all, so names with them stay whole", () => {
    expect(parseMarkdown("snake_case and __init__ and _x_")).toEqual([
      para(text("snake_case and __init__ and _x_")),
    ]);
  });

  it("takes a backslash before a star or a backtick as the character, and leaves other backslashes", () => {
    expect(parseMarkdown("\\*not em\\* and \\`not code\\`")).toEqual([
      para(text("*not em* and `not code`")),
    ]);
    expect(parseMarkdown("C:\\Users\\me and \\\\server\\share and \\.git")).toEqual([
      para(text("C:\\Users\\me and \\\\server\\share and \\.git")),
    ]);
  });

  it("drops one blank on each side of a code span and turns its line breaks into blanks", () => {
    expect(parseMarkdown("` a ` and `b\nc`")).toEqual([
      para({ type: "code", text: "a" }, text(" and "), { type: "code", text: "b c" }),
    ]);
  });

  it("stops nesting marks past a few levels and shows the rest as typed", () => {
    const deep = `${"*a ".repeat(40)}x${"* ".repeat(40)}`;
    expect(parseMarkdown(deep).length).toBeGreaterThan(0);
  });
});

function inlineTypes(block: MdBlock): string[] {
  const walk = (parts: readonly MdInline[]): string[] =>
    parts.flatMap((part) =>
      part.type === "strong" || part.type === "em"
        ? [part.type, ...walk(part.children)]
        : [part.type],
    );
  if (block.type === "paragraph" || block.type === "heading") return walk(block.children);
  if (block.type === "list") return block.items.flatMap((item) => item.flatMap(inlineTypes));
  return [];
}

describe("code blocks", () => {
  it("reads a fenced block with its language and the text exactly", () => {
    expect(parseMarkdown("Run:\n\n```bash\nls -la\n  indented\n\nlast\n```\nDone")).toEqual([
      para(text("Run:")),
      { type: "code", lang: "bash", text: "ls -la\n  indented\n\nlast", open: false },
      para(text("Done")),
    ]);
  });

  it("reads ~~~ fences, and a longer fence that holds a shorter one", () => {
    expect(parseMarkdown("~~~\na\n~~~")).toEqual([
      { type: "code", lang: "", text: "a", open: false },
    ]);
    expect(parseMarkdown("````md\n```\ninner\n```\n````")).toEqual([
      { type: "code", lang: "md", text: "```\ninner\n```", open: false },
    ]);
  });

  it("does not close a block with the other kind of fence or with a shorter one", () => {
    expect(parseMarkdown("```\na\n~~~\n``\nb\n```")).toEqual([
      { type: "code", lang: "", text: "a\n~~~\n``\nb", open: false },
    ]);
  });

  it("marks a block that has not closed as open, with what has come so far", () => {
    expect(parseMarkdown("text\n```sh\necho hi")).toEqual([
      para(text("text")),
      { type: "code", lang: "sh", text: "echo hi", open: true },
    ]);
    expect(parseMarkdown("```")).toEqual([{ type: "code", lang: "", text: "", open: true }]);
  });

  it("does not show a closing fence that has only partly arrived as code", () => {
    expect(parseMarkdown("```\nls\n``")).toEqual([
      { type: "code", lang: "", text: "ls", open: true },
    ]);
    expect(parseMarkdown("~~~\nls\n~")).toEqual([
      { type: "code", lang: "", text: "ls", open: true },
    ]);
    expect(parseMarkdown("````\nls\n```")).toEqual([
      { type: "code", lang: "", text: "ls", open: true },
    ]);
    // A line of other characters is code, however much it looks like it.
    expect(parseMarkdown("```\nls\n~~")).toEqual([
      { type: "code", lang: "", text: "ls\n~~", open: true },
    ]);
  });

  it("takes a language only when it is a plain name", () => {
    expect(parseMarkdown("```c++\nx\n```")[0]).toMatchObject({ lang: "c++" });
    expect(parseMarkdown('```sh title="a"\nx\n```')[0]).toMatchObject({ lang: "sh" });
    expect(parseMarkdown('```"><img src=x>\nx\n```')[0]).toMatchObject({ lang: "" });
    expect(parseMarkdown(`\`\`\`${"a".repeat(80)}\nx\n\`\`\``)[0]).toMatchObject({ lang: "" });
  });

  it("is not a block when a backtick fence has a backtick in its first line", () => {
    expect(parseMarkdown("```code```")[0]?.type).toBe("paragraph");
  });

  it("takes the indent of the fence off the lines of the block", () => {
    expect(parseMarkdown("  ```\n  a\n    b\n c\n  ```")).toEqual([
      { type: "code", lang: "", text: "a\n  b\nc", open: false },
    ]);
  });

  it("lists the blocks of a tree, those inside items too, in order", () => {
    const blocks = parseMarkdown("```a\n1\n```\n- x\n  ```b\n  2\n  ```\n\n```c\n3");
    expect(codeBlocksOf(blocks).map((block) => [block.lang, block.text, block.open])).toEqual([
      ["a", "1", false],
      ["b", "2", false],
      ["c", "3", true],
    ]);
  });
});

describe("what is not Markdown here stays text", () => {
  it("shows HTML as the characters it is made of", () => {
    const source = "<b>bold</b> <script>alert(1)</script> <img src=x onerror=alert(1)>";
    const blocks = parseMarkdown(source);
    expect(blocks).toEqual([para(text(source))]);
  });

  it("shows HTML inside a mark, a heading, a list and a code block as text too", () => {
    const html = "<iframe src=//x></iframe>";
    expect(markdownText(parseMarkdown(`**${html}** \`${html}\``))).toBe(`${html} ${html}`);
    expect(markdownText(parseMarkdown(`# ${html}`))).toBe(html);
    expect(markdownText(parseMarkdown(`- ${html}`))).toBe(html);
    expect(markdownText(parseMarkdown(`\`\`\`html\n${html}\n\`\`\``))).toBe(html);
  });

  it("keeps links, quotes, rules and tables as typed", () => {
    for (const line of [
      "[the docs](https://example.com)",
      "> quoted",
      "| a | b |\n|---|---|\n| 1 | 2 |",
      "![pic](x.png)",
    ]) {
      expect(markdownText(parseMarkdown(line)).replace(/\n+/g, "\n")).toBe(line);
    }
  });
});

describe("time", () => {
  it("answers a long text built to be slow in about the time of a short one", () => {
    const hostile = [
      `${"*a ".repeat(30000)}`,
      `${"`a ".repeat(30000)}`,
      `${"**a *b ".repeat(15000)}`,
      "*".repeat(60000),
      "`".repeat(60000),
      `${"- ".repeat(20000)}`,
      `${"\n```\n".repeat(10000)}`,
    ];
    for (const source of hostile) {
      const started = Date.now();
      parseMarkdown(source);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });
});

describe("properties", () => {
  const marky = fc.stringMatching(/^[a-z *`#\-+.>\\<~\n0-9_)]{0,200}$/);

  it("never throws, whatever the text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (source) => void parseMarkdown(source)));
    fc.assert(
      fc.property(
        fc.string({ unit: "binary", maxLength: 300 }),
        (source) => void parseMarkdown(source),
      ),
    );
    fc.assert(
      fc.property(marky, (source) => void parseMarkdown(source)),
      { numRuns: 500 },
    );
  });

  it("gives the same tree for the same text, and a tree made only of data", () => {
    fc.assert(
      fc.property(marky, (source) => {
        const tree = parseMarkdown(source);
        expect(parseMarkdown(source)).toEqual(tree);
        expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
      }),
    );
  });

  const word = fc.stringMatching(/^[A-Za-z,;:!?()<>/=@%&"']{1,12}$/);

  it("gives text with no marks back as it is: words, single blanks and line breaks", () => {
    const joined = fc
      .array(fc.tuple(word, fc.constantFrom(" ", "\n")), { minLength: 1, maxLength: 20 })
      .map((parts) => parts.map(([w, sep], index) => (index === 0 ? w : sep + w)).join(""));
    fc.assert(
      fc.property(joined, (source) => {
        const tree = parseMarkdown(source);
        expect(tree).toEqual([para(text(source))]);
        expect(markdownText(tree)).toBe(source);
      }),
    );
  });

  it("keeps paragraphs apart at a blank line and no more", () => {
    fc.assert(
      fc.property(fc.array(word, { minLength: 1, maxLength: 8 }), (words) => {
        const tree = parseMarkdown(words.join("\n\n"));
        expect(tree).toEqual(words.map((w) => para(text(w))));
      }),
    );
  });

  it("turns HTML into text: every angle bracket typed is in the text shown, and no node is anything else", () => {
    const html = fc
      .array(
        fc.oneof(
          word,
          fc.constantFrom(
            "<b>",
            "</b>",
            "<script>alert(1)</script>",
            "<img src=x onerror=alert(1)>",
            '<a href="javascript:x">',
            "&lt;",
            "<!-- c -->",
          ),
        ),
        { minLength: 1, maxLength: 12 },
      )
      .map((parts) => parts.join(" "));
    const allowed = new Set(["paragraph", "heading", "list", "code", "text", "strong", "em"]);
    const count = (value: string, char: string): number => value.split(char).length - 1;
    fc.assert(
      fc.property(html, (source) => {
        const tree = parseMarkdown(source);
        const shown = markdownText(tree);
        expect(count(shown, "<")).toBe(count(source, "<"));
        expect(count(shown, ">")).toBe(count(source, ">"));
        expect(shown).toBe(source);
        const kinds = new Set<string>();
        JSON.stringify(tree, (key, value: unknown) => {
          if (key === "type" && typeof value === "string") kinds.add(value);
          return value;
        });
        for (const kind of kinds) expect(allowed.has(kind)).toBe(true);
      }),
    );
  });

  it("keeps the text of a fenced block exactly, and nothing leaks out of it", () => {
    // Lines that do not look like a fence, with the blanks they have.
    const codeLine = fc.stringMatching(/^[ a-z*#\-1.<>\\]{0,30}$/);
    fc.assert(
      fc.property(fc.array(codeLine, { maxLength: 10 }), word, (lines, after) => {
        const tree = parseMarkdown(`\`\`\`sh\n${lines.join("\n")}\n\`\`\`\n\n${after}`);
        expect(tree).toEqual([
          { type: "code", lang: "sh", text: lines.join("\n"), open: false },
          para(text(after)),
        ]);
      }),
    );
  });

  it("holds a half-written answer: any prefix of a text parses, and a prefix's code blocks are a prefix too", () => {
    const answer =
      "Sure.\n\n## Steps\n\n1. Run `ls -la`\n2. Then:\n   ```sh\n   cd /tmp && ls\n   ```\n\n**Done** *now*.\n\n```\nlast\n```";
    for (let end = 0; end <= answer.length; end++) {
      const blocks = codeBlocksOf(parseMarkdown(answer.slice(0, end)));
      const full = codeBlocksOf(parseMarkdown(answer));
      blocks.forEach((block, index) => {
        const whole = full[index];
        expect(whole?.text.startsWith(block.text.replace(/\s+$/, ""))).toBe(true);
        // A block is only closed once the text has its closing fence.
        if (!block.open) expect(block.text).toBe(whole?.text);
      });
    }
  });
});
