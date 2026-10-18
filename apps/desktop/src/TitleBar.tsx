import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { insideTauri } from "./backend";

/** macOS keeps its native buttons (title bar overlay); Windows and Linux get our own. */
const onMac = /Mac/i.test(navigator.userAgent);

/** Runs a window action. In web mode there is no window to act on, so it does nothing. */
function windowAction(run: (win: ReturnType<typeof getCurrentWindow>) => Promise<unknown>) {
  if (!insideTauri) return;
  run(getCurrentWindow()).catch(() => undefined);
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!insideTauri) return;
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => {
      win.isMaximized().then(
        (value) => {
          if (alive) setMaximized(value);
        },
        () => undefined,
      );
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      alive = false;
      unlisten.then(
        (off) => off(),
        () => undefined,
      );
    };
  }, []);

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-button"
        aria-label="Minimize"
        onClick={() => windowAction((win) => win.minimize())}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="window-button"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => windowAction((win) => win.toggleMaximize())}
      >
        {maximized ? (
          <Copy size={12} aria-hidden="true" />
        ) : (
          <Square size={12} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="window-button window-close"
        aria-label="Close"
        onClick={() => windowAction((win) => win.close())}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Own title bar: the window has no native frame. The empty area drags the window. */
export function TitleBar() {
  return (
    <header className={onMac ? "titlebar titlebar-mac" : "titlebar"} data-tauri-drag-region>
      <span className="titlebar-title" data-tauri-drag-region>
        Noren
      </span>
      {onMac ? null : <WindowControls />}
    </header>
  );
}
