import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { insideTauri } from "./backend";
import { windowKindOf } from "./quick";
import "./app.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

function show(content: ReactNode): void {
  if (root) createRoot(root).render(<StrictMode>{content}</StrictMode>);
}

// The quick window loads this same page, but only its terminal: importing the app would start the
// workspace again (the saved state, the settings, the shells of every tab) in a second window.
// Whichever page is not this window's stays unloaded.
if (insideTauri && windowKindOf(getCurrentWindow().label) === "quick") {
  void import("./QuickApp").then(({ QuickApp }) => show(<QuickApp />));
} else {
  void import("./App").then(({ App }) => show(<App />));
}
