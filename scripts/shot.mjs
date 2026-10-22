// `pnpm shot` (NOR-F20-05, D22 item 1): pictures of the real app. It builds the debug app like
// `pnpm smoke` does, then runs `noren --smoke-shot <png>` once per picture. Each run draws the main
// window out of sight (outside every monitor, with no focus, off the taskbar and Alt+Tab, shown
// without activating it), asks its own web view for the PNG, checks that the window never had the
// focus and that the foreground window of the system did not change, and quits. Nothing is started
// with a window of its own, no key or mouse is sent, no desktop is captured and no debugging port is
// opened. See docs/DEV.md ("Pictures of the real app").
//
//   pnpm shot [--out <dir>] [--prefix <text>] [--no-build]
//   pnpm shot [--settings <file>] [--live-settings <file>] [--image <file>] [--name <name>]
//             [--out <dir>] [--prefix <text>]
//
// Without `--settings` or `--image` two pictures are made, `<prefix>default.png` (the window as it
// starts) and `<prefix>background.png` (a picture behind the terminals and an interface that lets it
// through, the settings written while the app runs, as the settings screen writes them). With
// `--settings` (the file the app starts with), `--live-settings` (written once it is up) or
// `--image`, one picture of that window, `<prefix><name>.png` (`custom` by default); the settings are
// `config.jsonc` of the run (a picture is `backgrounds/<its name>` there). A picture that was asked
// for and is not on screen fails the run, after its PNG is written. The files go to `--out`
// (`target/shots` by default).
//
// It refuses to run, with exit code 3 and before it builds anything, while the signal of game mode
// exists (D:/Projetos/.modo-jogo, any age; NOREN_MODO_JOGO_ARQUIVO names another file, D20). Any
// other failure exits with 1.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoEnv } from "./game-mode.mjs";
import {
  BACKGROUND_FILE,
  BUILTIN_SCENARIOS,
  REFUSED_EXIT_CODE,
  appArgs,
  backgroundPng,
  backgroundSettings,
  daemonPids,
  isCustom,
  missingLines,
  outputName,
  parseArgs,
  refusal,
  requiredLines,
  waitForExit,
} from "./shot-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

/** The folder of the files a run makes for the app (settings, picture); set once it exists. */
let work;

function fail(message, code = 1) {
  console.error(`shot: ${message}`);
  // `process.exit` skips the `finally` of the run, so the folder goes here too.
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
  process.exit(code);
}

// The first thing, before the arguments are read and before anything is built.
const refused = refusal();
if (refused !== null) fail(`refused: ${refused}`, REFUSED_EXIT_CODE);

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 2);
}
if (!isWindows) fail("the picture comes from WebView2, so pnpm shot runs on Windows only");

const buildEnv = cargoEnv();
if (args.build) {
  // Same build as `pnpm smoke`: the interface is built and embedded, so a picture shows the code of now.
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
    ? spawnSync(process.execPath, [pnpmEntry, ...buildArgs], {
        cwd: root,
        stdio: "inherit",
        env: buildEnv,
      })
    : spawnSync("pnpm", buildArgs, {
        cwd: root,
        stdio: "inherit",
        shell: isWindows,
        env: buildEnv,
      });
  if (build.error) fail(`could not run the build: ${build.error.message}`);
  if (build.status !== 0) fail(`build failed with exit code ${build.status}`);
  // The session daemon, next to the app, where the app looks for it.
  const buildDaemon = spawnSync("cargo", ["build", "-p", "norend"], {
    cwd: root,
    stdio: "inherit",
    env: buildEnv,
  });
  if (buildDaemon.error) fail(`could not run cargo: ${buildDaemon.error.message}`);
  if (buildDaemon.status !== 0) fail(`building norend failed with exit code ${buildDaemon.status}`);
}

const binary = resolve(root, "target", "debug", "noren.exe");
const daemonBinary = resolve(root, "target", "debug", "norend.exe");
for (const file of [binary, daemonBinary]) {
  if (!existsSync(file))
    fail(`binary not found: ${file}${args.build ? "" : " (run without --no-build)"}`);
}

const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });
work = mkdtempSync(join(tmpdir(), "noren shot "));

/** What to draw: the windows asked for, each with the files it needs made. */
function scenarios() {
  if (isCustom(args)) {
    const path = (file) => (file === undefined ? undefined : resolve(file));
    return [
      {
        name: args.name ?? "custom",
        settings: path(args.settings),
        liveSettings: path(args.liveSettings),
        image: path(args.image),
        picture: args.image !== undefined,
      },
    ];
  }
  return BUILTIN_SCENARIOS.map((scenario) => {
    if (!scenario.picture) return { name: scenario.name, picture: false };
    const settings = join(work, "background.jsonc");
    const image = join(work, BACKGROUND_FILE);
    writeFileSync(settings, backgroundSettings());
    writeFileSync(image, backgroundPng());
    return {
      name: scenario.name,
      picture: true,
      settings: scenario.live ? undefined : settings,
      liveSettings: scenario.live ? settings : undefined,
      image,
    };
  });
}

/** Ends the daemons a run said it started that are still alive; returns their pids. */
function leftoverDaemons(stdout) {
  const left = [];
  for (const pid of daemonPids(stdout)) {
    if (waitForExit(pid, 5_000)) continue;
    left.push(pid);
    try {
      process.kill(pid);
    } catch {
      // It ended meanwhile.
    }
  }
  return left;
}

/** One picture. Returns the line that says what was written. */
function shoot(scenario) {
  const out = join(outDir, outputName(args.prefix, scenario.name));
  rmSync(out, { force: true });
  const run = spawnSync(
    binary,
    appArgs(out, scenario.settings, scenario.liveSettings, scenario.image),
    {
      cwd: root,
      encoding: "utf8",
      timeout: 90_000,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  );
  const stdout = run.stdout ?? "";
  // Whatever the outcome, a daemon of the run must not stay alive.
  const left = leftoverDaemons(stdout);
  process.stdout.write(stdout);
  process.stderr.write(run.stderr ?? "");
  if (run.error) fail(`could not run ${binary}: ${run.error.message}`);
  if (left.length > 0) fail(`norend ${left.join(", ")} was still alive after noren --smoke-shot`);
  if (run.status === REFUSED_EXIT_CODE) fail("noren refused: game mode is on", REFUSED_EXIT_CODE);
  if (run.status !== 0)
    fail(`noren --smoke-shot exited with code ${run.status} (${scenario.name})`);
  const missing = missingLines(stdout, requiredLines(scenario.picture));
  if (missing.length > 0)
    fail(`not found in the output of ${scenario.name}: ${missing.join("; ")}`);
  if (!existsSync(out)) fail(`${out} was not written`);
  return `${out} (${statSync(out).size} bytes)`;
}

const written = [];
try {
  for (const scenario of scenarios()) written.push(shoot(scenario));
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`shot: wrote ${written.length} picture(s):`);
for (const line of written) console.log(`  ${line}`);
