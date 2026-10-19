# Performance

The targets of the product, how each one is measured, and what was measured. Two tasks fill this
page: NOR-F11-01a (the measurements that need no window, below) and NOR-F11-01b (the ones that need
the real app in a release build: the first prompt and the memory of 30 tabs).

## Targets

| #   | Target (spec, section 11)                                                  | Measured in | Status                                                                                         |
| --- | -------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| 1   | Opening the app to the first prompt: under 800 ms (release, Windows)       | NOR-F11-01b | not measured yet                                                                               |
| 2   | `cat` of 50 MB does not freeze the interface: the sidebar answers < 100 ms | NOR-F11-01a | **met** (13 ms)                                                                                |
| 3   | 30 tabs open: total memory under 500 MB                                    | NOR-F11-01b | not measured yet                                                                               |
| 4   | Changing space: under 100 ms                                               | NOR-F11-01a | **met** (16 ms), except the first switch of a page (56.5 ms median, up to 155 ms): NOR-F11-01c |
|     | Terminal throughput (no number in the spec)                                | NOR-F11-01a | measured, see below                                                                            |

## Machine

One machine, left alone while the numbers were taken (no other build or test running).

| Part    | Value                                                                               |
| ------- | ----------------------------------------------------------------------------------- |
| CPU     | Intel Core i9-14900K (24 cores, 32 threads)                                         |
| Memory  | 63.8 GB (DDR5-4800)                                                                 |
| GPU     | NVIDIA GeForce RTX 4090 (the headless Chromium may or may not use it; see "Limits") |
| System  | Windows 11 Pro, build 10.0.26200                                                    |
| Browser | Chromium 156.0.8078.4 (the Playwright build), headless                              |
| Tools   | Node 24.2.0, Rust 1.99.1 (`--release` for the PTY test)                             |

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
- Nothing here opens a window or sends a key to the desktop.

## How to run

From the repository root, on a machine you will leave alone for about 20 minutes:

```text
node scripts/perf.mjs              # web measurements, then the real PTY
node scripts/perf.mjs --skip-pty   # only the web ones (about 2 minutes)
node scripts/perf.mjs --skip-e2e   # only the PTY ones (about 17 minutes)
```

or each part by itself:

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
other space for the first time. The spec was run 5 times in all (the final run, three more runs
back to back with `--repeat-each=3`, and once inside `pnpm e2e`), 25 repetitions.

Later switches (the ones after the first, over the 5 runs): the median of each run was 15.5, 15.8,
15.4, 15.7 and 15.5 ms; the slowest single switch in any run was 27.8 ms.

First switch of the page, in ms, by run (5 repetitions each):

| Run                              | Repetitions                      | Median |
| -------------------------------- | -------------------------------- | ------ |
| Final run                        | 61.2, 57.8, 58.1, 55.0, 52.8     | 57.8   |
| Inside `pnpm e2e` (busy machine) | 54.8, 51.3, 61.2, 56.5, 55.7     | 55.7   |
| Back to back, 1st                | 55.3, 55.3, 57.5, 55.3, 47.9     | 55.3   |
| Back to back, 2nd                | 129.8, 51.5, 53.7, 152.6, 50.3   | 53.7   |
| Back to back, 3rd                | 141.1, 154.6, 142.2, 137.4, 71.3 | 141.1  |
| **All 25**                       |                                  | 56.5   |

The first switch has two modes: about 55 ms most of the time, and about 130 to 155 ms in 6 of the 25
repetitions (all in the last two runs, one after the other). The later switches did not change in
those runs, so the machine was not simply slower; something that only the first switch of a page does
(drawing the other space for the first time, compiling code that has not run yet) costs two and a
half times more some of the time. The cause was not found here.

**Target: under 100 ms. Verdict: met for every switch after the first (16 ms), with every terminal
of the 30 tabs alive; not met for the first switch of a page**: the median of 25 is 56.5 ms, but 6 of
25 are over 100 ms and the worst is 154.6 ms. Task NOR-F11-01c was opened for it.

## Limits of these numbers

- **Headless Chromium, not the app.** The web build is the same interface, but the shell is the
  `FakeBackend` in the same page, there is no Tauri IPC channel (so no copy of 64 KB batches from
  Rust to the page) and the window is Chromium's, not WebView2. The sidebar and space numbers say
  how much work the interface itself does; the real app may add the WebView2 and the channel.
- **Renderer.** The WebGL addon was active in the headless browser. Whether the page drew with the
  GPU or with a software rasterizer was not determined, and the drawing speed of the terminal
  (rows 1 and 3) depends on it.
- **Real app, release build.** The time to the first prompt and the memory of 30 tabs need the app
  itself in a release build: they are the task NOR-F11-01b (a hidden `--smoke-perf` mode). What
  only shows with a visible window, such as the feel of dragging a divider while output comes in,
  is not verified (D19): `apps/desktop/src/TerminalView.tsx` writes every chunk to xterm with
  `term.write(bytes)` and no flow control, so a producer much faster than the parser would be
  held in xterm's own queue (which discards above 50 MB); no such producer was seen here (the
  fastest feed of the harness, a timer-paced one, was drained as it came), so this is a hypothesis
  from reading the code, not a measurement.
- **One machine.** A faster or slower computer changes every figure; the ratios (idle against
  loaded, Noren against raw) are the part that travels.
