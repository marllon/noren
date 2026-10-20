// Runs a command with the environment of game mode (NOR-F11-04): `CARGO_BUILD_JOBS=8` while the
// signal is valid. Used by the package.json scripts that call cargo, directly or through Tauri:
//   node scripts/game-run.mjs cargo clippy ...
//   node scripts/game-run.mjs pnpm --filter @noren/desktop exec tauri build
// No shell: pnpm is started through the JS entry that pnpm itself exports in npm_execpath.
import { spawnSync } from "node:child_process";
import { cargoEnv } from "./game-mode.mjs";

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error("usage: node scripts/game-run.mjs <command> [args...]");
  process.exit(2);
}

const env = cargoEnv();
const pnpmEntry = process.env.npm_execpath;
const viaNode = command === "pnpm" && pnpmEntry !== undefined && /\.c?js$/.test(pnpmEntry);
const run = viaNode
  ? spawnSync(process.execPath, [pnpmEntry, ...args], { stdio: "inherit", env })
  : spawnSync(command, args, { stdio: "inherit", env });
if (run.error) {
  console.error(`game-run: could not run ${command}: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
