import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { DEFAULT_TERMINAL_OPTIONS, SCROLLBACK_SAVE_LINES, joinRows } from "@noren/model";
import type { Backend, SessionId, TerminalOptions } from "@noren/model";
import { useEffect, useRef, useState } from "react";
import { PasteDialog } from "./PasteDialog";
import { BELL_FLASH_MS, beep, beeps, flashes } from "./bell";
import { attachCommandMarks, markColors } from "./command-marks-view";
import type { CommandMarkInfo, CommandOutput, TerminalCommandMarks } from "./command-marks-view";
import type { ExplainRequest } from "./ask-panel";
import { parseOsc7 } from "./osc7";
import { decidePaste, insertableText } from "./paste";
import { watchFirstPrompt } from "./first-prompt";
import { reportPromptShown } from "./perf-probe";
import { isTranslucent } from "./theme";

/** What a right click does: copy the selection or paste, always paste, or leave the native menu. */
export type RightClickAction = "copy-or-paste" | "paste" | "menu";

/** What xterm draws with, as it has it now: the options of the terminal settings and the zoom. */
export interface TerminalDrawing {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: string;
  cursorBlink: boolean;
  scrollback: number;
}

/** Read-only view of a mounted terminal, for tests and diagnostics. */
export interface TerminalHandle {
  /** The font, cursor and scrollback xterm has now (what the settings and the zoom made of them). */
  drawing(): TerminalDrawing;
  /** Text of every line in the buffer (scrollback included), without trailing spaces. */
  readLines(): string[];
  /** Renderer in use: the WebGL addon, or xterm's DOM renderer after a fallback. */
  renderer(): "webgl" | "dom";
  /** Gives the terminal the keyboard. */
  focus(): void;
  /**
   * Scrolls the buffer so that row `row` (0 is the top of the scrollback) sits in the middle of the
   * view and selects the whole line, so it shows highlighted. Returns false when the row does not
   * exist or holds no text.
   */
  revealLine(row: number): boolean;
  /** The text now selected in the terminal (empty when nothing is). */
  selection(): string;
  /** The rows on screen: the buffer row at the top of the view and how many rows the view holds. */
  viewport(): { top: number; rows: number };
  /** The commands the shell reported that are still in the buffer, oldest first (see `docs/SHELL_INTEGRATION.md`). */
  marks(): CommandMarkInfo[];
  /**
   * Scrolls to the prompt of the previous or next command. False when the terminal has no command
   * mark to go to (no integrated shell, or a program on the alternate screen), so the key is the
   * shell's.
   */
  jumpToPrompt(direction: "previous" | "next"): boolean;
  /**
   * Selects the output of the command the user stepped to, or of the last command that ended. False
   * when there is none or it printed nothing.
   */
  selectOutput(): boolean;
  /** The output of the last command that ended; undefined when none did. */
  lastOutput(): CommandOutput | undefined;
  /**
   * The text of the rows on screen (what the view shows now, scrolled or not): one line per logical
   * line, a wrapped line joined again, the blank rows at the end dropped.
   */
  screen(): string;
  /**
   * Puts `text` at the prompt as if it were pasted, and gives the terminal the keyboard. Never
   * presses Enter: the line breaks at the ends are dropped and control characters are taken out
   * (`insertableText`), and text of several lines asks the person first, like any paste. False when
   * nothing is left to put.
   */
  insert(text: string): boolean;
  /**
   * The text of the rows of the buffer whose characters are all dimmed (a row with no text is not
   * one). The scrollback shown again is dimmed, and what the new shell prints is not: this tells
   * them apart whatever renderer draws them.
   */
  dimLines(): string[];
  /**
   * The last lines of the terminal as the serialize addon writes them (text and colors, and the
   * cursor moves it needs for empty cells), for the scrollback snapshot. It is raw: `cleanSnapshot`
   * is what makes it fit to keep. `lines` asks for fewer scrollback lines than the snapshot keeps
   * (the peek of a tab wants the last few, not two thousand).
   */
  snapshot(lines?: number): string;
}

interface TerminalViewProps {
  backend: Backend;
  /**
   * Session to show. When left out the view starts a shell of its own. Read once, on mount:
   * changing it later does not restart the terminal.
   */
  attach?: SessionId;
  /** Shell profile to start; the backend's default profile when left out. Read once. */
  profileId?: string;
  /** Starting directory of the new shell. Read once. */
  cwd?: string;
  /** Extra environment of the new shell. Read once. */
  env?: Record<string, string>;
  /**
   * Text to write to the terminal before anything the session prints: the scrollback saved before,
   * dimmed, and the line "session restored" (`restoredTerminalText`). It must already be clean.
   * Read once, on mount.
   */
  restored?: string;
  /**
   * Called with the session the view started. The caller owns it from then on: the view no longer
   * ends it on unmount. Without this callback the view ends its own session when it goes away.
   */
  onSessionStart?(id: SessionId): void;
  /**
   * False for a view that is not on screen and is not the first thing its space will show: its WebGL
   * context is made in its turn, a little after the mount, not in the mount (see `preloadWebgl`).
   * Read once, on mount. True when left out.
   */
  webglFirst?: boolean;
  /** Colors of the terminal; changing them repaints the live terminal. */
  theme: ITheme;
  /**
   * Font, cursor, scrollback and bell (the `terminal` settings, with the zoom). Changing them
   * changes the live terminal; its session goes on. The defaults when left out.
   */
  options?: TerminalOptions;
  /** False while the view is hidden (another tab shows). Default true. */
  active?: boolean;
  /** Default `copy-or-paste`. */
  rightClick?: RightClickAction;
  /** Called once the terminal is mounted. */
  onReady?(handle: TerminalHandle): void;
  /**
   * Called with the command and the output of a failed command when its Explain button is pressed.
   * Without it (where the AI is off) the failed commands have no button.
   */
  onExplain?(request: ExplainRequest): void;
  /** Called with the folder the shell reports through OSC 7 (at each prompt of an integrated shell). */
  onCwd?(path: string): void;
  /**
   * Called with every chunk of the session's output, in order, once it went to the terminal. The
   * first chunks are the ones the session printed before the view subscribed.
   */
  onOutput?(bytes: Uint8Array): void;
}

/** Pause between the WebGL contexts that views out of sight get ahead of their first show. */
const WEBGL_PRELOAD_STEP_MS = 40;

const preloadQueue: (() => void)[] = [];
let preloadTimer: ReturnType<typeof setTimeout> | undefined;

function runNextPreload(): void {
  preloadTimer = undefined;
  preloadQueue.shift()?.();
  if (preloadQueue.length > 0) preloadTimer = setTimeout(runNextPreload, WEBGL_PRELOAD_STEP_MS);
}

/**
 * Queues `attach` (creating the WebGL context of a view that is not on screen) to run in its turn,
 * one every `WEBGL_PRELOAD_STEP_MS`, and returns the function that takes it off the queue. A start
 * with many tabs mounts every terminal at once; creating all their contexts in that same moment
 * kept the graphics process busy for a second, and whatever the person did first (switching space)
 * waited behind it for 130 to 160 ms. Spread out, the same contexts are there a moment later and
 * nothing waits for them.
 */
function preloadWebgl(attach: () => void): () => void {
  preloadQueue.push(attach);
  preloadTimer ??= setTimeout(runNextPreload, WEBGL_PRELOAD_STEP_MS);
  return () => {
    const at = preloadQueue.indexOf(attach);
    if (at >= 0) preloadQueue.splice(at, 1);
  };
}

function isShortcut(event: KeyboardEvent, code: string): boolean {
  return (
    event.type === "keydown" &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.code === code
  );
}

/** One xterm bound to one backend session, which lives as long as the view. */
export function TerminalView({
  backend,
  attach,
  profileId,
  cwd,
  env,
  restored,
  onSessionStart,
  webglFirst = true,
  theme,
  options = DEFAULT_TERMINAL_OPTIONS,
  active = true,
  rightClick,
  onReady,
  onCwd,
  onExplain,
  onOutput,
}: TerminalViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const marksRef = useRef<TerminalCommandMarks | null>(null);
  const rightClickRef = useRef<RightClickAction>(rightClick ?? "copy-or-paste");
  const onReadyRef = useRef(onReady);
  const onCwdRef = useRef(onCwd);
  const onExplainRef = useRef(onExplain);
  const onOutputRef = useRef(onOutput);
  const onSessionStartRef = useRef(onSessionStart);
  const activeRef = useRef(active);
  const themeRef = useRef(theme);
  const optionsRef = useRef(options);
  const viewRef = useRef<HTMLDivElement>(null);
  const refitRef = useRef<(() => void) | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // What the shell starts with is fixed when the view mounts; a later change must not restart it.
  const [start0] = useState(() => ({ attach, profileId, cwd, env, restored, webglFirst }));

  useEffect(() => {
    rightClickRef.current = rightClick ?? "copy-or-paste";
    onReadyRef.current = onReady;
    onCwdRef.current = onCwd;
    onExplainRef.current = onExplain;
    onOutputRef.current = onOutput;
    onSessionStartRef.current = onSessionStart;
    activeRef.current = active;
    themeRef.current = theme;
    optionsRef.current = options;
  });

  // A new theme repaints the terminal that is already running.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.allowTransparency = isTranslucent(theme.background);
      termRef.current.options.theme = theme;
    }
    marksRef.current?.setColors(markColors(theme));
  }, [theme]);

  // The failed commands have an Explain button while there is somewhere to send it (the AI is on).
  const explains = onExplain !== undefined;
  useEffect(() => {
    marksRef.current?.setExplain(
      explains ? (request) => onExplainRef.current?.(request) : undefined,
    );
  }, [explains]);

  // New options (the file changed, or the font was zoomed) change the terminal that is running; the
  // session is not touched. The size of a cell may have changed, so the grid is fitted again.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = options.fontFamily;
    term.options.fontSize = options.fontSize;
    term.options.lineHeight = options.lineHeight;
    term.options.cursorStyle = options.cursorStyle;
    term.options.cursorBlink = options.cursorBlink;
    term.options.scrollback = options.scrollback;
    refitRef.current?.();
  }, [options]);

  // Showing a tab again gives it the keyboard.
  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  useEffect(() => {
    const host = container.current;
    if (!host) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: optionsRef.current.cursorBlink,
      cursorStyle: optionsRef.current.cursorStyle,
      fontFamily: optionsRef.current.fontFamily,
      fontSize: optionsRef.current.fontSize,
      lineHeight: optionsRef.current.lineHeight,
      scrollback: optionsRef.current.scrollback,
      // The ruler beside the scrollbar shows the commands that failed. 14 is the scrollbar width
      // xterm.js uses without a ruler, so the terminal keeps the columns it had.
      overviewRuler: { width: 14 },
      // A background with an alpha (the interface is see-through, or a picture shows behind the
      // terminal) needs this to be drawn as such; a solid one is drawn as it always was.
      allowTransparency: isTranslucent(themeRef.current.background),
      theme: themeRef.current,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new SearchAddon());
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    term.unicode.activeVersion = "11";
    term.open(host);
    const commandMarks = attachCommandMarks(term, markColors(themeRef.current));
    marksRef.current = commandMarks;
    if (onExplainRef.current !== undefined) {
      commandMarks.setExplain((request) => onExplainRef.current?.(request));
    }

    let disposed = false;

    // WebGL is the fast path; any failure (no WebGL2, lost context) drops back to the DOM renderer.
    // The view on screen, and the one that each space will show first, get their context now. The
    // others get it in their turn (see `preloadWebgl`), or at once if shown before that.
    let webgl: WebglAddon | null = null;
    let webglTried = false;
    let leaveQueue: (() => void) | undefined;
    const attachWebgl = () => {
      if (webglTried || disposed) return;
      webglTried = true;
      leaveQueue?.();
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          webgl = null;
        });
        term.loadAddon(addon);
        webgl = addon;
      } catch {
        webgl = null;
      }
    };
    const hasSize = () => host.clientWidth > 0 && host.clientHeight > 0;
    if (start0.webglFirst || hasSize()) attachWebgl();
    else leaveQueue = preloadWebgl(attachWebgl);

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // The container has no size yet (hidden or detached); the next observation fits.
      }
      if (hasSize()) attachWebgl();
    };
    safeFit();
    refitRef.current = safeFit;

    // The bell: the pane flashes and/or beeps as the settings say (the tab is marked either way).
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const bellSub = term.onBell(() => {
      const style = optionsRef.current.bell;
      if (beeps(style)) beep();
      const view = viewRef.current;
      if (!flashes(style) || !view) return;
      view.classList.add("bell-flash");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => view.classList.remove("bell-flash"), BELL_FLASH_MS);
    });

    let sessionId: SessionId | undefined;
    const cleanups: (() => void)[] = [];

    const send = (text: string) => {
      term.paste(text);
    };
    const requestPaste = (text: string) => {
      const decision = decidePaste(text);
      if (decision === "send") send(text);
      else if (decision === "confirm") setPending(text);
    };
    const pasteFromClipboard = () => {
      navigator.clipboard.readText().then(requestPaste, () => undefined);
    };
    const copySelection = () => {
      const selection = term.getSelection();
      if (selection !== "") navigator.clipboard.writeText(selection).catch(() => undefined);
    };

    term.attachCustomKeyEventHandler((event) => {
      if (isShortcut(event, "KeyC")) {
        event.preventDefault();
        copySelection();
        return false;
      }
      if (isShortcut(event, "KeyV")) {
        event.preventDefault();
        pasteFromClipboard();
        return false;
      }
      return true;
    });

    // Native pastes (Ctrl+V, Shift+Insert, browser menu) also go through the confirmation.
    const onNativePaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      requestPaste(event.clipboardData?.getData("text/plain") ?? "");
    };
    host.addEventListener("paste", onNativePaste, true);

    const onContextMenu = (event: MouseEvent) => {
      const action = rightClickRef.current;
      if (action === "menu") return;
      event.preventDefault();
      if (action === "copy-or-paste" && term.hasSelection()) {
        copySelection();
        term.clearSelection();
      } else {
        pasteFromClipboard();
      }
    };
    host.addEventListener("contextmenu", onContextMenu);

    const observer = new ResizeObserver(safeFit);
    observer.observe(host);

    // The shell says which folder it is in (OSC 7); the sequence is consumed here, never drawn.
    const cwdHandler = term.parser.registerOscHandler(7, (data) => {
      const path = parseOsc7(data);
      if (path !== undefined) onCwdRef.current?.(path);
      return true;
    });
    const dataSub = term.onData((data) => {
      if (sessionId !== undefined) backend.write(sessionId, data).catch(() => undefined);
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (sessionId !== undefined) backend.resize(sessionId, cols, rows).catch(() => undefined);
    });

    // The scrollback saved before is written first: xterm keeps what is written in order, so it
    // sits above everything the new session prints, including what it printed before this mounted.
    if (start0.restored !== undefined && start0.restored !== "") term.write(start0.restored);

    let ownsSession = false;
    const start = async () => {
      const startCols = term.cols;
      const startRows = term.rows;
      let id: SessionId;
      if (start0.attach !== undefined) {
        id = start0.attach;
      } else {
        id = await backend.createSession({
          ...(start0.profileId !== undefined ? { profileId: start0.profileId } : {}),
          ...(start0.cwd !== undefined ? { cwd: start0.cwd } : {}),
          ...(start0.env !== undefined ? { env: start0.env } : {}),
          cols: startCols,
          rows: startRows,
        });
        if (disposed) {
          void backend.kill(id).catch(() => undefined);
          return;
        }
        const handOff = onSessionStartRef.current;
        if (handOff) handOff(id);
        else ownsSession = true;
      }
      sessionId = id;
      const firstPrompt = watchFirstPrompt();
      cleanups.push(
        backend.onOutput(id, (bytes) => {
          // The first prompt is reported once xterm has taken the chunk in (`noren --smoke-perf`).
          if (firstPrompt(bytes)) term.write(bytes, () => reportPromptShown(id));
          else term.write(bytes);
          onOutputRef.current?.(bytes);
        }),
      );
      cleanups.push(
        backend.onExit((exit) => {
          if (exit.id === id) term.write(`\r\n[Process exited with code ${exit.code}]\r\n`);
        }),
      );
      // The view may have been resized while the session was starting. A session taken over (a shell
      // promoted from the quick window) was sized for the view it came from: it learns this one's.
      if (start0.attach !== undefined || term.cols !== startCols || term.rows !== startRows) {
        backend.resize(id, term.cols, term.rows).catch(() => undefined);
      }
    };
    start().catch((error: unknown) => {
      if (disposed) return;
      const reason = error instanceof Error ? error.message : String(error);
      term.write(`\r\n[Could not start the shell: ${reason}]\r\n`);
    });

    onReadyRef.current?.({
      drawing: () => ({
        fontFamily: term.options.fontFamily ?? "",
        fontSize: term.options.fontSize ?? 0,
        lineHeight: term.options.lineHeight ?? 0,
        cursorStyle: term.options.cursorStyle ?? "",
        cursorBlink: term.options.cursorBlink ?? false,
        scrollback: term.options.scrollback ?? 0,
      }),
      readLines: () => {
        const buffer = term.buffer.active;
        const lines: string[] = [];
        for (let y = 0; y < buffer.length; y++) {
          lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
        }
        return lines;
      },
      renderer: () => (webgl ? "webgl" : "dom"),
      focus: () => term.focus(),
      revealLine: (row) => {
        const buffer = term.buffer.active;
        const length = buffer.getLine(row)?.translateToString(true).length ?? 0;
        if (length === 0) return false;
        const top = Math.max(
          0,
          Math.min(row - Math.floor(term.rows / 2), buffer.length - term.rows),
        );
        term.scrollToLine(top);
        term.select(0, row, length);
        return true;
      },
      selection: () => term.getSelection(),
      viewport: () => ({ top: term.buffer.active.viewportY, rows: term.rows }),
      marks: () => commandMarks.marks(),
      jumpToPrompt: (direction) => commandMarks.jump(direction),
      selectOutput: () => commandMarks.selectOutput(),
      lastOutput: () => commandMarks.lastOutput(),
      screen: () => {
        const buffer = term.buffer.active;
        return joinRows(
          (row) => {
            const line = buffer.getLine(row);
            return line === undefined
              ? undefined
              : { text: line.translateToString(true), wrapped: line.isWrapped };
          },
          buffer.viewportY,
          term.rows,
        ).replace(/\s+$/, "");
      },
      insert: (text) => {
        const clean = insertableText(text);
        if (clean === "") return false;
        requestPaste(clean);
        term.focus();
        return true;
      },
      dimLines: () => {
        const buffer = term.buffer.active;
        const cell = buffer.getNullCell();
        const dimmed: string[] = [];
        for (let y = 0; y < buffer.length; y++) {
          const line = buffer.getLine(y);
          if (!line) continue;
          let hasText = false;
          let allDim = true;
          for (let x = 0; x < line.length && allDim; x++) {
            const filled = line.getCell(x, cell);
            if (!filled || filled.getChars() === "") continue;
            hasText = true;
            allDim = filled.isDim() !== 0;
          }
          if (hasText && allDim) dimmed.push(line.translateToString(true));
        }
        return dimmed;
      },
      // The normal screen only: a program on the alternate screen (an editor) leaves the lines of the
      // shell under it, which are what is worth keeping. No modes either: they are not text.
      snapshot: (lines = SCROLLBACK_SAVE_LINES) =>
        serialize.serialize({
          scrollback: lines,
          excludeModes: true,
          excludeAltBuffer: true,
        }),
    });
    if (activeRef.current) term.focus();

    return () => {
      disposed = true;
      leaveQueue?.();
      observer.disconnect();
      refitRef.current = null;
      bellSub.dispose();
      clearTimeout(flashTimer);
      viewRef.current?.classList.remove("bell-flash");
      host.removeEventListener("paste", onNativePaste, true);
      host.removeEventListener("contextmenu", onContextMenu);
      dataSub.dispose();
      cwdHandler.dispose();
      resizeSub.dispose();
      for (const cleanup of cleanups) cleanup();
      if (sessionId !== undefined && ownsSession)
        void backend.kill(sessionId).catch(() => undefined);
      commandMarks.dispose();
      marksRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [backend, start0]);

  const closeDialog = (paste: boolean) => {
    const text = pending;
    setPending(null);
    const term = termRef.current;
    if (paste && text !== null) term?.paste(text);
    term?.focus();
  };

  return (
    <div ref={viewRef} className="terminal-view">
      <div ref={container} className="terminal-host" role="region" aria-label="Terminal" />
      {pending !== null && (
        <PasteDialog
          text={pending}
          onPaste={() => closeDialog(true)}
          onCancel={() => closeDialog(false)}
        />
      )}
    </div>
  );
}
