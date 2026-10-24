import { windowIdOfLabel } from "@noren/model";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { insideTauri } from "./backend";
import { startEarlyReads } from "./early-reads";
import { loadHome } from "./home";
import { applyLanguageSetting } from "./i18n";
import { perfMark } from "./perf-probe";
import { quickPreviewEnabled, windowKindOf, windowPreviewEnabled } from "./quick";
import "./app.css";

perfMark("page-script");
// Until the settings file is read the language is the system's; `config-store.ts` follows the file.
applyLanguageSetting(undefined);
const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

function show(content: ReactNode): void {
  if (root) createRoot(root).render(<StrictMode>{content}</StrictMode>);
}

// The other windows load this same page, but only what they show: importing the app would start
// the workspace again (the saved state, the settings, the shells of every tab) in a second window,
// and two pages would write `state.json`. The main window owns the state and is the only one that
// loads the app. Whichever page is not this window's stays unloaded.
const label = insideTauri ? getCurrentWindow().label : undefined;
const kind = windowKindOf(label);
const windowId = label === undefined ? undefined : windowIdOfLabel(label);
if (insideTauri && kind === "quick") {
  void import("./QuickApp").then(({ QuickApp }) => show(<QuickApp />));
} else if (insideTauri && kind === "window" && windowId !== undefined) {
  void import("./WindowApp").then(({ WindowApp }) => show(<WindowApp windowId={windowId} />));
} else {
  // The boot reads the settings, the themes, the mods and the saved state from the app, one after
  // the other, once the scripts of the app are in. Asked for now, the app answers while they load.
  if (insideTauri) {
    startEarlyReads();
    void loadHome();
  }
  void import("./App").then(async ({ App }) => {
    if (!quickPreviewEnabled && !windowPreviewEnabled) {
      show(<App />);
      return;
    }
    // A browser opened with `?quick-preview` also draws the quick window, as a panel, and one opened
    // with `?window-preview` the other windows of the app (e2e tests).
    const { QuickPreview } = quickPreviewEnabled
      ? await import("./QuickPreview")
      : { QuickPreview: undefined };
    const { WindowPreview } = windowPreviewEnabled
      ? await import("./WindowPreview")
      : { WindowPreview: undefined };
    show(
      <>
        <App />
        {QuickPreview !== undefined && <QuickPreview />}
        {WindowPreview !== undefined && <WindowPreview />}
      </>,
    );
  });
}
