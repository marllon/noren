import { emit } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { createBackend, insideTauri } from "./backend";

const backend = createBackend();

export function App() {
  useEffect(() => {
    // Warms up the backend; the terminal view (NOR-F2-05) is the first real consumer.
    void backend.listProfiles().catch(() => undefined);
    if (insideTauri) {
      // Tells the Rust side the interface is mounted (used by `noren --smoke`).
      emit("app-ready").catch(() => undefined);
    }
  }, []);

  return <main>Noren</main>;
}
