// License gate for npm dependencies (see _loop/REGRAS.md, "Licenças permitidas").
// Reads `pnpm licenses list --json` and fails when a package carries a license outside the lists:
//   - production dependencies (`--prod`): PROD_ALLOWED
//   - everything else (dev tooling): PROD_ALLOWED plus DEV_EXTRA
// SPDX expressions with OR, AND and parentheses are evaluated; `WITH` passes only for the exact
// expressions in the allowed lists; workspace packages are skipped.
// A license outside the lists is never an exception here: it is a decision for the maintainer.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PROD_ALLOWED = new Set([
  "MIT",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Zlib",
  "CC0-1.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "BlueOak-1.0.0",
  "MPL-2.0",
]);
const DEV_EXTRA = new Set(["MPL-2.0"]);

// Recursive-descent evaluator: expr = and ("OR" and)*; and = atom ("AND" atom)*; atom = id | "(" expr ")".
export function evaluate(expression, allowed) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const parseOr = () => {
    let ok = parseAnd();
    while (tokens[pos]?.toUpperCase() === "OR") {
      pos += 1;
      const right = parseAnd();
      ok = ok || right;
    }
    return ok;
  };
  const parseAnd = () => {
    let ok = parseAtom();
    while (tokens[pos]?.toUpperCase() === "AND") {
      pos += 1;
      const right = parseAtom();
      ok = ok && right;
    }
    return ok;
  };
  const parseAtom = () => {
    const token = tokens[pos];
    pos += 1;
    if (token === undefined) throw new Error(`unexpected end of expression "${expression}"`);
    if (token === "(") {
      const ok = parseOr();
      if (tokens[pos] !== ")") throw new Error(`missing ")" in "${expression}"`);
      pos += 1;
      return ok;
    }
    if (token === ")") throw new Error(`unexpected ")" in "${expression}"`);
    // "<id> WITH <exception>" is matched as one literal entry, so only the WITH expressions
    // listed in the allow set pass (D15: Apache-2.0 WITH LLVM-exception).
    if (tokens[pos]?.toUpperCase() === "WITH") {
      const exception = tokens[pos + 1];
      if (exception === undefined || exception === "(" || exception === ")") {
        throw new Error(`missing exception after WITH in "${expression}"`);
      }
      pos += 2;
      return allowed.has(`${token} WITH ${exception}`);
    }
    return allowed.has(token);
  };
  const ok = parseOr();
  if (pos !== tokens.length) throw new Error(`unexpected "${tokens[pos]}" in "${expression}"`);
  return ok;
}

function workspaceNames() {
  const names = new Set();
  const readName = (dir) => {
    const file = join(dir, "package.json");
    if (existsSync(file)) names.add(JSON.parse(readFileSync(file, "utf8")).name);
  };
  readName(root);
  for (const group of ["apps", "packages"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) readName(join(base, entry.name));
    }
  }
  return names;
}

// pnpm is a .cmd shim on Windows and Node refuses to spawn those without a shell. When started
// through `pnpm licenses:check`, npm_execpath points at pnpm's JS entry, which Node can run directly.
function pnpmLicenses(extraArgs) {
  const entry = process.env.npm_execpath;
  const viaNode = entry !== undefined && /\.c?js$/.test(entry);
  const args = ["licenses", "list", "--json", ...extraArgs];
  const result = viaNode
    ? spawnSync(process.execPath, [entry, ...args], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1 << 28,
      })
    : spawnSync(`pnpm ${args.join(" ")}`, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1 << 28,
        shell: true,
      });
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(" ")} failed: ${result.stderr || result.error}`);
  }
  return JSON.parse(result.stdout);
}

function violations(report, allowed, ignored) {
  const found = [];
  for (const [license, packages] of Object.entries(report)) {
    for (const pkg of packages) {
      if (ignored.has(pkg.name)) continue;
      let ok;
      try {
        ok = evaluate(license, allowed);
      } catch {
        ok = false;
      }
      if (!ok) found.push(`${pkg.name}@${pkg.versions.join(",")}: ${license}`);
    }
  }
  return found;
}

function main() {
  const ignored = workspaceNames();
  const devAllowed = new Set([...PROD_ALLOWED, ...DEV_EXTRA]);
  const problems = [
    ...violations(pnpmLicenses(["--prod"]), PROD_ALLOWED, ignored).map((p) => `[prod] ${p}`),
    ...violations(pnpmLicenses([]), devAllowed, ignored).map((p) => `[all] ${p}`),
  ];
  if (problems.length > 0) {
    console.error("licenses: packages with a license outside the allowed list:");
    for (const line of new Set(problems)) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log("licenses: npm dependencies OK");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`licenses: ${error.message}`);
    process.exitCode = 1;
  }
}
