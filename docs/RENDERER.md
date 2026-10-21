# Terminal renderer: evaluation

Which program draws the characters of a terminal, what Noren uses now, and whether a native renderer
(libghostty) or WebGPU should replace it. This is the report of NOR-F20-04. It is an evaluation:
nothing was prototyped, no dependency was added and no code of the app changed. Changing the
renderer is a decision of the owner of the project, not of the loop; the
[Recommendation](#recommendation) is what the evidence supports, for that decision.

The numbers quoted come from [PERF.md](PERF.md) (rows 1 to 7), measured on one machine, in the release
build, with the window hidden (D19: nothing here was seen in a shown window).

## What the app uses today

xterm.js 6.0.0 (`@xterm/xterm`, MIT) with its WebGL addon 0.19.0 (`@xterm/addon-webgl`, MIT), in
the web view of the system (WebView2 on Windows, 155.0.4283.62 when measured). Both are in
`apps/desktop/package.json:19-20`. The addon is created in `apps/desktop/src/TerminalView.tsx`:

- `TerminalView.tsx:6` imports `WebglAddon`; `TerminalView.tsx:410-428` (`attachWebgl`) builds it and
  loads it with `term.loadAddon(addon)`. The context is made once the view has a size
  (`TerminalView.tsx:429-441`); a failure to make it (no WebGL2) or a lost context
  (`addon.onContextLoss`, `TerminalView.tsx:419`) drops the terminal back to xterm's DOM renderer,
  which is the fallback and needs nothing from the GPU.
- The browser allows 16 WebGL contexts per page and drops the oldest. With one terminal per tab
  mounted at once, `TerminalView` makes the context of the visible terminal first and queues the
  others one every 40 ms (`webglFirst`, `preloadWebgl`, `TerminalView.tsx:134-137`, `:207`), the fix
  of NOR-F11-01c. The finding left over from that task (#137) is that with more than 16 terminals
  the oldest lose their context and use the DOM renderer.
- The renderer is only one of the things the terminal uses from xterm.js. The others all read the
  xterm.js buffer and its API, not the pixels: the screen reader mode (`screenReaderMode`,
  `TerminalView.tsx:356`, which builds a DOM tree of its own, independent of the renderer), the
  addons fit, search, serialize (the saved scrollback), unicode11 and web-links, the link provider
  for file paths (`TerminalView.tsx:374`), the decorations and the overview ruler of the command
  marks (`TerminalView.tsx:359`, `:399`), selection, the parser hooks of the shell integration
  (`OSC 133`) and the text of the buffer that the agent state, the search and the AI context read.
  Replacing the renderer alone is a small change; replacing the thing that holds the buffer is
  a rewrite of all of these.

## What the measurements say about the renderer

Only three of the numbers of [PERF.md](PERF.md) can depend on the renderer, and none of them is
limited by it:

| Question                    | Measured                                                                                                                                                                        | Is the renderer the limit?                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Throughput (rows 1 to 3)    | 9.1 MB/s of numbers through the fake shell; 3.8 MB/s with 50 MB fed by a timer; the sidebar answers in 13 ms meanwhile. The real PTY: 0.5 MB/s (row 2)                          | No. The console host of Windows is 9 to 18 times slower than xterm.js draws, and Noren is at 99 % of the raw rate of the console          |
| Memory (rows 6 and 7)       | 2.9 MB per tab of Noren's own between 30 and 100 tabs, 1.8 MB of it in the web view (presumably the terminal of each tab in the page: buffer, WebGL context; not split further) | Partly. The web view is about 60 % of the growth per tab; 100 tabs are 467.5 MB against a target of 800 MB, so there is room              |
| First prompt (rows 5 and 7) | 478 to 526 ms; opening the terminal, WebGL context included, is 21 to 24 ms of it                                                                                               | Marginally. The renderer is under 5 % of the time; the web view start (about 40 %) and the page scripts (about 20 %) are not the renderer |

What the measurements cannot say, and are not verified (D19): how fast the WebGL renderer draws in a
window that is shown on a real GPU, the frame time while a heavy program scrolls, input latency
(key to pixel), and the cost on a machine without a good GPU, where the DOM fallback is used. These
are the numbers a renderer change would be judged on, and none of them was taken, because they need
a visible window. They are listed under "What is missing to know".

## Criteria

1. **Throughput and memory**, from PERF.md (above): a new renderer has to beat the numbers that
   renderer can change, and none of the measured ones is limited by it.
2. **License** allowed by `CLAUDE.md` for production dependencies (MIT, Apache-2.0, BSD, ISC, ...).
3. **Maturity and a stable API**: something the app can depend on without carrying the maintenance
   of someone else's moving internals.
4. **Windows first**, then macOS and Linux: Noren uses the web view of each system, so what works on
   WebView2 may not work on WKWebView or WebKitGTK.
5. **Accessibility and the screen reader mode**: the interface passes axe on every surface
   (NOR-F20-01b, 01c) and has a manual script for NVDA and Narrator ([ACCESSIBILITY.md](ACCESSIBILITY.md)).
   The terminal's screen reader mode must stay.
6. **Effort**, in sizes (S: days, M: a few weeks, L: months; estimates, not measurements).
7. **Risk of the rewrite that `CLAUDE.md` forbids**: "do not ... write a custom terminal renderer".
   An option that needs Noren to write its own renderer is outside the rules until the owner changes
   them.

## Option A: keep xterm.js with the WebGL addon (the baseline)

- **Pros.** It is what the app, its 5,600 unit tests and about 980 end-to-end tests are built on; the
  e2e and the perf specs run the same terminal in headless Chromium, so what is tested is what runs.
  MIT, active, widely deployed. Works on WebView2, WKWebView and WebKitGTK, with a DOM fallback
  where there is no WebGL. The screen reader mode, search, serialize and links all come with it.
- **Cons.** One WebGL context per terminal and 16 per page, handled by the queue of
  `preloadWebgl` but not removed (#137). The drawing runs on the page's main thread (JavaScript
  prepares the cells; the GPU draws them), so it shares that thread with React. Third-party
  rendering code that Noren does not control.
- **What is missing to know.** Frame time and input latency in a shown window on a real GPU (D19), and
  the cost of the DOM fallback on a machine with no usable GPU.

## Option B: WebGPU in the web view

Draw the terminal with WebGPU instead of WebGL, in the same web view.

- **What exists.** The sources found for this report do not show a WebGPU renderer or addon for
  xterm.js: the WebGL addon is the GPU path. So this option means either (B1) writing a WebGPU renderer
  for xterm.js, which is a custom terminal renderer by the rule of `CLAUDE.md`, or (B2) waiting for
  upstream to ship one.
- **Pros.** WebGPU can draw the whole grid of cells in one pass with less per-call driver cost than
  WebGL, can use compute for the glyph atlas, and does not carry the limit of 16 contexts per page the
  way WebGL does (to be confirmed: one device could serve every terminal). Stays in the web stack:
  same buffer, same addons, same screen reader tree, same e2e.
- **Cons.** The availability is uneven: a Chromium-based web view (WebView2) can offer it on Windows
  through Direct3D 12, but Noren uses a different web view on each system, and the WebGPU status of
  WebKitGTK on Linux and of the WKWebView of the macOS versions Noren targets is not established
  here. A WebGPU renderer would need the WebGL path anyway as the fallback, so it adds a renderer
  instead of replacing one. The gain for drawing a grid of text is small next to the cost:
  the measured limits are the console host and the web view start, not the GPU.
- **What is missing to know.** Whether `navigator.gpu` is on in the WebView2 of the app on a person's
  machine (it can be checked by a hidden `--smoke` mode, with no window, in a later task); whether the
  16-context limit really goes away; what upstream's plans are. Effort: M for B2 (adopt and test an
  upstream addon), L for B1 (and forbidden as it stands).

## Option C: a native renderer from libghostty

libghostty is the library that the Ghostty terminal is made of, so that other programs can embed
its terminal emulation and, over time, its renderer.

- **What exists** (public documentation and discussions found in October 2026, not re-read from the
  repository in this round): the part meant for embedding today is `libghostty-vt`, the emulation core
  (the parser and the state of the screen), with a C API that is described as work in progress and
  not stable. The rest of the library is described as used mainly by the macOS app, with its API
  free to change between releases. Its renderers are Metal on macOS and OpenGL on Linux; there is
  no Windows renderer and no Windows frontend, and the discussions put the first Windows work late in
  2026 with no commitment. It is written in Zig, so using it adds the Zig toolchain to the build
  (outside the stack of D5: Rust and TypeScript). The license of the project is MIT (to be confirmed
  against the repository before any decision).
- **Two ways to use it.**
  - **C1: `libghostty-vt` as the emulator, drawing still done by Noren.** This replaces xterm.js's
    parser and buffer, so the search, serialize, links, command marks, screen reader tree and the agent
    state would all have to be rebuilt on a new buffer, and the drawing would be a renderer written by
    Noren (the thing `CLAUDE.md` forbids) or a return to xterm.js, which cannot take another
    emulator's buffer.
  - **C2: a native surface drawn by libghostty, placed over or beside the web view.** The
    interface (React, in the web view) and the terminal (a native window) would live in separate
    surfaces: the splits, the drag of tabs, the overlays, the palette and the peek would have to be
    laid over a window that the web view cannot draw above. It needs the missing Windows renderer.
- **Pros.** A native renderer off the page's main thread; the emulation of a project that is
  developed for exactly this purpose; no 16-context limit; the DOM and WebGL fallbacks go away on
  the platforms where it works.
- **Cons.** Not stable; no renderer on Windows, the first platform of Noren; a second language and
  toolchain; the screen reader mode, the axe tests, the links, the search and the saved scrollback
  would be rebuilt; the web-mode e2e (`FakeBackend` in Chromium, 980 tests and the perf specs) could not see
  a native surface at all, so the test strategy of the project changes; accessibility would need a
  native provider (UI Automation on Windows) that nobody has written; Noren would depend on a
  moving library of one project.
- **What is missing to know.** The state of the C API and of a Windows renderer when someone
  needs it (the documents said "not yet", with a date in the future); whether a surface can be
  embedded in a Tauri window with the web view above it; the licenses of all its dependencies
  (Noren's list is strict). Effort: L, and C2 on Windows is blocked until upstream has a Windows
  renderer.

## Comparison

| Criterion                       | A: xterm.js + WebGL (now)     | B: WebGPU in the web view                         | C: libghostty                               |
| ------------------------------- | ----------------------------- | ------------------------------------------------- | ------------------------------------------- |
| Throughput, memory              | Not the limit (PERF.md)       | Same limits (PTY and web view); small gain        | Same limits; moves terminals off the page   |
| License                         | MIT                           | MIT if upstream's; B1 would be Noren's own        | MIT (to confirm); adds the Zig toolchain    |
| Maturity, stable API            | Stable, widely used           | No renderer found; WebGPU uneven across web views | C API not stable; no Windows renderer       |
| Windows first                   | Yes (WebView2)                | Likely (Chromium, D3D12); not verified            | No renderer on Windows today                |
| Screen reader, axe              | Works, has a script and tests | Same tree; unchanged                              | Rebuilt: native provider, new tests         |
| Effort                          | none                          | M (adopt upstream) / L (write one)                | L                                           |
| Forbidden rewrite (`CLAUDE.md`) | No                            | B1 yes, B2 no                                     | C1 and C2 need a renderer or a new emulator |

## Recommendation

**Keep xterm.js with the WebGL addon for version 1. Do not start either replacement now, and do not
open a renderer task.**

1. **The measured limits are elsewhere.** Throughput is held by the Windows console host (0.5 MB/s
   against the 9 MB/s xterm.js draws), the first prompt by the start of the web view and the page
   scripts, and memory by the shells and the web view's fixed part. No renderer changes those, so a
   renderer swap would cost months and move none of the three targets of
   [PERF.md](PERF.md).
2. **Neither alternative can be adopted under the rules and the state of the art.** libghostty has
   no Windows renderer and no stable API; its use means Noren writing a renderer or dropping
   xterm.js, which `CLAUDE.md` forbids and which breaks the screen reader mode, the axe tests, the
   search, the links and the saved scrollback. A WebGPU addon does not exist upstream; writing it is
   a custom renderer too, for a gain the numbers do not show.
3. **The cost of waiting is low.** The fallbacks work (the DOM renderer when WebGL is missing), the
   16-context limit is handled by the queue and is a known finding (#137), and nothing in the
   release targets needs a faster renderer.

**What would change the recommendation** (re-open the question when one of these holds):

- a measurement in a shown window, by the owner (D19 keeps the loop from taking it), of frame time
  or input latency with a heavy program that is over the target, so that the renderer is shown to be
  the limit;
- upstream xterm.js ships a WebGPU renderer, or libghostty announces a stable embedding API with a
  Windows renderer and a documented way to place its surface in a Tauri window, with the
  accessibility problem solved;
- the owner decides to accept a second language (Zig) or a custom renderer, and edits the rules
  of `CLAUDE.md` to say so.

**Cheap steps that need no decision and break no rule**, for a later task if the owner wants them:
a hidden `--smoke` mode that reads `navigator.gpu` and the WebGL renderer string in the real
WebView2 (no window needed), so that B is judged on a fact; and a frame-time measurement that the
owner runs with the window shown, following the script style of [ACCESSIBILITY.md](ACCESSIBILITY.md).
