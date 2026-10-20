// Builds the installers (`pnpm desktop:build`, NOR-F14-02c): the session daemon `norend` goes next
// to `noren` in the installed folder, and the installers stop a running one before they replace it.
//
// Tauri bundles an external binary only when `bundle.externalBin` names it, and its build script then
// requires the file `binaries/norend-<target triple>[.exe]` to exist for every build of the app,
// including the `cargo build`, `clippy` and `test` of `pnpm verify` (and the CI) that have no use
// for it. So the entry is not in `tauri.conf.json`: it is in `tauri.bundle.conf.json`, which only
// this script hands to `tauri build --config`, after it has built `norend` in release mode and put
// the copy in `apps/desktop/src-tauri/binaries/` (ignored by git, never committed).
// Extra arguments go to `tauri build` (for instance `--bundles nsis`).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostTriple, norendFileName, sidecarFileName } from "./desktop-build-lib.mjs";
import { cargoEnv } from "./game-mode.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Game mode (NOR-F11-04): CARGO_BUILD_JOBS=8 for both builds while the user is playing.
const env = cargoEnv();

function fail(message) {
  console.error(`desktop-build: ${message}`);
  process.exit(1);
}

/** Runs a command to its end with its output on this one's, and fails the build if it fails. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env, ...options });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with code ${result.status}`);
}

/** Runs a command and returns what it printed. */
function output(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with code ${result.status}`);
  return result.stdout;
}

const triple = hostTriple(output("rustc", ["-vV"]));

// 1. The daemon, in release mode, from the same workspace as the app.
run("cargo", ["build", "-p", "norend", "--release", "--locked"]);
const metadata = JSON.parse(output("cargo", ["metadata", "--no-deps", "--format-version", "1"]));
const built = join(metadata.target_directory, "release", norendFileName(triple));
if (!existsSync(built)) fail(`norend was built but ${built} is not there`);

// 2. The copy Tauri looks for, under the name with the triple.
const binaries = join(root, "apps", "desktop", "src-tauri", "binaries");
mkdirSync(binaries, { recursive: true });
const sidecar = join(binaries, sidecarFileName(triple));
copyFileSync(built, sidecar);
console.log(`desktop-build: ${built} -> ${sidecar}`);

// 3. The installers, with the extra configuration that names the sidecar and the install hooks.
const config = join(root, "apps", "desktop", "src-tauri", "tauri.bundle.conf.json");
if (!existsSync(config)) fail(`${config} is missing`);
const tauriArgs = [
  "--filter",
  "@noren/desktop",
  "exec",
  "tauri",
  "build",
  "--config",
  config,
  ...process.argv.slice(2),
];
// pnpm is a .cmd shim on Windows and Node refuses to spawn those without a shell. When started
// through `pnpm desktop:build`, npm_execpath points at pnpm's JS entry, which Node can run directly.
const pnpmEntry = process.env.npm_execpath;
if (pnpmEntry !== undefined && /\.c?js$/.test(pnpmEntry)) {
  run(process.execPath, [pnpmEntry, ...tauriArgs]);
} else {
  run("pnpm", tauriArgs, { shell: process.platform === "win32" });
}
