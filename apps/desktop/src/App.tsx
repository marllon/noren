import { emit } from "@tauri-apps/api/event";
import { FakeBackend } from "@noren/model";
import type { Backend } from "@noren/model";
import { useEffect } from "react";

const insideTauri = "__TAURI_INTERNALS__" in window;

// Plain browser (web mode, e2e, demo): no Tauri IPC, use the in-memory backend.
const webBackend: Backend | null = insideTauri ? null : new FakeBackend();

export function App() {
  useEffect(() => {
    if (webBackend) {
      void webBackend.ready();
      return;
    }
    // Tells the Rust side the interface is mounted (used by `noren --smoke`).
    emit("app-ready").catch(() => undefined);
  }, []);

  return <main>Noren</main>;
}
