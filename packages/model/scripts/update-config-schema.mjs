// Regenerates docs/config.schema.json from the zod schema of config.jsonc (src/config.ts).
// The schema is TypeScript, so the file is written by the Vitest test that checks it, run with
// NOREN_UPDATE_SCHEMA=1; Prettier then gives it the format the rest of the repository has.
// Run it with `pnpm --filter @noren/model config:schema`.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// pnpm is a .cmd shim on Windows and Node refuses to spawn those without a shell. When started
// through `pnpm ... config:schema`, npm_execpath points at pnpm's JS entry, which Node can run directly.
const entry = process.env.npm_execpath;
const viaNode = entry !== undefined && /\.c?js$/.test(entry);

function pnpm(args, env = {}) {
  const options = { cwd: root, stdio: "inherit", env: { ...process.env, ...env } };
  const result = viaNode
    ? spawnSync(process.execPath, [entry, ...args], options)
    : spawnSync(`pnpm ${args.join(" ")}`, { ...options, shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

pnpm(["exec", "vitest", "run", "packages/model/src/config-schema.test.ts"], {
  NOREN_UPDATE_SCHEMA: "1",
});
pnpm(["exec", "prettier", "--write", "docs/config.schema.json"]);
console.log("docs/config.schema.json updated");
