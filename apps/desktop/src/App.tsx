import { emit } from "@tauri-apps/api/event";
import { useEffect } from "react";

export function App() {
  useEffect(() => {
    // Tells the Rust side the interface is mounted (used by `noren --smoke`).
    // Outside Tauri (plain browser) there is no IPC, so the call is ignored.
    emit("app-ready").catch(() => undefined);
  }, []);

  return <main>Noren</main>;
}
