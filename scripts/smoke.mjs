// Real-app smoke test: debug build without bundle, then `noren --smoke`, `noren --smoke-deeplink`,
// `noren --smoke-quick`, `noren --smoke-window` and `noren --smoke-api`.
// Exits with the app's exit code. The first run must print "SMOKE OK" and "noren-smoke-ok" (printed
// after a real shell session echoed it), "SMOKE window effect ..." (the line of the effect the
// hidden window was given, Mica on Windows and vibrancy on macOS: the effect applied, or the opaque
// fallback with the reason, since a system that cannot paint it still passes), "SMOKE browser pane
// loaded <url>" (a browser pane, a web view inside the hidden main window, loaded a page from a
// server of the run on 127.0.0.1; the page sees no test hook, is refused every command of the app and
// stays put when it tries to go to an address of the app, NOR-F15-01a) and "SMOKE window hidden"
// (the main window stayed hidden); the second must print "SMOKE DEEPLINK OK" (a
// noren://open link reached the interface and the space on screen has the folder of the link) and
// "SMOKE window hidden"; the third must print "SMOKE QUICK OK" (the quick window was made hidden,
// frameless and at the top of the screen; a shell opened in it was promoted to the main window as a
// tab with the same session id and the same process, still answering, its output now reaching the
// main window), "SMOKE quick window hidden" and "SMOKE window hidden" (neither window ever shown);
// the fourth must print "SMOKE WINDOW OK" (a second window was made hidden and its page came up, was
// refused every command that owns or changes the workspace, stayed on its page when taken to a web
// page, and a shell that was running was moved to it: the same session id and the same shell process,
// nothing started or ended, its output now reaching the second window and no longer the old channel;
// a window the app closes leaves the shell alone and one the person closes is reported, NOR-F15-04a;
// the page of the window also draws the space the main window sends it, its sidebar with its tab and
// a terminal for the session, and a click on the tab reaches the main window as a request, NOR-F15-04b;
// so does a click on New tab, and the terminal of the window starts with what the shell printed before
// the move, which the daemon kept, NOR-F15-04c; a browser pane shown by the window has its web view
// opened as a child of that hidden window, on a page of the run that reaches nothing of the app and
// stays put when it tries to go to an address of the app, and the web view goes with the window
// when the app closes it, NOR-F15-04e).
// the fifth must print "SMOKE API OK" (a client of the local API, with the token the app keeps in a file
// of the run and the endpoint of the run, was refused with a wrong token, was welcomed with the right
// one and made real calls that went through the server, the bridge, the hidden main page and back:
// spaces.list, spaces.create and spaces.list again, which shows the new space; no call types into a
// terminal, so none sends an Enter, NOR-F17-01d; a second connection subscribed to terminal.output,
// made a tab with items.create and heard the prompt of its own shell as an event of that session,
// NOR-F17-01f; that tab's session came in the answer of items.create and in spaces.list, and a notify
// under settings that turn the notifications off answered shown=false, NOR-F17-02a).
// Every run must also print "SMOKE global shortcut none registered": no smoke mode registers the
// global shortcut of the quick terminal (the run fails if the app holds one), and "SMOKE tray icon
// none": no smoke mode shows the tray icon of a normal start (NOR-F14-02c).
// The sessions of every run live in `norend`, the session daemon, which the app starts from beside
// its own executable on an endpoint named for the run (so it never meets the daemon of the user):
// this script builds `norend` first, and every run must print "SMOKE DAEMON norend pid <n> ..."
// (the session of the run was a child of that process, not of the app) and "SMOKE DAEMON stopped
// norend pid <n> ..." (the run asked it to stop and it ended with code 0). After each run the pid
// is checked here too, and a daemon of the run that is still alive is ended and fails the smoke.
// The runs `--smoke` and `--smoke-deeplink`, which open the first shell of the default profile with no
// folder, must also print "SMOKE first shell cwd: <folder>" before their OK line (NOR-F20-06): the
// folder that shell opened in, which has to be the folder of the user (read here from the system,
// not from the app) and never the folder of the process, which is where the app was started.
// Every run, of every mode, must also print "SMOKE focus never taken: <n> look(s) ..." before its OK
// line (NOR-F1-08-b): a thread looks at the foreground window of the system from the first
// instruction of the program and the run fails if a window of the program was ever in front, so a
// smoke run never takes the focus from whoever is playing. The windows of a run are made quiet (no
// focus at birth, not focusable, off the taskbar); `docs/DEV.md` has the details.
// The persistence run (`--smoke-persist`, NOR-F14-02b) is two runs of the app on one daemon and one
// folder of their own: the first starts a shell for a pane and leaves without ending it, the second
// takes the shell back and must find the same process, still answering. This script checks from the
// outside what each run says (the shell and the daemon are alive between the two, and the daemon, the
// shell and both apps are gone after the second) and ends a daemon of the pair that is still alive.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoEnv } from "./game-mode.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

function fail(message) {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

// pnpm is a .cmd shim on Windows and Node refuses to spawn those without a shell. When started
// through `pnpm smoke`, npm_execpath points at pnpm's JS entry, which Node can run directly.
const pnpmEntry = process.env.npm_execpath;
// Cargo ceiling (NOR-F20-22): CARGO_BUILD_JOBS=8 for both cargo builds, 4 while the user is playing.
const buildEnv = cargoEnv();
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
  : spawnSync("pnpm", buildArgs, { cwd: root, stdio: "inherit", shell: isWindows, env: buildEnv });
if (build.error) fail(`could not run the build: ${build.error.message}`);
if (build.status !== 0) fail(`build failed with exit code ${build.status}`);

const binary = resolve(root, "target", "debug", isWindows ? "noren.exe" : "noren");
if (!existsSync(binary)) fail(`binary not found: ${binary}`);

// The session daemon, built in the same profile, so it sits next to the app (where the app looks).
const buildDaemon = spawnSync("cargo", ["build", "-p", "norend"], {
  cwd: root,
  stdio: "inherit",
  env: buildEnv,
});
if (buildDaemon.error) fail(`could not run cargo: ${buildDaemon.error.message}`);
if (buildDaemon.status !== 0) fail(`building norend failed with exit code ${buildDaemon.status}`);
const daemonBinary = resolve(root, "target", "debug", isWindows ? "norend.exe" : "norend");
if (!existsSync(daemonBinary)) fail(`binary not found: ${daemonBinary}`);

/** Whether a process with this pid is running. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // No permission to signal it still means it exists.
    return error.code === "EPERM";
  }
}

/** Waits up to `ms` for the process to end. */
function waitForExit(pid, ms) {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return !alive(pid);
}

/**
 * The daemons a run said it started, from its output. One that is still alive is ended (a run that
 * was cut short leaves one behind) and reported.
 */
function leftoverDaemons(stdout) {
  const left = [];
  for (const match of stdout.matchAll(/SMOKE DAEMON norend pid (\d+)/g)) {
    const pid = Number(match[1]);
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

const FOCUS_LINE = "SMOKE focus never taken:";

/**
 * Requires the line of the watch on the foreground window in the output of a run, and before the OK
 * line of the run when it has one: the proof that the run never took the focus of the system.
 */
function requireFocusLine(stdout, mode) {
  const at = stdout.indexOf(FOCUS_LINE);
  if (at < 0) fail(`${FOCUS_LINE} not found in the output of noren ${mode}`);
  const ok = /^SMOKE (?:[A-Z]+ )?OK\b/m.exec(stdout);
  if (ok !== null && ok.index < at) {
    fail(`${FOCUS_LINE} came after the OK line in the output of noren ${mode}`);
  }
}

const FIRST_SHELL_LINE = "SMOKE first shell cwd:";

/** The same folder, whatever the separator, a trailing one or (on Windows) the case. */
function sameFolder(a, b) {
  const key = (path) => {
    const text = path.replaceAll("\\", "/").replace(/\/+$/, "");
    return isWindows ? text.toLowerCase() : text;
  };
  return key(a) === key(b);
}

/**
 * Requires the line with the folder the first shell opened in, before the OK line of the run, and
 * that folder to be the folder of the user as this script sees it. The run itself already fails when
 * the shell is in the folder of the process; this is the check from the outside.
 */
function requireFirstShellFolder(stdout, mode) {
  const line = new RegExp(`^${FIRST_SHELL_LINE} (.+)$`, "m").exec(stdout);
  if (line === null) fail(`${FIRST_SHELL_LINE} not found in the output of noren ${mode}`);
  const ok = /^SMOKE (?:[A-Z]+ )?OK\b/m.exec(stdout);
  if (ok !== null && ok.index < line.index) {
    fail(`${FIRST_SHELL_LINE} came after the OK line in the output of noren ${mode}`);
  }
  const folder = line[1].trim();
  const user = homedir();
  if (!sameFolder(folder, user)) {
    fail(
      `the first shell of noren ${mode} opened in ${folder}, not in the folder of the user ${user}`,
    );
  }
}

/** Runs the binary in a hidden smoke mode and requires every text in `required` on stdout. */
function runSmoke(args, required, { firstShell = false } = {}) {
  const run = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const stdout = run.stdout ?? "";
  // Whatever the outcome, a daemon of the run must not stay alive.
  const left = leftoverDaemons(stdout);
  if (run.error) fail(`could not run ${binary}: ${run.error.message}`);

  process.stdout.write(stdout);
  process.stderr.write(run.stderr ?? "");

  if (left.length > 0) fail(`norend ${left.join(", ")} was still alive after noren ${args[0]}`);
  if (run.status !== 0) fail(`noren ${args[0]} exited with code ${run.status}`);
  for (const text of [...required, "SMOKE DAEMON norend pid", "SMOKE DAEMON stopped norend pid"]) {
    if (!stdout.includes(text)) fail(`${text} not found in the output of noren ${args[0]}`);
  }
  requireFocusLine(stdout, args[0]);
  if (firstShell) requireFirstShellFolder(stdout, args[0]);
}

// The effect asked for is the one of the system the run is on (see smoke_effect in smoke.rs).
const effect = isWindows ? "mica" : process.platform === "darwin" ? "vibrancy" : "none";
runSmoke(
  ["--smoke"],
  [
    "SMOKE window hidden",
    "SMOKE global shortcut none registered",
    "SMOKE tray icon none",
    "SMOKE OK",
    "noren-smoke-ok",
    `SMOKE window effect ${effect}`,
    // The browser pane (NOR-F15-01a): a web view in the hidden window loaded a page from a server
    // of the run on 127.0.0.1, which saw nothing of the app and stayed where it was.
    "SMOKE browser pane loaded http://127.0.0.1:",
    "SMOKE browser pane stayed on its page",
    "SMOKE browser pane refused file, javascript, data, noren and app addresses",
    "SMOKE browser pane closed",
  ],
  { firstShell: true },
);

// The deep-link run: a folder made here (its name has a space) goes in a noren://open link, and the
// app must end up showing a space that has that folder. It keeps its state in a folder of its own.
const folder = mkdtempSync(join(tmpdir(), "noren smoke "));
try {
  const link = `noren://open?path=${encodeURIComponent(folder)}`;
  runSmoke(
    ["--smoke-deeplink", link],
    [
      "SMOKE window hidden",
      "SMOKE global shortcut none registered",
      "SMOKE tray icon none",
      "SMOKE DEEPLINK OK",
    ],
    { firstShell: true },
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
    "SMOKE tray icon none",
    "opened in the quick window",
    "promoted to the main window",
    "still alive after the promotion",
    "SMOKE window hidden",
    "SMOKE QUICK OK",
  ],
);

// The window run (NOR-F15-04a) keeps its files in a folder of its own, made and removed by the app. A
// second window is made hidden, a running shell is moved to it, and both windows stay hidden.
runSmoke(
  ["--smoke-window"],
  [
    "SMOKE global shortcut none registered",
    "SMOKE tray icon none",
    "SMOKE second window window-smoke-window-1 created for space smoke-space, hidden, its page is up",
    "SMOKE second window refused 16 commands",
    "SMOKE second window stayed on its page",
    "opened as the tab to move",
    "moved to the second window",
    "output printed before the move reached the second window (replay)",
    "still alive after the move, same shell pid",
    "SMOKE second window drew the space it was sent: its sidebar with its tab and a terminal for the session it was given",
    "SMOKE second window asked the main window to show its tab (window-action)",
    "SMOKE second window asked the main window for a new tab (window-action)",
    "SMOKE second window hidden",
    "SMOKE browser pane in window-smoke-window-1 loaded http://127.0.0.1:",
    "SMOKE browser pane in window-smoke-window-1 is a child of window-smoke-window-1, hidden",
    "SMOKE browser pane in window-smoke-window-1 stayed on its page",
    "SMOKE browser pane in window-smoke-window-1 moved to the bounds it was given",
    "SMOKE browser pane in window-smoke-window-1 went with its window, no web view left",
    "SMOKE second window closed by the app, session",
    "SMOKE a window closed by the person was reported as closed",
    "SMOKE window hidden",
    "SMOKE WINDOW OK",
  ],
);

// The API run (NOR-F17-01d) keeps its files in a folder of its own, made and removed by the app. A
// client of the local API makes real calls to the hidden window: list the spaces, make one, list again.
runSmoke(
  ["--smoke-api"],
  [
    "SMOKE API listening on",
    "SMOKE global shortcut none registered",
    "SMOKE tray icon none",
    "SMOKE API a wrong token was refused (unauthorized), connection closed",
    "SMOKE API authenticated with the token of the run, welcome version 1",
    "SMOKE API spaces.list answered by the page:",
    "SMOKE API spaces.create made",
    "SMOKE API spaces.list shows the new space",
    "SMOKE API items.create answered terminal",
    "SMOKE API spaces.list gives session",
    "SMOKE API notify answered shown=false",
    "SMOKE API terminal.output received for session",
    "SMOKE window hidden",
    "SMOKE API OK",
  ],
);

/** A failed check of the persistence run: thrown, so the clean-up of `persistCheck` always runs. */
function problem(message) {
  throw new Error(message);
}

/**
 * One run of `--smoke-persist`. Its output goes to a file, not a pipe: the first run leaves the
 * daemon alive on purpose, and a daemon that inherited the pipe would keep it open after the app
 * ended (the reader would wait for it).
 */
function runPersist(role, endpoint, folder, logFile, required) {
  const log = openSync(logFile, "w");
  let run;
  try {
    run = spawnSync(binary, ["--smoke-persist", role, endpoint, folder], {
      cwd: root,
      stdio: ["ignore", log, log],
      timeout: 90_000,
      killSignal: "SIGKILL",
    });
  } finally {
    closeSync(log);
  }
  const text = readFileSync(logFile, "utf8");
  process.stdout.write(text);
  if (run.error) problem(`could not run ${binary}: ${run.error.message}`);
  if (run.status !== 0) problem(`noren --smoke-persist ${role} exited with code ${run.status}`);
  for (const wanted of [...required, FOCUS_LINE]) {
    if (!text.includes(wanted))
      problem(`${wanted} not found in the output of noren --smoke-persist ${role}`);
  }
  const ok = /^SMOKE (?:[A-Z]+ )?OK\b/m.exec(text);
  if (ok !== null && ok.index < text.indexOf(FOCUS_LINE))
    problem(`${FOCUS_LINE} came after the OK line in the output of noren --smoke-persist ${role}`);
  return text;
}

/** The first number captured by `pattern` in `text`, or a failure that says which line is missing. */
function pidFrom(text, pattern, what) {
  const match = pattern.exec(text);
  if (match === null) problem(`could not read ${what} from the output`);
  return Number(match[1]);
}

function persistCheck() {
  const folder = mkdtempSync(join(tmpdir(), "noren smoke persist "));
  const logs = mkdtempSync(join(tmpdir(), "noren smoke persist logs "));
  const endpoint = `smoke-persist-${process.pid}-${Date.now()}`;
  const common = [
    "SMOKE window hidden",
    "SMOKE global shortcut none registered",
    "SMOKE tray icon none",
  ];
  let norend;
  let failed = true;
  try {
    // A saved workspace of one pane, so the interface of each run restores a pane of its own.
    copyFileSync(join(root, "scripts", "smoke-persist-state.json"), join(folder, "state.json"));
    const first = runPersist("first", endpoint, folder, join(logs, "first.log"), [
      ...common,
      "SMOKE PERSIST daemon norend pid",
      "SMOKE PERSIST first run: shell pid",
    ]);
    norend = pidFrom(first, /SMOKE PERSIST daemon norend pid (\d+)/, "the pid of norend");
    const shell = pidFrom(first, /first run: shell pid (\d+)/, "the pid of the shell");
    const firstApp = pidFrom(first, /the app is pid (\d+)\)/, "the pid of the first app");

    // The app is gone, and the daemon and the shell it started are not.
    if (alive(firstApp)) problem(`the first app, pid ${firstApp}, is still running`);
    if (!alive(norend)) problem(`norend ${norend} did not survive the first app`);
    if (!alive(shell)) problem(`the shell ${shell} did not survive the first app`);

    const second = runPersist("second", endpoint, folder, join(logs, "second.log"), [
      ...common,
      "SMOKE PERSIST same shell pid",
      "SMOKE PERSIST page pane: the interface took back its shell too",
      "SMOKE PERSIST orphans ended: 1",
      "SMOKE PERSIST stopped norend pid",
      "SMOKE PERSIST OK",
    ]);
    const before = pidFrom(second, /same shell pid (\d+) before/, "the first pid of the shell");
    const after = pidFrom(second, /closing the app and (\d+) after/, "the second pid of the shell");
    if (before !== shell || after !== shell) {
      problem(`the shell was ${shell}, then ${before} and ${after}: not the same process`);
    }

    // After the second run nothing of the pair is left: the daemon, the shell, the apps.
    const apps = /apps (\d+) and (\d+)/.exec(second);
    if (apps === null) problem("could not read the pids of the two apps from the output");
    for (const app of [Number(apps[1]), Number(apps[2])]) {
      if (!waitForExit(app, 10_000)) problem(`the app, pid ${app}, was still alive after its run`);
    }
    if (!waitForExit(norend, 10_000))
      problem(`norend ${norend} was still alive after the second run`);
    if (!waitForExit(shell, 10_000))
      problem(`the shell ${shell} was still alive after the second run`);
    failed = false;
  } finally {
    if (norend !== undefined && alive(norend)) {
      try {
        process.kill(norend);
      } catch {
        // It ended meanwhile.
      }
      if (!failed) problem(`norend ${norend} was left running`);
    }
    rmSync(folder, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
  }
}
try {
  persistCheck();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
process.exit(0);
