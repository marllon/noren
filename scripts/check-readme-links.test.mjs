// Run with `node --test scripts/check-readme-links.test.mjs` (the vitest of `pnpm verify` only reads
// packages/ and apps/).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isExternal, targetsOf } from "./check-readme-links.mjs";

test("finds links, images, reference definitions and html sources, with their lines", () => {
  const text = [
    "# Title",
    "![hero](docs/media/a.png) and [doc](docs/X.md#part)",
    '<img src="docs/media/b.png" alt="b">',
    "[ref]: docs/Y.md",
  ].join("\n");
  assert.deepEqual(targetsOf(text), [
    { line: 2, target: "docs/media/a.png" },
    { line: 2, target: "docs/X.md#part" },
    { line: 3, target: "docs/media/b.png" },
    { line: 4, target: "docs/Y.md" },
  ]);
});

test("skips code fences and inline code", () => {
  const text = ["```md", "[no](missing.md)", "```", "`[no](missing.md)` [yes](here.md)"].join("\n");
  assert.deepEqual(targetsOf(text), [{ line: 4, target: "here.md" }]);
});

test("external urls and anchors are not paths on disk", () => {
  assert.equal(isExternal("https://example.com/x"), true);
  assert.equal(isExternal("mailto:a@b.c"), true);
  assert.equal(isExternal("#section"), true);
  assert.equal(isExternal("docs/X.md"), false);
});
