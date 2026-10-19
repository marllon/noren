// Performance measurements that need no window (NOR-F11-01a): `node scripts/perf.mjs`.
//
// It runs, one after the other and on a machine that should be left alone while it works:
//   1. e2e/perf.spec.ts alone, one worker (throughput of the FakeBackend shell, the sidebar under a
//      50 MB output, the change of space), each repeated 5 times;
//   2. the `#[ignore]` tests of crates/noren-core/tests/perf_pty.rs in release mode (throughput of
//      the real PTY, through `SessionManager` and straight from `portable-pty`).
// and prints the lines `docs/PERF.md` quotes. Nothing here opens a window or touches the keyboard.
//
// Options: --skip-e2e, --skip-pty. Environment: NOREN_PERF_MB (size of the file the PTY prints,
// default 50), NOREN_PERF_REPS (repetitions of the PTY test, default 5), NOREN_PERF_PRODUCER
// (`type` or `cat`), NOREN_PERF_LINE_BYTES, NOREN_E2E_PORT (see docs/DEV.md).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const args = new Set(process.argv.slice(2));

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

if (!args.has("--skip-e2e")) {
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

if (!args.has("--skip-pty")) {
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
