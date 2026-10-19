// Run with `node --test scripts/perf-app-lib.test.mjs` (the vitest of `pnpm verify` only reads
// packages/ and apps/).
import assert from "node:assert/strict";
import { test } from "node:test";
import { median } from "../e2e/perf-stats.ts";
import { launchTo, processTree, sumMemory } from "./perf-app-lib.mjs";

const MB = 1024 * 1024;
const proc = (pid, ppid, name, ws = MB, wsPrivate = MB / 2) => ({ pid, ppid, name, ws, wsPrivate });

test("the tree holds the app, the web view below it and the shells, and nothing else", () => {
  const all = [
    proc(10, 1, "explorer.exe"),
    proc(100, 10, "noren.exe"),
    proc(101, 100, "msedgewebview2.exe"),
    proc(102, 101, "msedgewebview2.exe"),
    proc(103, 102, "msedgewebview2.exe"),
    proc(104, 100, "conhost.exe"),
    proc(105, 104, "pwsh.exe"),
    proc(200, 10, "msedgewebview2.exe"),
    proc(300, 1, "other.exe"),
  ];
  const tree = processTree(100, all);
  assert.deepEqual(
    tree.map((p) => p.pid).sort((a, b) => a - b),
    [100, 101, 102, 103, 104, 105],
  );
});

test("a missing root gives an empty tree, and a reused process id cannot loop the walk", () => {
  assert.deepEqual(processTree(5, [proc(1, 0, "a")]), []);
  const loop = [
    proc(100, 101, "noren.exe"),
    proc(101, 100, "child.exe"),
    proc(102, 102, "self.exe"),
  ];
  assert.deepEqual(
    processTree(100, loop).map((p) => p.pid),
    [100, 101],
  );
});

test("the memory adds up the working sets and counts the processes by name", () => {
  const sum = sumMemory([
    proc(1, 0, "noren.exe", 40 * MB, 20 * MB),
    proc(2, 1, "msedgewebview2.exe", 100 * MB, 60 * MB),
    proc(3, 1, "MSEdgeWebView2.exe", 50 * MB, 30 * MB),
  ]);
  assert.equal(sum.workingSetMb, 190);
  assert.equal(sum.privateWorkingSetMb, 110);
  assert.equal(sum.processes, 3);
  assert.deepEqual(sum.kinds, { "noren.exe": 1, "msedgewebview2.exe": 2 });
  assert.deepEqual(sum.roles.noren, { workingSetMb: 40, privateWorkingSetMb: 20 });
  assert.deepEqual(sum.roles.webview, { workingSetMb: 150, privateWorkingSetMb: 90 });
  assert.deepEqual(sum.roles.shells, { workingSetMb: 0, privateWorkingSetMb: 0 });
  const withShells = sumMemory([proc(1, 0, "noren.exe"), proc(2, 1, "pwsh.exe", 3 * MB, MB)]);
  assert.deepEqual(withShells.roles.shells, { workingSetMb: 3, privateWorkingSetMb: 1 });
});

test("the time to a moment is read on the clock of the system", () => {
  assert.equal(launchTo(1_760_000_000_000, "1760000000750"), 750);
  assert.equal(launchTo(Date.now(), String(Date.now() + 5)) >= 5, true);
});

test("the median is the middle one, or the mean of the two in the middle", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([620, 640, 700, 610, 900]), 640);
  assert.ok(Number.isNaN(median([])));
});
