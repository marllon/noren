# Performance

The targets of the product, how each one is measured, and what was measured. Three tasks fill this
page: NOR-F11-01a (the measurements that need no window, rows 1 to 4 of "Results"), NOR-F11-01b
(the ones that need the real app in a release build: the first prompt and the memory of 30 tabs,
rows 5 and 6) and NOR-F11-01c (why the first switch of space was sometimes slow, and the fix, row 4).

## Targets

| #   | Target (spec, section 11)                                                  | Measured in | Status                                                                                                                          |
| --- | -------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Opening the app to the first prompt: under 800 ms (release, Windows)       | NOR-F11-01b | **not met**: 958 ms median (894 to 997), 158 ms over; NOR-F11-01d                                                               |
| 2   | `cat` of 50 MB does not freeze the interface: the sidebar answers < 100 ms | NOR-F11-01a | **met** (13 ms)                                                                                                                 |
| 3   | 30 tabs open: total memory under 500 MB                                    | NOR-F11-01b | **not met**: 3,651 MB of working set summed over the tree (private working set 1,384 MB), 30 shells are 83 % of it; NOR-F11-01e |
| 4   | Changing space: under 100 ms                                               | NOR-F11-01a | **met** (16 ms), also the first switch of a page (43.7 ms median, worst 49.8 of 25) after NOR-F11-01c                           |
|     | Terminal throughput (no number in the spec)                                | NOR-F11-01a | measured, see below                                                                                                             |

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
  start of `main` in the app (it leaves out the loader of Windows, a lower bound).
- **Memory** is the sum of the working set of every process in the tree under `noren.exe` (the web
  view processes, the shells and their console hosts), read from the process list after the 30
  prompts are in and the app has been left alone for 3 seconds; three readings, 1 second apart, and
  the median of the three is the figure of the repetition. A working set counts the pages that
  processes share once per process, so the sum leans high; the private working set (each page once,
  what is not shared) is quoted beside it. Both are split by who owns the process.
- Nothing here opens a window or sends a key to the desktop.

## How to run

From the repository root, on a machine you will leave alone for about 20 minutes:

```text
node scripts/perf.mjs              # web measurements, then the real PTY
node scripts/perf.mjs --skip-pty   # only the web ones (about 2 minutes)
node scripts/perf.mjs --skip-e2e   # only the PTY ones (about 17 minutes)
node scripts/perf.mjs --only-app   # only the real app: release build, then 5 + 5 hidden runs (about 5 minutes)
```

`--only-app` also takes `--no-build` (use the release binary that is there). It refuses to start if a
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
(see "Method" for what the clock starts and stops on):

| Repetition                                 | 1    | 2   | 3   | 4   | 5   | Median  | Min / max  |
| ------------------------------------------ | ---- | --- | --- | --- | --- | ------- | ---------- |
| **From the creation of the process**       | 960  | 913 | 894 | 958 | 997 | **958** | 894 / 997  |
| From the launch call in the script (upper) | 1164 | 915 | 895 | 960 | 999 | 960     | 895 / 1164 |
| From the start of `main` (lower)           | 878  | 844 | 826 | 882 | 923 | 878     | 826 / 923  |
| `app-ready` of the page, from `main`       | 825  | 806 | 808 | 833 | 838 | 825     | 806 / 838  |

The two cross-checks bracket the figure (878 to 960 ms) and the five repetitions sit within 103 ms
of one another (the 1164 ms is the first launch of the series, the slow creation of a process by
Node, which the system's own creation time leaves out). With 30 tabs saved, the first prompt of
any of them took 1,761 ms (median; 1,667 to 1,901) and the last of the 30 took 1,936 ms (1,761 to
2,183): the app starts the shells one after the other before the page appears.

**Target: under 800 ms. Verdict: not met.** The median is 958 ms, 158 ms over, and even the best
repetition (894 ms) is 94 ms over; the spread is small against that gap, so it is not noise.
The page says `app-ready` at about 825 ms after `main` and the prompt is on screen 18 to 85 ms
later, so most of the time is before the interface exists (the web view starting, the page's
scripts, the boot of the workspace, which starts the shells), not the shell itself. That is a
reading of the two clocks, not a profile: finding out is the task NOR-F11-01d.

### 6. Memory with 30 tabs open (real app, release build)

`noren --smoke-perf --perf-tabs 30`: 30 tabs in one space, one Windows PowerShell each, all 30
prompts on screen, 3 seconds of rest, then the process list. 5 repetitions, in MB (1 MB = 1,048,576
bytes), each the median of three readings:

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

**Target: 30 tabs open, total memory under 500 MB. Verdict: not met** by the measure this task
defines (working set summed over the tree): 3,650.7 MB, 7.3 times the target. By the private
working set it is 1,383.7 MB, still 2.8 times over. Noren and its web view alone (leaving the
shells out) are about 619 MB of working set and about 241 MB private, so the target is met only
if the shells are not counted and the private measure is the one that counts; the spec does not say
which. The 30 shells are 83 % of the working set, and the shell of this machine is Windows
PowerShell 5.1 with the user's own profile, so the figure moves with the shell and the profile.
Task NOR-F11-01e was opened for it; its first step is to decide what "total memory" counts.

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
  `smoke::should_show_window` at `apps/desktop/src-tauri/src/main.rs:191`). Whether WebView2 loads
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
  the frame that shows it is painted (`apps/desktop/src/TerminalView.tsx:469`), which is one frame
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
