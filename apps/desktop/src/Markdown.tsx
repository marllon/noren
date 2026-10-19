import { parseMarkdown } from "@noren/model";
import type { MdBlock, MdCode, MdInline } from "@noren/model";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { useT } from "./i18n";

// The Markdown of an answer of the AI, drawn as React elements. The text is parsed into a tree of
// data (`parseMarkdown` in `@noren/model`) and every node becomes an element here, with its text as
// a child: React escapes it, so nothing the model writes can become HTML, a link, a script or a
// style. Nothing here sets HTML by hand (a test reads the sources to hold it). A code block carries a button that hands
// its text to `onInsert`; the button only asks, and what the page does with the text (it writes it
// at the prompt, never with Enter) is not decided here.

interface MarkdownProps {
  /** The Markdown source; an answer that is still arriving can be handed in as it grows. */
  source: string;
  /** Hands the text of a code block over. Without it the blocks have no button. */
  onInsert?: ((text: string) => void) | undefined;
  /** False while the answer is still being written: a block may be half of what it will be. */
  complete: boolean;
}

function Inline({ parts }: { parts: readonly MdInline[] }): ReactNode {
  return parts.map((part, index) => {
    switch (part.type) {
      case "text":
        return part.text;
      case "code":
        return <code key={index}>{part.text}</code>;
      case "strong":
        return (
          <strong key={index}>
            <Inline parts={part.children} />
          </strong>
        );
      case "em":
        return (
          <em key={index}>
            <Inline parts={part.children} />
          </em>
        );
    }
  });
}

interface CodeBlockProps {
  block: MdCode;
  onInsert: ((text: string) => void) | undefined;
  complete: boolean;
}

function CodeBlock({ block, onInsert, complete }: CodeBlockProps) {
  const t = useT();
  // A block that has not closed, or an answer that is still arriving, may be missing the end of
  // the command: the button waits for all of it.
  const ready = complete && !block.open && block.text.trim() !== "";
  return (
    <div className="md-code" data-nr-part="ask-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{block.lang}</span>
        {onInsert !== undefined && (
          <button
            type="button"
            className="md-code-insert"
            disabled={!ready}
            onClick={() => onInsert(block.text)}
          >
            {t("ask.insertInTerminal")}
          </button>
        )}
      </div>
      <pre>
        <code>{block.text}</code>
      </pre>
    </div>
  );
}

function Blocks({
  blocks,
  onInsert,
  complete,
}: {
  blocks: readonly MdBlock[];
} & Pick<CodeBlockProps, "onInsert" | "complete">): ReactNode {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "paragraph":
        return (
          <p key={index}>
            <Inline parts={block.children} />
          </p>
        );
      case "heading": {
        // The panel's own title is a level-2 heading, so an answer's headings start below it.
        const Heading = `h${Math.min(6, block.level + 2)}` as "h3" | "h4" | "h5" | "h6";
        return (
          <Heading key={index}>
            <Inline parts={block.children} />
          </Heading>
        );
      }
      case "code":
        return <CodeBlock key={index} block={block} onInsert={onInsert} complete={complete} />;
      case "list": {
        const items = block.items.map((item, at) => (
          <li key={at}>
            <Blocks blocks={item} onInsert={onInsert} complete={complete} />
          </li>
        ));
        return block.ordered ? (
          <ol key={index} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        );
      }
    }
  });
}

/** An answer of the AI as formatted text, with a button on each code block when `onInsert` is given. */
export function Markdown({ source, onInsert, complete }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="markdown" data-nr-part="ask-markdown">
      <Blocks blocks={blocks} onInsert={onInsert} complete={complete} />
    </div>
  );
}
