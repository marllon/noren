// `pnpm readme:check` (NOR-F12-03): every relative link and image of README.md must exist on disk.
// Absolute URLs (http, https, mailto...) and pure anchors (#section) are not checked. Exit 1 lists
// each broken target with its line.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = resolve(process.env["NOREN_README"] ?? resolve(root, "README.md"));
const base = dirname(readme);

/** Targets of Markdown links and images, reference definitions and HTML `src`/`href`, with their line. */
export function targetsOf(text) {
  const found = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const line = raw.replace(/`[^`]*`/g, "");
    for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]*)[^)]*\)/g)) {
      found.push({ line: index + 1, target: (match[1] ?? "").replace(/^<|>$/g, "") });
    }
    const definition = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
    if (definition)
      found.push({ line: index + 1, target: (definition[1] ?? "").replace(/^<|>$/g, "") });
    for (const match of line.matchAll(
      /<(?:img|a|source)\b[^>]*?\b(?:src|href)=["']([^"']*)["']/gi,
    )) {
      found.push({ line: index + 1, target: match[1] ?? "" });
    }
  });
  return found;
}

/** True for a target that is not a path on disk: an absolute URL, an anchor or empty. */
export function isExternal(target) {
  return target === "" || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function main() {
  const broken = [];
  let checked = 0;
  for (const { line, target } of targetsOf(readFileSync(readme, "utf8"))) {
    if (isExternal(target)) continue;
    const path = decodeURIComponent(target.split(/[#?]/)[0] ?? "");
    checked += 1;
    if (!existsSync(resolve(base, path))) broken.push(`README.md:${line} ${target}`);
  }
  if (broken.length > 0) {
    console.error(`readme:check: ${broken.length} relative target(s) missing on disk:`);
    for (const entry of broken) console.error(`  ${entry}`);
    process.exit(1);
  }
  console.log(`readme:check OK: ${checked} relative links and images exist`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
