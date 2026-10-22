import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Settings, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { insideTauri } from "./backend";
import { useT } from "./i18n";
import { openSettings } from "./settings-ui";

/** macOS keeps its native buttons (title bar overlay); Windows and Linux get our own. */
const onMac = /Mac/i.test(navigator.userAgent);

/** Runs a window action. In web mode there is no window to act on, so it does nothing. */
function windowAction(run: (win: ReturnType<typeof getCurrentWindow>) => Promise<unknown>) {
  if (!insideTauri) return;
  run(getCurrentWindow()).catch(() => undefined);
}

function WindowControls() {
  const t = useT();
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
        aria-label={t("titleBar.minimize")}
        onClick={() => windowAction((win) => win.minimize())}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="window-button"
        aria-label={maximized ? t("titleBar.restore") : t("titleBar.maximize")}
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
        aria-label={t("titleBar.close")}
        onClick={() => windowAction((win) => win.close())}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Own title bar: the window has no native frame. The empty area drags the window. `settings` is the
 * settings button: in the title bar so it is reachable even when the sidebar is hidden, and left out
 * when a docked glass sidebar has its own at the foot (one button of that name on the page).
 */
export function TitleBar({ settings = true }: { settings?: boolean }) {
  const t = useT();
  return (
    <header className={onMac ? "titlebar titlebar-mac" : "titlebar"} data-tauri-drag-region>
      <span className="titlebar-title" role="heading" aria-level={1} data-tauri-drag-region>
        Noren
      </span>
      {settings && (
        <button
          type="button"
          className="window-button settings-button"
          aria-label={t("titleBar.settings")}
          onClick={openSettings}
        >
          <Settings size={14} aria-hidden="true" />
        </button>
      )}
      {onMac ? null : <WindowControls />}
    </header>
  );
}
