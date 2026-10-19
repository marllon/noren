import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { Backend, SessionId } from "@noren/model";
import { useEffect, useRef, useState } from "react";
import { PasteDialog } from "./PasteDialog";
import { parseOsc7 } from "./osc7";
import { decidePaste } from "./paste";

/** What a right click does: copy the selection or paste, always paste, or leave the native menu. */
export type RightClickAction = "copy-or-paste" | "paste" | "menu";

/** Read-only view of a mounted terminal, for tests and diagnostics. */
export interface TerminalHandle {
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
   * Called with the session the view started. The caller owns it from then on: the view no longer
   * ends it on unmount. Without this callback the view ends its own session when it goes away.
   */
  onSessionStart?(id: SessionId): void;
  /** Colors of the terminal; changing them repaints the live terminal. */
  theme: ITheme;
  /** False while the view is hidden (another tab shows). Default true. */
  active?: boolean;
  /** Default `copy-or-paste`. */
  rightClick?: RightClickAction;
  /** Called once the terminal is mounted. */
  onReady?(handle: TerminalHandle): void;
  /** Called with the folder the shell reports through OSC 7 (at each prompt of an integrated shell). */
  onCwd?(path: string): void;
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
  onSessionStart,
  theme,
  active = true,
  rightClick,
  onReady,
  onCwd,
}: TerminalViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const rightClickRef = useRef<RightClickAction>(rightClick ?? "copy-or-paste");
  const onReadyRef = useRef(onReady);
  const onCwdRef = useRef(onCwd);
  const onSessionStartRef = useRef(onSessionStart);
  const activeRef = useRef(active);
  const themeRef = useRef(theme);
  const [pending, setPending] = useState<string | null>(null);
  // What the shell starts with is fixed when the view mounts; a later change must not restart it.
  const [start0] = useState(() => ({ attach, profileId, cwd, env }));

  useEffect(() => {
    rightClickRef.current = rightClick ?? "copy-or-paste";
    onReadyRef.current = onReady;
    onCwdRef.current = onCwd;
    onSessionStartRef.current = onSessionStart;
    activeRef.current = active;
    themeRef.current = theme;
  });

  // A new theme repaints the terminal that is already running.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme;
  }, [theme]);

  // Showing a tab again gives it the keyboard.
  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  useEffect(() => {
    const host = container.current;
    if (!host) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 14,
      scrollback: 10_000,
      theme: themeRef.current,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new SearchAddon());
    term.loadAddon(new SerializeAddon());
    term.unicode.activeVersion = "11";
    term.open(host);

    // WebGL is the fast path; any failure (no WebGL2, lost context) drops back to the DOM renderer.
    let webgl: WebglAddon | null = null;
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

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // The container has no size yet (hidden or detached); the next observation fits.
      }
    };
    safeFit();

    let disposed = false;
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
      cleanups.push(backend.onOutput(id, (bytes) => term.write(bytes)));
      cleanups.push(
        backend.onExit((exit) => {
          if (exit.id === id) term.write(`\r\n[Process exited with code ${exit.code}]\r\n`);
        }),
      );
      // The view may have been resized while the session was starting.
      if (term.cols !== startCols || term.rows !== startRows) {
        backend.resize(id, term.cols, term.rows).catch(() => undefined);
      }
    };
    start().catch((error: unknown) => {
      if (disposed) return;
      const reason = error instanceof Error ? error.message : String(error);
      term.write(`\r\n[Could not start the shell: ${reason}]\r\n`);
    });

    onReadyRef.current?.({
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
    });
    if (activeRef.current) term.focus();

    return () => {
      disposed = true;
      observer.disconnect();
      host.removeEventListener("paste", onNativePaste, true);
      host.removeEventListener("contextmenu", onContextMenu);
      dataSub.dispose();
      cwdHandler.dispose();
      resizeSub.dispose();
      for (const cleanup of cleanups) cleanup();
      if (sessionId !== undefined && ownsSession)
        void backend.kill(sessionId).catch(() => undefined);
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
    <div className="terminal-view">
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
