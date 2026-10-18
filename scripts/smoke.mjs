// Real-app smoke test: debug build without bundle, then `noren --smoke`.
// Exits with the app's exit code; requires "SMOKE OK" and "noren-smoke-ok" (printed after a real
// shell session echoed it) and "SMOKE window hidden" (the main window stayed hidden) on stdout.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

function fail(message) {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

// pnpm is a .cmd shim on Windows and Node refuses to spawn those without a shell. When started
// through `pnpm smoke`, npm_execpath points at pnpm's JS entry, which Node can run directly.
const pnpmEntry = process.env.npm_execpath;
const runPnpmWithNode = pnpmEntry !== undefined && /\.c?js$/.test(pnpmEntry);
const buildArgs = [
  "--filter",
  "@noren/desktop",
  "exec",
  "tauri",
  "build",
  "--debug",
  "--no-bundle",
];
const build = runPnpmWithNode
  ? spawnSync(process.execPath, [pnpmEntry, ...buildArgs], { cwd: root, stdio: "inherit" })
  : spawnSync("pnpm", buildArgs, { cwd: root, stdio: "inherit", shell: isWindows });
if (build.error) fail(`could not run the build: ${build.error.message}`);
if (build.status !== 0) fail(`build failed with exit code ${build.status}`);

const binary = resolve(root, "target", "debug", isWindows ? "noren.exe" : "noren");
if (!existsSync(binary)) fail(`binary not found: ${binary}`);

const run = spawnSync(binary, ["--smoke"], {
  cwd: root,
  encoding: "utf8",
  timeout: 60_000,
  killSignal: "SIGKILL",
});
if (run.error) fail(`could not run ${binary}: ${run.error.message}`);

process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");

if (run.status !== 0) fail(`noren --smoke exited with code ${run.status}`);
const stdout = run.stdout ?? "";
if (!stdout.includes("SMOKE window hidden")) fail("SMOKE window hidden not found in the output");
if (!stdout.includes("SMOKE OK")) fail("SMOKE OK not found in the output");
if (!stdout.includes("noren-smoke-ok")) fail("noren-smoke-ok not found in the output");
process.exit(0);
