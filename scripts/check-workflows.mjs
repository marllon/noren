// Workflow gate (D17): every file in .github/workflows must parse as YAML and run only on the
// self-hosted runner, with no hosted runner label, no sudo and no apt. release.yml is also held to
// its contract: it starts only on a tag `v*` and creates the release as a draft. pages.yml starts
// only by hand (`workflow_dispatch`), so nothing is published by a push.
// YAML is parsed with Prettier (already a dev dependency); the runner and trigger rules are read
// from the non-comment lines, which is enough for the plain block style these files use.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".github", "workflows");
const RUNNER = "[self-hosted, linux, noren]";
const FORBIDDEN = [
  [/\bsudo\b/, "sudo"],
  [/\bapt(-get)?\b/, "apt"],
  [/\b(ubuntu|windows|macos)-(latest|\d)/, "a hosted runner label"],
];

const problems = [];
const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
if (files.length === 0) problems.push("no workflow files found");
for (const required of ["ci.yml", "release.yml", "pages.yml"]) {
  if (!files.includes(required)) problems.push(`${required} is missing`);
}

for (const name of files) {
  const text = readFileSync(join(dir, name), "utf8");
  try {
    await format(text, { parser: "yaml" });
  } catch (error) {
    problems.push(`${name}: not valid YAML (${String(error.message).split("\n")[0]})`);
    continue;
  }
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));

  const jobs = [];
  let inJobs = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) inJobs = true;
    else if (/^\S/.test(line)) inJobs = false;
    else if (inJobs && /^ {2}[\w-]+:\s*$/.test(line)) jobs.push(line.trim());
  }
  const runners = lines.filter((line) => /^\s*runs-on:/.test(line));
  if (jobs.length === 0) problems.push(`${name}: no jobs found`);
  if (runners.length !== jobs.length) {
    problems.push(`${name}: ${jobs.length} job(s) but ${runners.length} runs-on line(s)`);
  }
  for (const line of runners) {
    if (line.replace(/^\s*runs-on:\s*/, "").trim() !== RUNNER) {
      problems.push(`${name}: runs-on must be exactly ${RUNNER}, found "${line.trim()}"`);
    }
  }
  for (const line of lines) {
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(line)) problems.push(`${name}: ${label} is not allowed: "${line.trim()}"`);
    }
  }

  const on = text.match(/^on:\r?\n((?: {2,}.*\r?\n|\r?\n)+)/m)?.[1] ?? "";
  const triggers = [...on.matchAll(/^ {2}([\w-]+):/gm)].map((match) => match[1]);

  if (name === "pages.yml" && triggers.join() !== "workflow_dispatch") {
    problems.push(
      `pages.yml: the only trigger must be workflow_dispatch, found "${triggers.join()}"`,
    );
  }

  if (name === "release.yml") {
    if (triggers.join() !== "push") {
      problems.push(`release.yml: the only trigger must be push, found "${triggers.join()}"`);
    }
    if (!/^\s+tags:\s*\["v\*"\]\s*$/m.test(on) || /^\s+branches:/m.test(on)) {
      problems.push('release.yml: push must be limited to tags: ["v*"]');
    }
    if (!lines.some((line) => /gh release create/.test(line))) {
      problems.push("release.yml: no `gh release create` step");
    }
    if (!lines.some((line) => /--draft\b/.test(line)) || /--draft=false/.test(text)) {
      problems.push("release.yml: the release must be created with --draft");
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`workflows: ${problem}`);
  process.exit(1);
}
console.log(`workflows OK: ${files.join(", ")}`);
