// Builds the portable copy (`pnpm desktop:portable`): a folder, `dist-portable/Noren/`, and a zip of
// it, `dist-portable/Noren-portable.zip`, made from the release build and without any installer.
//
// The folder holds what the app reads from the disk when it runs from any place:
// - `noren.exe`, the app, with the interface inside it;
// - `norend.exe`, the session daemon, which the app looks for next to itself (`daemon_link.rs`);
// - `resources/shell-integration/**`, the shell scripts, which the app resolves as resources; on
//   Windows that base is the folder of the program, so the structure is the one under
//   `target/release/resources/`.
// Nothing in it writes to the registry when it opens: the `noren://` link is only declared in
// `tauri.conf.json` for the installers.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostTriple, norendFileName } from "./desktop-build-lib.mjs";
import { cargoEnv } from "./game-mode.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Cargo ceiling (NOR-F20-22): CARGO_BUILD_JOBS=8 for both builds, 4 while the user is playing.
const env = cargoEnv();

function fail(message) {
  console.error(`desktop-portable: ${message}`);
  process.exit(1);
}

/** Runs a command to its end with its output on this one's, and fails if it fails. */
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

/** Every file under `dir`, as paths relative to it with `/` separators. */
function filesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    found.push(relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"));
  }
  return found.sort();
}

const isWindows = process.platform === "win32";
const triple = hostTriple(output("rustc", ["-vV"]));
const appName = isWindows ? "noren.exe" : "noren";
const daemonName = norendFileName(triple);

// 1. The daemon, in release mode, from the same workspace as the app.
run("cargo", ["build", "-p", "norend", "--release", "--locked"]);

// 2. The app in release mode, without installers: the program and its resources next to it.
const tauriArgs = ["--filter", "@noren/desktop", "exec", "tauri", "build", "--no-bundle"];
// pnpm is a .cmd shim on Windows and Node refuses to spawn those without a shell. When started
// through `pnpm desktop:portable`, npm_execpath points at pnpm's JS entry, which Node can run directly.
const pnpmEntry = process.env.npm_execpath;
if (pnpmEntry !== undefined && /\.c?js$/.test(pnpmEntry)) {
  run(process.execPath, [pnpmEntry, ...tauriArgs]);
} else {
  run("pnpm", tauriArgs, { shell: isWindows });
}

// 3. Everything must be where the build leaves it before the folder is touched.
const metadata = JSON.parse(output("cargo", ["metadata", "--no-deps", "--format-version", "1"]));
const release = join(metadata.target_directory, "release");
const resources = join(release, "resources", "shell-integration");
const programs = [appName, daemonName].map((name) => join(release, name));
const missing = programs.filter((file) => !existsSync(file));
if (!existsSync(resources)) missing.push(resources);
if (missing.length > 0) fail(`the release build did not leave: ${missing.join(", ")}`);
const scripts = filesUnder(resources);
if (scripts.length === 0) fail(`${resources} has no files`);

// 4. The folder, recreated from scratch, and the zip of it.
const out = join(root, "dist-portable");
const folder = join(out, "Noren");
rmSync(out, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
for (const file of programs) copyFileSync(file, join(folder, file.slice(release.length + 1)));
for (const file of scripts) {
  const target = join(folder, "resources", "shell-integration", file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(resources, file), target);
}

const zip = join(out, "Noren-portable.zip");
// `tar -a -c -f x.zip` writes a zip with the bsdtar that Windows ships; the Git Bash `tar` earlier in
// PATH is GNU tar and cannot, so the system one is named.
const tar = isWindows
  ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";
run(tar, ["-a", "-c", "-f", zip, "-C", out, "Noren"]);
if (!existsSync(zip)) fail(`the zip was not made: ${zip}`);

for (const file of filesUnder(folder)) {
  console.log(`desktop-portable: ${file} (${statSync(join(folder, file)).size} bytes)`);
}
console.log(`desktop-portable: ${folder}`);
console.log(`desktop-portable: ${zip} (${statSync(zip).size} bytes)`);
