// Performance measurements that need no window (NOR-F11-01a): `node scripts/perf.mjs`.
//
// It runs, one after the other and on a machine that should be left alone while it works:
//   1. e2e/perf.spec.ts alone, one worker (throughput of the FakeBackend shell, the sidebar under a
//      50 MB output, the change of space), each repeated 5 times;
//   2. the `#[ignore]` tests of crates/noren-core/tests/perf_pty.rs in release mode (throughput of
//      the real PTY, through `SessionManager` and straight from `portable-pty`);
//   3. the real app (NOR-F11-01b, Windows): a release build without installer, then the hidden mode
//      `noren --smoke-perf` 5 times over a workspace of 1 tab (time to the first prompt) and 5
//      times over 30 tabs (memory of the process tree with the 30 shells alive), the runs
//      alternating. The window stays hidden; the memory is read with a PowerShell query of
//      the process list (no dependency).
// and prints the lines `docs/PERF.md` quotes. Nothing here opens a window or touches the keyboard.
//
// Options: --skip-e2e, --skip-pty, --skip-app, --only-app (the other two skipped), --no-build (use
// the release binary that is already there), --first-only (the runs of 1 tab only, no 30-tab memory
// runs; NOR-F11-01d, to compare two builds of the first prompt), --app-tabs <n> (the many-tabs side
// of the app runs opens n tabs, 2 to 100, instead of 30; NOR-F20-04). Environment: NOREN_PERF_BINARY (the
// `noren.exe` to run instead of target/release/noren.exe, with --no-build); NOREN_PERF_MB (size of the file the PTY
// prints, default 50), NOREN_PERF_REPS (repetitions of the PTY test and of the app, default 5),
// NOREN_PERF_PRODUCER (`type` or `cat`), NOREN_PERF_LINE_BYTES, NOREN_E2E_PORT (see docs/DEV.md).
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { summarize } from "../e2e/perf-stats.ts";
import {
  appSummary,
  launchTo,
  marksSince,
  parseAppTabs,
  processTree,
  resultWaitSeconds,
  sumMemory,
} from "./perf-app-lib.mjs";
import { refuseLocalTests } from "./local-tests.mjs";

if (process.env.NOREN_NO_LOCAL_TESTS === "1") refuseLocalTests();

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const args = new Set(process.argv.slice(2));
const onlyApp = args.has("--only-app");

function fail(message) {
  console.error(`perf: ${message}`);
  process.exit(1);
}

function run(command, commandArgs, env = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell: isWindows && command === "pnpm",
    env: { ...process.env, ...env },
  });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} exited with ${result.status}`);
}

if (!args.has("--skip-e2e") && !onlyApp) {
  const out = join(root, "test-results", "perf", "e2e.jsonl");
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });
  run("pnpm", ["--filter", "@noren/desktop", "build"]);
  run(
    "pnpm",
    ["exec", "playwright", "test", "-c", "e2e/playwright.config.ts", "perf.spec.ts", "--workers=1"],
    { NOREN_PERF_OUT: out },
  );
  if (!existsSync(out)) fail("the e2e run wrote no measurements");
  console.log("\n== e2e measurements (JSON, one per line) ==");
  console.log(readFileSync(out, "utf8").trim());
}

if (!args.has("--skip-pty") && !onlyApp) {
  console.log("\n== real PTY (the PERF lines below) ==");
  run("cargo", [
    "test",
    "-p",
    "noren-core",
    "--release",
    "--test",
    "perf_pty",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1",
  ]);
}

// ---- the real app (NOR-F11-01b) ----

/** Stops the measurement of the app by throwing, so the `finally` of a run still ends the app. */
function stop(message) {
  throw new Error(message);
}

const APP_REPS = Number(process.env.NOREN_PERF_REPS ?? 5);
// The many-tabs side of the app runs: 30 tabs, or `--app-tabs <n>` (NOR-F20-04: 100).
let MANY_TABS;
try {
  MANY_TABS = parseAppTabs(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const SETTLE_MS = 3000;
const MEMORY_SAMPLES = 3;
const MEMORY_GAP_MS = 1000;

/** Every process of the machine with its parent and its memory (PowerShell, no dependency). */
function listProcesses() {
  const script = [
    "$perf = @{}",
    "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = $_ }",
    "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; ws = [double]$_.WorkingSetSize; wsPrivate = [double]$perf[[int]$_.ProcessId].WorkingSetPrivate; created = $(if ($_.CreationDate) { [double]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) } } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    stop(`could not list the processes: ${result.error?.message ?? result.stderr}`);
  }
  return JSON.parse(result.stdout).map((p) => ({ ...p, wsPrivate: p.wsPrivate ?? 0 }));
}

/** Whether a `noren.exe` is alive now (the check that no run left the app open). */
function norenAlive() {
  const result = spawnSync("tasklist", ["/FI", "IMAGENAME eq noren.exe", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return (result.stdout ?? "").toLowerCase().includes("noren.exe");
}

function killTree(pid) {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

/** Waits for the result file of the run (or for the app to end first). */
async function waitForResult(out, child, seconds) {
  const until = Date.now() + seconds * 1000;
  while (!existsSync(out)) {
    if (child.exitCode !== null) stop(`the app ended with ${child.exitCode} before the result`);
    if (Date.now() > until) stop(`no result within ${seconds}s`);
    await sleep(50);
  }
  return JSON.parse(readFileSync(out, "utf8"));
}

/**
 * One run of `noren --smoke-perf` over `tabs` tabs: the app is launched, the script waits for the
 * report of the prompts, lets it settle, reads the memory of the tree three times a second apart,
 * tells the app to end and checks that nothing of it is left.
 */
async function runApp(binary, tabs) {
  const dir = mkdtempSync(join(tmpdir(), "noren-perf-app-"));
  const out = join(dir, "result.json");
  const launched = Date.now();
  const child = spawn(binary, ["--smoke-perf", "--perf-out", out, "--perf-tabs", String(tabs)], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
  });
  const exited = new Promise((done) => child.once("exit", done));
  try {
    const result = await waitForResult(out, child, resultWaitSeconds(tabs));
    if (result.error) stop(`the app reported: ${result.error}`);
    // The run prints "SMOKE focus never taken: <n> look(s)" (stdout is not read here); the count of
    // looks is in the result, and a result without it is a run that did not prove it (NOR-F1-08-b).
    if (!(result.focusLooks > 0)) stop("the app did not report that the focus was never taken");
    const prompts = result.promptsUnixMs.map((at) => launchTo(launched, at));
    await sleep(SETTLE_MS);
    const samples = [];
    let created = 0;
    for (let i = 0; i < MEMORY_SAMPLES; i++) {
      if (i > 0) await sleep(MEMORY_GAP_MS);
      const tree = processTree(result.pid, listProcesses());
      if (tree.length === 0) stop("the app is not among the processes");
      created = tree[0].created;
      samples.push(sumMemory(tree));
    }
    // The system's own record of when the process was created: the start the target talks about.
    const sincePrompts = result.promptsUnixMs.map((at) => launchTo(created, at));
    // Every mark of the app and of the page, in ms from the creation of the process (NOR-F11-01d).
    const marks = marksSince(created, result.marksUnixMs);
    const med = (list, pick) => summarize(list.map(pick)).median;
    writeFileSync(`${out}.done`, "done");
    const code = await Promise.race([exited, sleep(30_000).then(() => "timeout")]);
    if (code !== 0) stop(`the app ended with ${code}`);
    await sleep(500);
    if (norenAlive()) stop("noren.exe is still alive after the run");
    const workingSetMb = samples.map((s) => s.workingSetMb);
    const role = (name) => ({
      workingSetMb: med(samples, (s) => s.roles[name].workingSetMb),
      privateWorkingSetMb: med(samples, (s) => s.roles[name].privateWorkingSetMb),
    });
    return {
      tabs,
      // From the creation of the process (the target), from the launch in this script (the
      // creation call included, an upper bound), and from `main` in the app (without the loader,
      // a lower bound).
      firstPromptMs: Math.min(...sincePrompts),
      lastPromptMs: Math.max(...sincePrompts),
      firstPromptFromLaunchMs: Math.min(...prompts),
      firstPromptFromMainMs: result.firstPromptMs,
      marks,
      appReadyFromMainMs: result.appReadyMs,
      workingSetMb: summarize(workingSetMb).median,
      workingSetMbSamples: workingSetMb,
      privateWorkingSetMb: med(samples, (s) => s.privateWorkingSetMb),
      ownedPrivateWorkingSetMb: med(samples, (s) => s.ownedPrivateWorkingSetMb),
      roles: {
        noren: role("noren"),
        webview: role("webview"),
        consoles: role("consoles"),
        shells: role("shells"),
      },
      processes: samples.at(-1).processes,
      kinds: samples.at(-1).kinds,
    };
  } finally {
    if (child.exitCode === null) killTree(child.pid);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function measureApp() {
  if (!isWindows) {
    console.log("\n== real app: Windows only, skipped ==");
    return;
  }
  const binary = process.env.NOREN_PERF_BINARY ?? resolve(root, "target", "release", "noren.exe");
  if (!args.has("--no-build")) {
    console.log("\n== release build of the app (no installer) ==");
    run("pnpm", ["--filter", "@noren/desktop", "exec", "tauri", "build", "--no-bundle"]);
  }
  if (!existsSync(binary)) stop(`binary not found: ${binary}`);
  if (norenAlive()) stop("noren.exe is already running; close it first (this script never does)");
  const out = join(root, "test-results", "perf", "app.jsonl");
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });

  console.log("\n== real app: hidden `noren --smoke-perf`, release build ==");
  const first = [];
  const many = [];
  for (let rep = 1; rep <= APP_REPS; rep++) {
    const kinds = args.has("--first-only")
      ? [[1, first]]
      : [
          [1, first],
          [MANY_TABS, many],
        ];
    for (const [tabs, into] of kinds) {
      const entry = await runApp(binary, tabs);
      into.push(entry);
      const line = JSON.stringify({ name: `app-${tabs}-tabs`, rep, ...entry });
      console.log(`PERF app ${line}`);
      appendFileSync(out, `${line}\n`);
    }
  }
  const summary = appSummary(first, many, MANY_TABS, summarize);
  // Where the time goes: each mark of the runs, median over the repetitions (NOR-F11-01d). The
  // many-tabs runs are listed too (NOR-F20-14a), to see which step grows with the tabs.
  const r = (v) => Math.round(v * 10) / 10;
  for (const [label, name, runs] of [
    ["1 tab", "app-marks", first],
    [`${MANY_TABS} tabs`, "app-marks-many", many],
  ]) {
    if (runs.length === 0) continue;
    const markNames = [...new Set(runs.flatMap((entry) => Object.keys(entry.marks)))];
    const markRows = markNames
      .map((mark) => {
        const seen = runs.filter((entry) => mark in entry.marks).map((entry) => entry.marks[mark]);
        return { name: mark, ...summarize(seen) };
      })
      .sort((a, b) => a.median - b.median);
    console.log(`\n== real app: marks, ${label} (ms from process creation) ==`);
    for (const row of markRows) {
      console.log(
        `${row.name}: median ${r(row.median)}, min ${r(row.min)}, max ${r(row.max)}, n ${row.n}`,
      );
    }
    appendFileSync(out, `${JSON.stringify({ name, marks: markRows })}\n`);
  }
  console.log("\n== real app: summary (median, min, max) ==");
  for (const [name, s] of Object.entries(summary)) {
    console.log(`${name}: median ${r(s.median)}, min ${r(s.min)}, max ${r(s.max)}, n ${s.n}`);
  }
  appendFileSync(out, `${JSON.stringify({ name: "app-summary", summary })}\n`);
}

if (!args.has("--skip-app")) {
  await measureApp().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
