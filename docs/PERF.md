# Performance

The targets of the product, how each one is measured, and what was measured. Six tasks fill this
page: NOR-F11-01a (the measurements that need no window, rows 1 to 4 of "Results"), NOR-F11-01b
(the ones that need the real app in a release build: the first prompt and the memory of 30 tabs,
rows 5 and 6), NOR-F11-01c (why the first switch of space was sometimes slow, and the fix, row 4),
NOR-F11-01d (where the time to the first prompt went, and the cuts, row 5), NOR-F11-01e (what
"total memory" counts, and the verdict of row 6) and NOR-F20-04 (the harder targets of version 1,
row 7, and the report on the renderer in [RENDERER.md](RENDERER.md)).

## Targets

The first table is the targets of the first release; the harder ones of version 1 follow it.

| #   | Target (spec, section 11)                                                  | Measured in | Status                                                                                                                         |
| --- | -------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Opening the app to the first prompt: under 800 ms (release, Windows)       | NOR-F11-01d | **met**: 621 ms median (583 to 677) after NOR-F11-01d, 958 ms before (01b)                                                     |
| 2   | `cat` of 50 MB does not freeze the interface: the sidebar answers < 100 ms | NOR-F11-01a | **met** (13 ms)                                                                                                                |
| 3   | 30 tabs open: total memory under 500 MB                                    | NOR-F11-01e | **met**: 270.1 MB median (269.5 to 272.4), private working set of Noren, web view and console hosts; whole tree 3,555 MB of WS |
| 4   | Changing space: under 100 ms                                               | NOR-F11-01a | **met** (16 ms), also the first switch of a page (43.7 ms median, worst 49.8 of 25) after NOR-F11-01c                          |
|     | Terminal throughput (no number in the spec)                                | NOR-F11-01a | measured, see below                                                                                                            |

Version 1 (NOR-F20-04), same definitions, same release build, row 7 below:

| #   | Target (version 1)                                                  | Measured in | Status                                                                                                            |
| --- | ------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| v1a | Opening the app to the first prompt: under 500 ms (median of 5)     | NOR-F20-04  | **not met, borderline**: 526, 478, 491 and 495 ms in four series of 5 (497 over all 20; 9 of 20 runs over 500 ms) |
| v1b | 100 tabs open: total memory under 800 MB (same definition as row 3) | NOR-F20-04  | **met**: 467.5 MB median (465.7 to 472.7), 41 % under the target; whole tree 10,434 MB of WS                      |

## Machine

One machine, left alone while the numbers were taken (no other build or test running).

| Part     | Value                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| CPU      | Intel Core i9-14900K (24 cores, 32 threads)                                                                                         |
| Memory   | 63.8 GB (DDR5-4800)                                                                                                                 |
| GPU      | NVIDIA GeForce RTX 4090 (the headless Chromium may or may not use it; see "Limits")                                                 |
| System   | Windows 11 Pro, build 10.0.26200                                                                                                    |
| Browser  | Chromium 156.0.8078.4 (the Playwright build), headless                                                                              |
| Tools    | Node 24.2.0, Rust 1.99.1 (`--release` for the PTY test)                                                                             |
| Web view | Microsoft Edge WebView2 Runtime 155.0.4283.62 (the real app, rows 5 and 6)                                                          |
| Shell    | Windows PowerShell 5.1.26100 (`powershell`, the default profile: no `pwsh` here), with the user's own profile, as the app starts it |

## Method

- Every measurement is repeated **5 times** and the page quotes the **median** and the spread (the
  minimum and the maximum; `p95` where there are many samples). A single run proves nothing: an
  earlier version of the harness reused one browser profile for the five repetitions, and the first
  switch of space read 120 ms because the previous repetition had left its saved terminal state
  behind. With a browser context of its own for each repetition the same measure read 53 to 61 ms.
  Each repetition below is a cold start of its own page.
- Web measurements run `e2e/perf.spec.ts` in headless Chromium against the `FakeBackend`, with one
  worker. The page is the production build of the interface (`pnpm --filter @noren/desktop build`),
  so React, xterm.js and its WebGL addon run as they do in the app. The fake backend lives in the
  same page, so its work costs main-thread time that the real backend (a Rust thread and an IPC
  channel) would not; this makes the web numbers pessimistic for the interface.
- **The stopwatch for a click** starts at the `pointerdown` of the gesture (the browser's own time
  stamp of the event, so a main thread that was busy and kept the event waiting is counted) and stops
  at the next frame after the element changed (`requestAnimationFrame`, then a timer). The floor of
  this measure is therefore one frame: **about 16 ms** at 60 Hz. A reading of 16 ms means "answered
  in the first frame".
- The PTY measurement is `crates/noren-core/tests/perf_pty.rs`, a Rust test marked `#[ignore]` so
  that `pnpm verify` never runs it. It prints one `PERF` line per repetition.
- The real-app measurements (rows 5 and 6) run `noren --smoke-perf --perf-out <file> [--perf-tabs
<n>]` from the release build (`tauri build --no-bundle`), started by `scripts/perf.mjs` with the
  window hidden, as the other `--smoke*` modes. The mode keeps the files of the app in a folder of
  its own in the temp folder (a saved workspace of `n` tabs, one shell each, written for the run, an
  empty settings file, no scrollback), so the state and the settings of the person are neither read
  nor written; the key vault is in memory, no global shortcut is registered and a second instance is
  not looked for. The hidden quick-terminal window is created, as in a normal start. The result goes
  to a file, because the release build is a window program with no console. Each repetition is a
  cold start of a new process. The runs alternate (1 tab, 30 tabs, 1 tab, ...) so that a slow minute
  of the machine does not fall on one kind only.
- **First prompt** is the time from the creation of the `noren.exe` process (the system's own
  record, read by the script from the process list) to the moment the terminal on screen has taken
  in the chunk that holds the first prompt of the shell: the mark `ESC ] 133 ; A` that the shell
  integration writes at the start of a prompt. The page reports it (`term.write` callback, event
  `perf-prompt-shown`) and the app stamps it on arrival. It is measured over a saved workspace of
  one tab, which is what a first start looks like. Two cross-checks are kept: from the launch call
  in the script (it also counts the creation of the process by Node, an upper bound) and from the
  start of `main` in the app (it leaves out the loader of Windows, a lower bound). Since NOR-F11-01d
  the app and the page also stamp the steps in between (`perf::mark`, `perfMark`; only the hidden
  perf mode keeps them), and the script prints each one as ms from the creation of the process.
- **Memory** ("total memory", defined in NOR-F11-01e and in the spec, section 11) is the **private
  working set summed over `noren.exe`, its web view processes (`msedgewebview2.exe`) and the console
  hosts made for the tabs (`openconsole.exe`, `conhost.exe`)**. The shells (`powershell.exe`, `pwsh`,
  `bash`, ...) and whatever they start are not counted. It is read from the process list after the 30
  prompts are in and the app has been left alone for 3 seconds; three readings, 1 second apart, and
  the median of the three is the figure of the repetition. Why this definition: the shell is the
  user's own program, chosen and configured by them (profile, plugins, prompt themes), and it costs
  the same in any terminal, so the memory of a shell says nothing about this application; the
  private working set counts each page once, where the working set counts the pages that processes
  share once per process (the web view processes share a lot), so its sum does not lean high. The
  working set summed over the whole tree (shells included) and the private working set of the whole
  tree stay in the tables beside it, so nobody has to take the choice on trust. Both are split by
  who owns the process.
- Nothing here opens a window or sends a key to the desktop.

## How to run

From the repository root, on a machine you will leave alone for about 20 minutes:

```text
node scripts/perf.mjs              # web measurements, then the real PTY
node scripts/perf.mjs --skip-pty   # only the web ones (about 2 minutes)
node scripts/perf.mjs --skip-e2e   # only the PTY ones (about 17 minutes)
node scripts/perf.mjs --only-app   # only the real app: release build, then 5 + 5 hidden runs (about 5 minutes)
```

`--only-app` also takes `--no-build` (use the release binary that is there), `--first-only` (only
the 1-tab runs, no many-tabs memory runs) and `--app-tabs <n>` (the many-tabs side opens `n` tabs,
2 to 100, instead of 30: `--app-tabs 100` is the v1 memory target; the rows of the summary then say
`n tabs`), and the environment variable `NOREN_PERF_BINARY` (run that
`noren.exe` instead of `target/release/noren.exe`; its `resources/` folder has to sit beside it), which
is how two builds are launched alternately for a comparison on the same day. Besides the summary it
prints the stamps of the app and of the page ("Where the time went", section 5). It refuses to start if a
`noren.exe` is already running, and it checks after every run that none is left. The pure parts of
the script (which processes belong to the tree, the sums, the clock) are tested by
`node --test scripts/perf-app-lib.test.mjs`. Or each part by itself:

```text
pnpm --filter @noren/desktop build
pnpm exec playwright test -c e2e/playwright.config.ts perf.spec.ts --workers=1
cargo test -p noren-core --release --test perf_pty -- --ignored --nocapture --test-threads=1
```

The Rust test reads `NOREN_PERF_MB` (size of the file, default 50), `NOREN_PERF_REPS` (default 5),
`NOREN_PERF_PRODUCER` (`type`, the default on Windows, or `cat`) and `NOREN_PERF_LINE_BYTES`
(default 0: the bare numbers that `seq` prints). The e2e spec writes its JSON to the file named by
`NOREN_PERF_OUT` when it is set. `pnpm e2e` also runs the spec, with floors wide enough to hold on a
busy machine (beside about 500 other tests it reads slower: `seq` in 1.6 s instead of 0.8 s, a
loaded click up to 70 ms, one idle click of 103 ms); the numbers on this page come from the commands
above, run alone.

## Results

### 1. Throughput of the terminal fed by the `FakeBackend`

`seq 1000000` typed in the terminal of the fake shell: 7,888,896 bytes of numbers, with the
prompt marks, from the press of Enter to the prompt back on screen (the xterm.js WebGL renderer was
active). The time includes the fake shell building the output on the same thread.

| Repetition | 1    | 2    | 3    | 4    | 5    | Median   | Min / max      |
| ---------- | ---- | ---- | ---- | ---- | ---- | -------- | -------------- |
| Seconds    | 0.84 | 0.83 | 0.82 | 0.80 | 0.80 | 0.82 s   | 0.80 / 0.84 s  |
| MB/s       | 8.92 | 9.07 | 9.12 | 9.40 | 9.46 | 9.1 MB/s | 8.9 / 9.5 MB/s |

The spec has no number for throughput. **Verdict: informative.** The terminal takes about 9 MB/s end
to end in this setup; the spread is 6 %, so the figure is steady. The risk register of the spec
("throughput of xterm.js via IPC") is answered in two parts: this row for the drawing side and
row 2 below for the PTY side.

### 2. Throughput of the real PTY

A file of 50 MB (the lines `1`, `2`, `3`, ... as `seq` prints them) printed by a shell program on a
real pseudo console, timed from the spawn to the exit event, in release mode. "Through Noren" is
`SessionManager` (reader thread, channel, batches of 64 KB or 8 ms); "Raw" is the same program read
straight from `portable-pty` in a tight loop, with none of Noren's code, as a control.

| Repetition                  | 1     | 2     | 3     | 4     | 5      | Median  | Min / max        |
| --------------------------- | ----- | ----- | ----- | ----- | ------ | ------- | ---------------- |
| Through Noren, seconds      | 98.60 | 96.15 | 97.77 | 97.03 | 102.74 | 97.77 s | 96.15 / 102.74 s |
| Raw `portable-pty`, seconds | 97.81 | 96.75 | 95.87 | 95.78 | 98.23  | 96.75 s | 95.78 / 98.23 s  |

Producer `cmd.exe /c type FILE`. That is 0.51 MB/s through Noren and 0.52 MB/s raw. Other readings
of the same test:

- Through Noren, the pump delivered 11,950 to 12,750 batches per 50 MB (about 4 KB each, every one
  closed by the 8 ms timer, because the bytes arrive slower than 64 KB per 8 ms); the longest
  silence between two batches was 14 to 22 ms; the first byte came after 58 to 87 ms. The raw loop
  saw 5.8 million reads for the same file (9 bytes per read): the pump turns millions of tiny reads
  into thousands of messages.
- With the `cat.exe` of Git for Windows as the producer (20 MB, 3 repetitions): 19.4 to 19.7 s
  through Noren and 19.7 to 20.2 s raw, about 1.0 MB/s both.
- With each line padded to 200 bytes (a 20 MB file, `NOREN_PERF_LINE_BYTES=200`, 2 repetitions) the
  console drops the trailing blanks, so 13.7 MB came out: 18.5 and 19.4 s through Noren, 19.9 and
  18.9 s raw, about 0.7 MB/s of the bytes received. The same 20 MB of short lines takes about 40 s,
  so the time depends on the content (lines and bytes both), and every shape tried stayed between
  0.5 and 1.0 MB/s of the file.

**Target.** The spec gives no number for the PTY, so the criterion of this task is the one that can
be tested on our side: Noren must not be slower than the pseudo console it reads from, at least
90 % of the raw rate. **Verdict: met** (97.77 s against 96.75 s, 99 %).

**Open finding (#132).** The pseudo console itself is the ceiling on this machine: `cat` of 50 MB
takes about 98 s with `type` and, going by the 20 MB run, about 50 s with `cat.exe`, and a program that reads it in a tight
loop with no Noren code in between gets the same rate. The interface stays responsive (row 3), but a
person who `cat`s a large file waits minutes. The cause is in the Windows console host or in how
`portable-pty` opens it, not in the pump; whether another way to open the pseudo console is faster
is for the planner to decide. No task was opened for it because the spec has no target it breaks.

The test could only be run on Windows here; on macOS and Linux it prints the `cat` of the system.

### 3. The sidebar while 50 MB of output comes in

Tab "api" is on screen and receives 50 MB of numbered lines through `sendOutput` (64 KB every 4 ms,
which asks for up to 16 MB/s), followed by a marker line. While it comes in, the test clicks in the
sidebar all the time: it folds and unfolds the group "Work" (a click that changes only the sidebar)
and switches to the tab "build" and back (a click that also changes which terminal is on screen). The
same gestures were first timed with nothing coming in, as the noise to read the loaded ones against.

| Gesture (ms from press to next frame)         | Samples | Median | p95  | Min  | Max  |
| --------------------------------------------- | ------- | ------ | ---- | ---- | ---- |
| Switch tab, idle                              | 40      | 16.3   | 54.5 | 7.6  | 58.0 |
| Fold or unfold the group, idle                | 40      | 16.2   | 25.7 | 12.5 | 28.4 |
| **Switch tab, 50 MB coming in**               | 430     | 13.4   | 23.6 | 7.5  | 31.0 |
| **Fold or unfold the group, 50 MB coming in** | 430     | 12.2   | 29.2 | 4.4  | 32.4 |

The output side, over the 5 repetitions: the 50 MB took 13.1 s to feed and to be drawn (feed 3.71 to
3.96 MB/s, drawn 3.69 to 3.94 MB/s, median 3.8; the feed is slower than the 16 MB/s asked for because
the page does the producing, the parsing and the drawing on one thread, so the terminal is the
limit). No long task (50 ms or more) of the main thread was seen in the final run; an earlier run
that carried state between repetitions saw one of 58 ms. In all 5 repetitions the end marker reached
the screen: no output was lost.

**Target: under 100 ms. Verdict: met.** Under load the median is 13 ms and the slowest of 860
clicks 32 ms, three times under the target; the idle run shows the same floor of one frame, so the
heavy output costs the sidebar nothing it can feel. (The loaded medians sit a little under the idle ones; that is
not read as the busy page being faster, only as the same one-frame floor.)

### 4. Changing space

Two spaces of 15 tabs each, so 30 terminals are mounted in the page (30 `.xterm` elements counted
in every repetition). The test clicks the button of the other space and back, 6 times each way in a
fresh page, 5 repetitions. The first switch of a page is shown apart: it is the one that draws the
other space for the first time. In NOR-F11-01a the spec was run 5 times (the final run, three more
runs back to back with `--repeat-each=3`, and once inside `pnpm e2e`), 25 repetitions.

Later switches (the ones after the first, over those 5 runs): the median of each run was 15.5,
15.8, 15.4, 15.7 and 15.5 ms; the slowest single switch in any run was 27.8 ms.

First switch of the page, in ms, by run (5 repetitions each), before NOR-F11-01c:

| Run                              | Repetitions                      | Median |
| -------------------------------- | -------------------------------- | ------ |
| Final run                        | 61.2, 57.8, 58.1, 55.0, 52.8     | 57.8   |
| Inside `pnpm e2e` (busy machine) | 54.8, 51.3, 61.2, 56.5, 55.7     | 55.7   |
| Back to back, 1st                | 55.3, 55.3, 57.5, 55.3, 47.9     | 55.3   |
| Back to back, 2nd                | 129.8, 51.5, 53.7, 152.6, 50.3   | 53.7   |
| Back to back, 3rd                | 141.1, 154.6, 142.2, 137.4, 71.3 | 141.1  |
| **All 25**                       |                                  | 56.5   |

The first switch had two modes: about 55 ms most of the time, and 130 to 155 ms in 6 of the 25
repetitions (all in the last two runs, one after the other). The later switches did not change in
those runs. Task NOR-F11-01c was opened for it; what it found is below.

#### Why the first switch was sometimes slow (NOR-F11-01c)

The measure was taken again before touching anything (two runs of 5 repetitions, the code of
NOR-F11-01b): 6 of 50 first switches were over 100 ms (104.4, 118.8, 103.6, 120.9, 141.8 and 146.7)
and the rest sat at 45 to 79 ms, median 55. The JavaScript of the switch is not where the time goes:
a CPU profile of the click shows about 5 ms of page code (the React update, the ResizeObserver
callbacks under 1 ms, xterm's `handleResize`). A Chromium trace (`devtools.timeline`, `gpu`,
`gpu.angle`) shows the rest:

- **What a first switch costs by itself (about 40 ms).** The terminal that is shown holds a WebGL
  canvas that no frame has composited yet. In the headless build the compositor is software: the
  frame that first shows the canvas stops the main thread in `GLES2::ReadPixels` (inside `Commit`,
  `DoUpdateLayers`) until the graphics process has finished the canvas, which takes 35 to 45 ms the
  first time and about 3 ms for a canvas that was shown before. With the DOM renderer in its place
  the same switch takes 31 ms. The later switches (16 ms) pay none of it.
- **What made it 100 to 160 ms (the slow mode).** `App.tsx` mounts the terminal of every tab at once,
  hidden (`App.tsx:1775`, `App.tsx:426`), and `TerminalView.tsx` made the WebGL context of each one in
  that same mount (`TerminalView.tsx:281-296` before the change). The 30 contexts, made within about
  0.3 s of page time (0.43 to 0.72 s), keep the graphics process busy for the next second: the trace
  of a slow switch shows its thread running a task of about 3 ms every 3.7 ms before the click, and
  the readback of the shown canvas waiting behind them for 161 ms. A click that lands in that second
  (the harness clicks 0.9 to 1.4 s after the page loads) is slow; one that lands later is not.
  Clicking right after the first prompt, before the graphics process settled, gave 95 to 208 ms in
  every repetition of a probe made for it, which is how the cause was told from chance.
- **Not the cause.** The layers of the hidden spaces (`display: none` costs nothing until they are
  shown), the hidden tabs, and the ResizeObserver fit (under 1 ms in every trace).

Two more facts the trace showed, left alone (finding #137): the page allows 16 WebGL contexts and
drops the oldest, so with 30 terminals the first 14 created lose theirs about 0.3 s after the start,
**the one on screen included**; xterm waits 3 s and then falls back to the DOM renderer for them. The
app behaved so before this task and does after it; it belongs to the memory task (NOR-F11-01e), which
already looks at the context of each terminal.

#### The fix

`TerminalView` takes a new property `webglFirst`. The terminal on screen and the tab that each space
shows first (`itemShownIn` in `workspace-store.ts`, passed down by `App.tsx` as `first`) make their
WebGL context in the mount, as before, so a space has its first tab drawn before the person switches
to it. The terminals of every other tab are queued and make theirs one every 40 ms (`preloadWebgl`),
or at once if the tab is shown before its turn (`attachWebgl`, called when the view first has a
size). Every terminal is still mounted, alive and drawn by the same renderer; what the person sees is
the same, and only the order and the spacing in which the contexts appear changed. A new test
(`e2e/webgl-contexts.spec.ts`) fails on the old code (all 30 contexts within 0.3 s) and passes on the
new (a span of at least 1 s, and every tab gets one).

Two attempts were measured and dropped. Laying out the first tab of each hidden space under
`visibility: hidden`, so its canvas is drawn in advance, left the first switch at the same 75 to 90
ms in this build (the compositor reads the canvas back when it is first painted, not when it is
drawn) and made the later switches 7 ms slower. Making no context until a terminal is first shown
brought the probe to 33 ms, but the text of the new tab was drawn 100 to 125 ms after the click (the
probe stops at the frame after the click, not at the frame with the text), so that number was not a
fix.

#### After the fix: the 25 first switches

5 runs of the space test, 5 repetitions each, a browser context of its own for each repetition, in ms
(`NOREN_PERF_OUT=... playwright test perf.spec.ts -g space --workers=1`, the final code):

| Run        | Repetitions                  | Median |
| ---------- | ---------------------------- | ------ |
| 1          | 33.3, 39.6, 41.7, 45.6, 48.6 | 41.7   |
| 2          | 29.7, 39.9, 47.7, 46.5, 42.4 | 42.4   |
| 3          | 33.4, 38.6, 44.4, 43.7, 49.8 | 43.7   |
| 4          | 33.5, 38.0, 47.6, 47.0, 49.3 | 47.0   |
| 5          | 31.2, 38.3, 46.0, 48.1, 48.5 | 46.0   |
| **All 25** | min 29.7, max 49.8           | 43.7   |

Other samples of the same logic: 5 more inside `pnpm e2e` (48.8, 47.4, 47.5, 42.0, 47.5) and 100 from
four runs taken while the fix was being finished (median 48.8, worst 84.8 ms): 130 first switches,
none over 100 ms, against 6 of 50 before. The later switches in the 5 runs: the median of each run was
14.2, 15.8, 17.4, 17.0 and 12.2 ms; the slowest single one 47.5 ms. The 30 `.xterm` elements were in
the page in every repetition.

**Target: under 100 ms. Verdict: met**, the first switch of a page included: 25 of 25 under 100 ms
(worst 49.8 ms), where it had been 6 of 25 over (worst 154.6 ms), and every switch after the first
(16 ms), with every terminal of the 30 tabs alive. Not verified (D19): the real window. The real
compositor uses the GPU, so the 40 ms of the first composite may not exist there; the new order of
the contexts (`TerminalView.tsx`, `preloadWebgl`) can only help. What was measured is the headless
build, where the cost showed.

### 5. Opening the app to the first prompt (real app, release build)

`noren --smoke-perf` over a saved workspace of one tab, the window hidden, 5 cold starts, in ms
(see "Method" for what the clock starts and stops on). **Before** is the measurement of
NOR-F11-01b, **after** is NOR-F11-01d (`node scripts/perf.mjs --only-app`, the 30-tab runs in
between as in 01b):

| Repetition                                  | 1   | 2   | 3   | 4   | 5   | Median  | Min / max |
| ------------------------------------------- | --- | --- | --- | --- | --- | ------- | --------- |
| **After: from the creation of the process** | 621 | 677 | 621 | 600 | 583 | **621** | 583 / 677 |
| After: from the launch call (upper bound)   | 946 | 707 | 623 | 601 | 607 | 623     | 601 / 946 |
| After: from the start of `main` (lower)     | 536 | 591 | 548 | 527 | 511 | 536     | 511 / 591 |
| After: `app-ready` of the page, from `main` | 522 | 563 | 530 | 505 | 490 | 522     | 490 / 563 |
| Before (01b, 5 earlier runs)                | 960 | 913 | 894 | 958 | 997 | 958     | 894 / 997 |

The 946 ms is the first launch of the series, the slow creation of a process by Node, which the
system's own creation time leaves out. This machine is noisy from one hour to the next (the same
unchanged code measured 958 ms in 01b and 933 to 1,033 ms on the day of 01d), so the comparison
that counts is the one run **interleaved on the same day**: the build of the commit before this
task (`35b5b52`) and the build of this task, launched alternately, 5 each, same script, same state
of the machine (`NOREN_PERF_BINARY`, `--first-only`):

| Repetition                                                               | 1    | 2   | 3    | 4    | 5    | Median   | Min / max  |
| ------------------------------------------------------------------------ | ---- | --- | ---- | ---- | ---- | -------- | ---------- |
| Before (commit `35b5b52`)                                                | 1018 | 960 | 1152 | 1094 | 1033 | **1033** | 960 / 1152 |
| After (this task, before the last small change of `quick.rs`, see below) | 581  | 532 | 555  | 583  | 573  | **573**  | 532 / 583  |

**Target: under 800 ms in the median and under 900 ms in the worst. Verdict: met.** The final
build measured 621 ms median and 677 ms worst of 5, and 573 / 583 ms in the interleaved run, where
the old code measured 1,033 / 1,152 ms.

With 30 tabs saved the first prompt of any took 1,403 ms (median; 1,399 to 1,683) and the last of
the 30 took 1,972 ms (1,866 to 2,321); in 01b they took 1,761 and 1,936 ms. The first of them is
the shell started ahead; the other 29 are started one after the other by `restoreWorkspace`, as
before (not changed here: the task is the first prompt of a first start).

#### Where the time went

Each step was stamped (`perf::mark` in the app, `perfMark` in the page; the page's stamps travel in
the payload of the first prompt event, so a normal start pays an array push per stamp and no IPC)
and the script reads them as ms from the creation of the process, median of 5 (`node
scripts/perf.mjs --only-app --first-only` prints them). **Before** is the original code with the
stamps and no cut (first prompt 933 ms median in that run); **after** is the final build (621 ms):

| Step (stamp)                                                 | Where                                                 | Before   | After                 |
| ------------------------------------------------------------ | ----------------------------------------------------- | -------- | --------------------- |
| `main` starts (`main`)                                       | `apps/desktop/src-tauri/src/main.rs:27`               | 73       | 74                    |
| profiles detected, `wsl.exe -l -q` (`detect-end`)            | `src-tauri/src/bridge.rs:66`                          | 146      | off the path (thread) |
| builder done (`built`)                                       | `src-tauri/src/main.rs:256`                           | 157      | 87                    |
| shell started ahead (`prespawn-start`, `shell-spawned`)      | `src-tauri/src/prespawn.rs:201`, `bridge.rs:370`      | none     | 88, 203               |
| web view navigates (`page-navigation-start`)                 | page, `performance.timeOrigin`                        | 408      | 369                   |
| `setup` of the app (`setup-start`)                           | `src-tauri/src/main.rs:155`                           | 436      | 396                   |
| quick window created (`quick-window-end`)                    | in `setup` before; `src-tauri/src/quick.rs:129` after | 506      | out of the start      |
| page script runs (`page-script`)                             | `apps/desktop/src/main.tsx:10`                        | 500      | 453                   |
| boot begins (`boot-start`)                                   | `apps/desktop/src/boot.ts:53`                         | 531      | 480                   |
| settings read (`boot-config`)                                | `boot.ts:63`                                          | 549      | 509                   |
| themes, mods, profiles (`boot-profiles`)                     | `boot.ts:76-85`                                       | 565      | 520                   |
| the page asks for the shell (`session-create-called`)        | `src-tauri/src/bridge.rs:287`                         | 571      | 527                   |
| shell started (`shell-spawned`)                              | `src-tauri/src/bridge.rs:370`                         | 611      | 203 (claimed at 528)  |
| workspace restored (`boot-restore`, `boot-done`)             | `boot.ts:90`, `boot.ts:152`                           | 612, 616 | 529, 534              |
| interface renders the boot result (`app-render`)             | `apps/desktop/src/App.tsx:1925`                       | 616      | 535                   |
| **terminal mounts (`terminal-mount`)**                       | `apps/desktop/src/TerminalView.tsx:284`               | **858**  | **554**               |
| terminal open, listening to the shell (`terminal-listening`) | `TerminalView.tsx:354`, `:467`                        | 889      | 594                   |
| page says it is up (`app-ready`)                             | `apps/desktop/src/App.tsx:1334`                       | 894      | 602                   |
| first prompt bytes leave the shell (`shell-prompt-bytes`)    | `src-tauri/src/bridge.rs:342`                         | 928      | 585                   |
| prompt taken in by xterm (`perf-prompt-shown`)               | `TerminalView.tsx:472`                                | 933      | 621                   |

What the stamps showed, and what was done (nothing the person sees was changed, with one
exception told at the end):

1. **A 235 ms wait inside React (`app-render` 616 to `terminal-mount` 858).** `Booted` read the
   boot with `use(booted)` inside `<Suspense fallback={null}>`. The boundary showed its fallback
   at once, and React holds back the reveal of the content until 300 ms after the fallback (its
   throttle against flashing fallbacks), whatever the page is doing: no long task was seen in the
   gap, and a CPU profile of the page in Chromium showed about 200 ms of work in all. Now the boot
   result is read with a state (`useBooted`, `App.tsx:1908`) and the boundary is gone: the terminal
   mounts 19 ms after the render. The largest cut.
2. **The shell started only when the page asked for it** (`session-create-called` at 571 ms, its
   prompt at 928: Windows PowerShell 5.1 takes 350 to 400 ms from its start to its prompt). The
   command the page will ask for first is already in `state.json`, so a thread of the app
   (`prespawn.rs`) reads it as soon as the builder is done, starts that shell and holds its output.
   The page's `session_create` is handed the running session, with what it printed, when its
   command is exactly the same one (`SpawnSpec` equality, which covers the profile after the
   profiles of the user were applied); otherwise it starts its own, as before. A shell nobody
   claimed ends at `app-ready`, without a word to the page. It is the visible pane (the focused
   pane of the active tab of the active space) that is started ahead.
3. **`AppState::detect` took 72 ms before the window existed** (it asks `wsl.exe -l -q`): it is
   now a thread, waited for only when the first profile is needed (`bridge.rs:66`).
4. **The quick window (a second web view loading the same page) was created inside `setup`**, in
   front of the load events of the main page, sharing the CPU with it (70 ms on the thread of the
   windows). It is now created 1.5 s after the main page says `app-ready` (`quick.rs:129`).

What was left alone, being a floor or small: the start of the process up to `main` (about 75 ms);
the time from the end of the builder to the first navigation of the web view (about 280 ms:
WebView2 creating its environment and its processes, not under the control of the app); the
scripts of the page (about 110 ms from the navigation to `boot-start`); the settings, themes and
mods calls of the boot (about 40 ms in series; side by side they would save about 10 ms); the shell
itself. The shell is now the last link: its prompt bytes (585 ms) arrive about when the terminal
begins to listen (594 ms).

**Not verified (D19): a visible window.** All of this is the hidden window (every `--smoke*` mode,
`apps/desktop/src-tauri/src/main.rs:207`, `tauri.conf.json:20`). WebView2 may start, load and run
the page differently with the window shown; the 300 ms throttle that was removed is React's and
holds in both, and the shell started ahead does not depend on the window. A person's first prompt
may differ from these figures by an amount that was not measured.

**What changed in behavior, on purpose, in the first seconds.** The shortcut of the quick window
pressed before about 2.5 s after the start finds no window yet: it makes it then (the same path as
a failure to make it at the start always took) and, new, asks its page for the shell again once the
page says it is ready (`quick.rs`, `toggle_window`), so the window does not open empty. Pressed
later, nothing differs.

### 6. Memory with 30 tabs open (real app, release build)

`noren --smoke-perf --perf-tabs 30`: 30 tabs in one space, one Windows PowerShell each, all 30
prompts on screen, 3 seconds of rest, then the process list. 5 repetitions, in MB (1 MB = 1,048,576
bytes), each the median of three readings.

#### The definition and the verdict (NOR-F11-01e)

**Total memory = the private working set summed over `noren.exe`, its web view processes and the
console hosts made for the tabs.** The shells and whatever they start are not counted (see "Method"
for why: they are the user's programs and cost the same in any terminal). The planner took the
decision on 19 October 2026 and wrote it in the spec, section 11. The script splits the console
hosts (`openconsole.exe`) from the shells for it (`roleOf` in `scripts/perf-app-lib.mjs`, tested by
`scripts/perf-app-lib.test.mjs`). The build is the release build of the commit before this task
(`8acc1d9`; this task changed no code of the app), `node scripts/perf.mjs --only-app`, the 30-tab
runs between the 1-tab runs as before, the same 3 seconds of rest and the median of three readings
per run. The first prompt of the same run (1 tab) was 589 ms median, still under its target.

Private working set by who owns the process, in MB, 5 repetitions (68 processes in every run: 1
`noren.exe`, 7 `msedgewebview2.exe`, 30 `openconsole.exe`, 30 `powershell.exe`):

| Repetition                                         | 1       | 2       | 3       | 4       | 5       | Median      | Min / max         |
| -------------------------------------------------- | ------- | ------- | ------- | ------- | ------- | ----------- | ----------------- |
| `noren.exe`                                        | 13.0    | 13.3    | 13.1    | 13.3    | 13.3    | 13.3        | 13.0 / 13.3       |
| Web view (7 processes)                             | 205.3   | 205.7   | 208.1   | 205.5   | 206.0   | 205.7       | 205.3 / 208.1     |
| Console hosts (30 processes)                       | 51.1    | 51.1    | 51.2    | 51.0    | 51.2    | 51.1        | 51.0 / 51.2       |
| **Total memory (the sum of the three rows above)** | 269.5   | 270.1   | 272.4   | 269.9   | 270.4   | **270.1**   | 269.5 / 272.4     |
| _Not counted:_ 30 shells (private working set)     | 1,085.8 | 1,081.3 | 1,084.9 | 1,089.1 | 1,085.2 | 1,085.2     | 1,081.3 / 1,089.1 |
| _Beside it:_ private working set, whole tree       | 1,355.3 | 1,351.5 | 1,357.3 | 1,359.0 | 1,355.6 | 1,355.6     | 1,351.5 / 1,359.0 |
| _Beside it:_ **working set summed over the tree**  | 3,553.9 | 3,550.6 | 3,556.0 | 3,564.5 | 3,555.4 | **3,555.4** | 3,550.6 / 3,564.5 |

The working set of the whole tree by owner (median of the 5): `noren.exe` 38.2, web view 502.3,
console hosts 378.0, 30 shells 2,636.7 MB. The log of the run is in the round's evidence folder
(`app.jsonl` has every field of every run).

**Target: 30 tabs open, total memory under 500 MB. Verdict: met** by the definition above: 270.1 MB
median, 269.5 to 272.4 in the 5 repetitions (46 % under the target, the spread under 1.1 %). With one
tab open the same total is 139.8 MB (138.5 to 142.6), so a tab costs about 4.5 MB of Noren's own
(the console host, 1.7 MB, and the terminal of the page); the rest is the fixed part, the web view.
No cut was needed, so nothing about the behavior of the app changed in this task. What the figure
leaves out, being the user's: the 30 shells, 1,085 MB of private working set here (Windows
PowerShell 5.1 with the user's own profile). Counted the other way, the whole tree is 3,555 MB of
working set and 1,356 MB of private working set, which no terminal that runs 30 of these shells can
get under 500 MB. Not verified (D19): the memory with the window shown (the web view of a window
that is on screen may keep GPU surfaces that a hidden one releases, see "Limits"), so the real
figure may be higher by an amount not measured; the margin to the target is 230 MB.

#### The first measurement, before the definition (NOR-F11-01b)

The same run in the form of NOR-F11-01b, where the shells and the console hosts were one row and the
figure of the target was the working set summed over the tree. In MB:

| Repetition                               | 1       | 2       | 3       | 4       | 5       | Median      | Min / max         |
| ---------------------------------------- | ------- | ------- | ------- | ------- | ------- | ----------- | ----------------- |
| **Working set summed over the tree**     | 3,653.0 | 3,642.8 | 3,651.7 | 3,644.7 | 3,650.7 | **3,650.7** | 3,642.8 / 3,653.0 |
| Private working set summed over the tree | 1,385.8 | 1,377.6 | 1,383.7 | 1,379.3 | 1,385.3 | 1,383.7     | 1,377.6 / 1,385.8 |

Who owns it (median of the 5, working set / private working set), 68 processes in every run:

| Part                                                                  | Processes | Working set | Private |
| --------------------------------------------------------------------- | --------- | ----------- | ------- |
| `noren.exe`                                                           | 1         | 37.9        | n/a     |
| Web view (`msedgewebview2.exe`)                                       | 7         | 580.9       | 227.1   |
| 30 shells (`powershell.exe`) and 30 console hosts (`openconsole.exe`) | 60        | 3,031.5     | 1,142.4 |

A shell and its console host cost about 101 MB of working set (38 MB private) per tab. With one tab
open the whole tree is 583.8 MB of working set (580.1 to 584.4) and 177.6 MB private (173.8 to 179.0):
the web view is the fixed part, the 30 tabs add the rest. The spread over the 5 repetitions is
under 0.3 %, so the figure is steady.

By that measure (working set summed over the tree) the verdict was **not met**: 3,650.7 MB, 7.3
times the target; by the private working set 1,383.7 MB, still 2.8 times over. Noren and its web view
alone (leaving the shells out) were about 619 MB of working set and about 241 MB private, so the
target was met only if the shells were not counted and the private measure was the one that counted;
the spec did not say which. The 30 shells are 83 % of the working set, and the shell of this machine
is Windows PowerShell 5.1 with the user's own profile, so the figure moves with the shell and the
profile. Task NOR-F11-01e was opened for it, and the definition above is its answer.

Re-measured in the run of NOR-F11-01d (5 repetitions, the same script), with the quick window
made 1.5 s after the page is up: 3,556.1 MB of working set (3,551.1 to 3,590.9), 1,355.8 MB private (1,352.1
to 1,391.5), 501.4 MB in the web view processes, 68 processes. That is about 95 MB under 01b; the cause was not
isolated (the repetitions agree within 0.2 %, but it is one day against another); the run of
NOR-F11-01e (3,555.4 MB, above) agrees with this one.

### 7. Version 1: the first prompt under 500 ms and 100 tabs under 800 MB (NOR-F20-04)

The two targets of version 1, measured the way rows 5 and 6 are, in the release build of the commit
before this task (`f97d5ce`, built by `pnpm desktop:build` the same day; this task changed no code of
the app). `node scripts/perf.mjs --only-app --no-build --app-tabs 100` (1-tab runs and 100-tab runs
alternating, 5 each, hidden window), then `--only-app --no-build` (1 and 30 tabs) and
`--only-app --no-build --first-only` twice more, on the machine above with nothing else running.
After every run the script checks that no `noren.exe` is left, and `Get-Process noren` was empty at
the end of the round. The defined rule for a target is the one of the roadmap: the **median of 5**
repetitions. Because the first prompt sat right at its target, it was measured in four series of 5
instead of one.

#### v1a. First prompt under 500 ms

Time from the creation of the `noren.exe` process to the prompt in the terminal, one tab saved, in
ms (the "from the creation of the process" clock of row 5):

| Series                                       | 1   | 2   | 3   | 4   | 5   | Median  | Min / max | Verdict     |
| -------------------------------------------- | --- | --- | --- | --- | --- | ------- | --------- | ----------- |
| A: with the 100-tab runs (first after build) | 572 | 515 | 514 | 557 | 526 | **526** | 514 / 572 | over        |
| B: with the 30-tab runs                      | 449 | 475 | 515 | 510 | 478 | **478** | 449 / 515 | under       |
| C: `--first-only`                            | 491 | 489 | 514 | 479 | 498 | **491** | 479 / 514 | under       |
| D: `--first-only`                            | 473 | 479 | 510 | 496 | 495 | **495** | 473 / 510 | under       |
| All 20 runs                                  |     |     |     |     |     | **497** | 449 / 572 | on the line |

**Target: under 500 ms in the median of 5. Verdict: not met, borderline.** Three series of four are
under it, but by 22, 9 and 5 ms; the fourth is 26 ms over, 9 of the 20 runs are over 500 ms and the
slowest is 572. The median of all 20 is 497, 3 ms under the line, and the difference between series
(478 to 526) is wider than that margin, so a pass today is not a pass tomorrow. Series A is the
first after the build, and the disk cache of the machine may have been colder; it was not
isolated. The figure has no room for anything that is slower on another computer or in a window
that is shown (not verified, D19: `apps/desktop/src-tauri/src/main.rs:207`, `tauri.conf.json:20`).
It stays **not met** until a series with a margin says otherwise. Row 5 measured 621 ms on the day
of NOR-F11-01d; the machine is noisy from one day to the next (see there), so the two days are not
compared.

Where the 478 to 526 ms go (the stamps of row 5, median of 5 in ms from the creation of the process;
series B is a good run, series A a slow one):

| Step (stamp)                                       | B        | A        | Segment                                                            |
| -------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------ |
| `main` starts                                      | 76       | 86       | 76 to 86: the process, the loader, before the app's code           |
| builder done (`built`)                             | 84       | 95       | 8 to 9                                                             |
| shell started ahead (`shell-spawned`)              | 147      | 184      | off the path                                                       |
| web view navigates (`page-navigation-start`)       | 281      | 322      | **197 to 227 ms**: WebView2 creating its environment and processes |
| shell prompt bytes (`shell-prompt-bytes`)          | 373      | 417      | the shell is ready 100 ms before the terminal can show it          |
| page script runs (`page-script`)                   | 375      | 420      | **94 to 98 ms**: loading and parsing the page's scripts            |
| boot begins, ends (`boot-start`, `boot-done`)      | 397, 428 | 441, 469 | 28 to 31 ms: settings, themes, mods, profiles, the shell claimed   |
| terminal mounts (`terminal-mount`)                 | 440      | 482      | 11 to 13 ms after the render                                       |
| terminal open, listening (`terminal-listening`)    | 461      | 506      | 21 to 24 ms: xterm opens, the WebGL context is made                |
| page says it is up (`app-ready`)                   | 464      | 510      |                                                                    |
| **prompt taken in by xterm (`perf-prompt-shown`)** | 478      | 526      | 17 to 20 ms after the terminal listens                             |

By process: the app's own code (`noren.exe`, Rust) is on the path only up to `built` (84 to 95 ms,
18 % of the total) and the shell is not on it at all, since its prompt bytes are ready about 100 ms
before the terminal can take them. What is left, 394 to 431 ms (about 82 %), is the web view
process and the page: WebView2 starting (about 40 %), the page's scripts being loaded (about 20 %),
and the page booting, mounting and opening the terminal (about 17 %). So the time is in the part the
app controls the least.

Hypothesis for the cut (not a profile, nothing was changed or tried in this round, as the
task forbids optimizing): (1) the 197 to 227 ms between the end of the builder and the first
navigation is the biggest block and is WebView2 creating its environment; starting that earlier or
in parallel with the rest of `setup`, or checking what the user data folder costs, is the most
that is left to take, and its size is unknown. (2) The first path of the page loads about 1.4 MB of
JavaScript in six large chunks (`TerminalView` 547 KB, `App` 245 KB, `index` 215 KB, `jsx-runtime`
179 KB, `SplitLayout` 147 KB, `boot` 72 KB: the sizes of the built files in `apps/desktop/dist/assets`, before compression);
splitting what the first terminal does not need (the panes of the AI, the browser, the diff, the
settings) from that path could take part of the 94 to 98 ms. (3) the 21 to 24 ms to open the
terminal include the first WebGL context; the first terminal could be drawn by the DOM renderer and
switch to WebGL after the prompt, at the price of a visible change in the first frames. A gain of 30
to 50 ms is what a safe pass needs; (1) and (2) are the only places that can give it.

With many tabs saved the first prompt is later, and it grows with the number of tabs (`first prompt`
is the earliest prompt of any tab, `last` the last of them), medians of 5:

| Tabs saved | First prompt of any tab   | Last prompt               | Extra over 1 tab, per tab |
| ---------- | ------------------------- | ------------------------- | ------------------------- |
| 1          | 478 to 526                | same                      |                           |
| 30         | 1,223 ms (1,183 to 1,263) | 1,359 ms (1,307 to 1,376) | 26 ms                     |
| 100        | 3,448 ms (3,369 to 3,592) | 3,559 ms (3,450 to 3,751) | 30 ms                     |

The target is the first start (one tab), so this is not a v1 miss, but a person who closes the app
with 100 tabs waits 3.4 s for the first prompt, because the terminals of all the tabs are mounted
before the first one shows (hypothesis from the flat cost per tab, not a profile). It is written as
an open finding in the report of the round.

#### v1b. 100 tabs under 800 MB

`noren --smoke-perf --perf-tabs 100`: 100 tabs in one space, one Windows PowerShell each, all 100
prompts on screen, 3 seconds of rest, then the process list; 5 repetitions, each the median of three
readings. **Total memory** is the definition of row 6: the private working set summed over `noren.exe`,
its web view processes and the console hosts made for the tabs; the 100 shells are not counted.
208 processes in every run (1 `noren.exe`, 7 `msedgewebview2.exe`, 100 `conhost.exe`, 100
`powershell.exe`). In MB:

| Repetition                                         | 1        | 2        | 3        | 4        | 5        | Median       | Min / max           |
| -------------------------------------------------- | -------- | -------- | -------- | -------- | -------- | ------------ | ------------------- |
| `noren.exe`                                        | 26.0     | 24.1     | 24.8     | 24.9     | 25.5     | 24.9         | 24.1 / 26.0         |
| Web view (7 processes)                             | 343.1    | 343.5    | 345.8    | 344.6    | 349.3    | 344.6        | 343.1 / 349.3       |
| Console hosts (100 processes)                      | 98.2     | 98.1     | 98.1     | 98.1     | 98.0     | 98.1         | 98.0 / 98.2         |
| **Total memory (the sum of the three rows above)** | 467.3    | 465.7    | 468.7    | 467.5    | 472.7    | **467.5**    | 465.7 / 472.7       |
| _Not counted:_ 100 shells (private working set)    | 3,658.1  | 3,659.4  | 3,660.7  | 3,679.5  | 3,649.2  | 3,659.4      | 3,649.2 / 3,679.5   |
| _Beside it:_ private working set, whole tree       | 4,125.3  | 4,125.1  | 4,129.4  | 4,147.0  | 4,121.9  | 4,125.3      | 4,121.9 / 4,147.0   |
| _Beside it:_ **working set summed over the tree**  | 10,434.4 | 10,435.1 | 10,417.6 | 10,444.1 | 10,418.5 | **10,434.4** | 10,417.6 / 10,444.1 |

**Target: 100 tabs open, total memory under 800 MB. Verdict: met**: 467.5 MB median, 465.7 to 472.7 in
the 5 repetitions (41 % under the target, a margin of 332 MB; the spread is 1.5 %). Beside it,
the same script on the same day with 30 tabs: 262.6 MB (260.1 to 265.9), where row 6 had 270.1, and
with 1 tab 148.2 to 150.7 MB across the series. A tab therefore costs 2.9 MB of Noren's own between
30 and 100 tabs (web view 1.8 MB, console host 1.0 MB, `noren.exe` 0.1 MB): the growth is linear and
the fixed part (the total with one tab, about 149 MB) is a third of it. What the figure
leaves out, being the user's: the 100 shells are 3,659 MB of private working set (89 % of the private
working set of the tree) and 8,881 MB of working set here; no terminal that runs 100 of these shells
can count them and stay under 800 MB, which is why the definition of row 6 leaves them out. The 100
tabs did not bring the app or the machine down: all 100 prompts arrived in every repetition, the
script's wait for the report scales with the tabs (`resultWaitSeconds`), and no `noren.exe` was left.
Not verified (D19): the memory with the window shown; the margin to the target is 332 MB.

## Limits of these numbers

- **Headless Chromium, not the app.** The web build is the same interface, but the shell is the
  `FakeBackend` in the same page, there is no Tauri IPC channel (so no copy of 64 KB batches from
  Rust to the page) and the window is Chromium's, not WebView2. The sidebar and space numbers say
  how much work the interface itself does; the real app may add the WebView2 and the channel.
- **Renderer.** The WebGL addon was active in the headless browser. Whether the page drew with the
  GPU or with a software rasterizer was not determined, and the drawing speed of the terminal
  (rows 1 and 3) depends on it.
- **Real app, hidden window.** Rows 5 and 6 are the real release build, but with the main window
  hidden, as every `--smoke*` mode runs (`apps/desktop/src-tauri/tauri.conf.json:20`, kept hidden by
  `smoke::should_show_window` at `apps/desktop/src-tauri/src/main.rs:207`). Whether WebView2 loads
  the page, starts its processes and keeps its terminals slower or lighter with the window hidden
  than with it shown (a hidden page may skip frames and release its GPU surfaces) is not verified
  (D19): showing the window would take the focus of whoever is at the machine. The rows say what the
  hidden run costs; a person's first prompt and memory may differ from them by an amount that was
  not measured. What only shows with a visible window, such as the feel of dragging a divider while
  output comes in, is not verified either (D19): `apps/desktop/src/TerminalView.tsx` writes every
  chunk to xterm with `term.write(bytes)` and no flow control, so a producer much faster than the
  parser would be held in xterm's own queue (which discards above 50 MB); no such producer was seen
  here (the fastest feed of the harness, a timer-paced one, was drained as it came), so this is a
  hypothesis from reading the code, not a measurement.
- **What the first prompt leaves out.** The clock stops when xterm has taken the prompt in, not when
  the frame that shows it is painted (`apps/desktop/src/TerminalView.tsx:472`), which is one frame
  later in a shown window and is not observable in a hidden one. The shell is the one of this
  machine with the user's own profile (`$PROFILE` runs), and the web view cache of the machine is
  warm after the first run; a first start after an installation, with a cold cache, is not
  measured.
- **What the click stopwatch leaves out (finding #138).** It stops at the frame after the element
  changed, not at the frame that shows the text of the terminal that came on screen. A change that
  postpones the drawing of the new terminal by a few frames makes the number smaller without making
  the switch faster (an attempt in NOR-F11-01c did that, see row 4). The numbers of row 4 after that
  task were checked against the first WebGL draw of the shown terminal in the same page, which came
  before the frame the stopwatch stops at, but the spec itself does not check it.
- **One machine.** A faster or slower computer changes every figure; the ratios (idle against
  loaded, Noren against raw) are the part that travels.
