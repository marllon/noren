// Real-app smoke test: debug build without bundle, then `noren --smoke`, `noren --smoke-deeplink` and
// `noren --smoke-quick`.
// Exits with the app's exit code. The first run must print "SMOKE OK" and "noren-smoke-ok" (printed
// after a real shell session echoed it), "SMOKE window effect ..." (the line of the effect the
// hidden window was given, Mica on Windows and vibrancy on macOS: the effect applied, or the opaque
// fallback with the reason, since a system that cannot paint it still passes) and "SMOKE window
// hidden" (the main window stayed hidden); the second must print "SMOKE DEEPLINK OK" (a
// noren://open link reached the interface and the space on screen has the folder of the link) and
// "SMOKE window hidden"; the third must print "SMOKE QUICK OK" (the quick window was made hidden,
// frameless and at the top of the screen; a shell opened in it was promoted to the main window as a
// tab with the same session id and the same process, still answering, its output now reaching the
// main window), "SMOKE quick window hidden" and "SMOKE window hidden" (neither window ever shown).
// Every run must also print "SMOKE global shortcut none registered": no smoke mode registers the
// global shortcut of the quick terminal (the run fails if the app holds one).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** Runs the binary in a hidden smoke mode and requires every text in `required` on stdout. */
function runSmoke(args, required) {
  const run = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  if (run.error) fail(`could not run ${binary}: ${run.error.message}`);

  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");

  if (run.status !== 0) fail(`noren ${args[0]} exited with code ${run.status}`);
  const stdout = run.stdout ?? "";
  for (const text of required) {
    if (!stdout.includes(text)) fail(`${text} not found in the output of noren ${args[0]}`);
  }
}

// The effect asked for is the one of the system the run is on (see smoke_effect in smoke.rs).
const effect = isWindows ? "mica" : process.platform === "darwin" ? "vibrancy" : "none";
runSmoke(
  ["--smoke"],
  [
    "SMOKE window hidden",
    "SMOKE global shortcut none registered",
    "SMOKE OK",
    "noren-smoke-ok",
    `SMOKE window effect ${effect}`,
  ],
);

// The deep-link run: a folder made here (its name has a space) goes in a noren://open link, and the
// app must end up showing a space that has that folder. It keeps its state in a folder of its own.
const folder = mkdtempSync(join(tmpdir(), "noren smoke "));
try {
  const link = `noren://open?path=${encodeURIComponent(folder)}`;
  runSmoke(
    ["--smoke-deeplink", link],
    ["SMOKE window hidden", "SMOKE global shortcut none registered", "SMOKE DEEPLINK OK"],
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}
// The quick run keeps its files in a folder of its own, made and removed by the app.
runSmoke(
  ["--smoke-quick"],
  [
    "SMOKE quick window hidden",
    "SMOKE global shortcut none registered",
    "opened in the quick window",
    "promoted to the main window",
    "still alive after the promotion",
    "SMOKE window hidden",
    "SMOKE QUICK OK",
  ],
);
process.exit(0);
