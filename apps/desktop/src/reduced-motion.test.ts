import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every animation and transition in the stylesheet has to switch off under `prefers-reduced-motion:
// reduce`. The test reads `styles.css` and pairs each rule that moves with a rule inside a
// reduced-motion block that names the same selector and turns the motion off.

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

interface Rule {
  selectors: string[];
  body: string;
}

/** The style rules of a block of CSS, one level deep (the body of an at-rule is read by the caller). */
function rulesOf(text: string): { rules: Rule[]; media: { query: string; text: string }[] } {
  const rules: Rule[] = [];
  const media: { query: string; text: string }[] = [];
  let depth = 0;
  let start = 0;
  let head = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{") {
      if (depth === 0) {
        head = text.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        const body = text.slice(start, i);
        if (head.startsWith("@media")) media.push({ query: head, text: body });
        else if (!head.startsWith("@"))
          rules.push({ selectors: head.split(",").map((s) => s.trim()), body });
        start = i + 1;
      }
    }
  }
  return { rules, media };
}

const moves = (body: string): boolean =>
  /(^|[;\s])(animation|transition)\s*:\s*(?!none\b)/.test(body);
const stops = (body: string): boolean => /(animation|transition)\s*:\s*none\b/.test(body);

const { rules, media } = rulesOf(css);
const reduced = media
  .filter((block) => /prefers-reduced-motion:\s*reduce/.test(block.query))
  .flatMap((block) => rulesOf(block.text).rules);
const stopped = new Set(reduced.filter((rule) => stops(rule.body)).flatMap((r) => r.selectors));
const moving = rules.filter((rule) => moves(rule.body)).flatMap((rule) => rule.selectors);

describe("prefers-reduced-motion", () => {
  it("finds the rules that move and the ones that stop them", () => {
    expect(moving.length).toBeGreaterThanOrEqual(4);
    expect(stopped.size).toBeGreaterThanOrEqual(4);
  });

  it.each([...new Set(moving)])("turns off the motion of %s", (selector) => {
    expect(stopped.has(selector)).toBe(true);
  });
});
