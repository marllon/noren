import { emit } from "@tauri-apps/api/event";
import { FakeBackend } from "@noren/model";
import type { ShellProfile } from "@noren/model";
import { useEffect, useState } from "react";
import { createBackend, insideTauri } from "./backend";
import { TerminalView } from "./TerminalView";
import type { TerminalHandle } from "./TerminalView";

const backend = createBackend();

/** Read-only view of the first terminal, published only when the backend is the in-memory one. */
export interface NorenTestHook {
  lines(): string[];
  renderer(): "webgl" | "dom";
  /** Number of `write` calls the backend received. */
  writeCalls(): number;
}

declare global {
  interface Window {
    __norenTest?: NorenTestHook;
  }
}

function publishTestHook(handle: TerminalHandle) {
  if (!(backend instanceof FakeBackend)) return;
  window.__norenTest = {
    lines: () => handle.readLines(),
    renderer: () => handle.renderer(),
    writeCalls: () => backend.callsTo("write").length,
  };
}

/** The profile a new terminal starts: the one marked default, else the first. */
function pickDefaultProfile(profiles: ShellProfile[]): ShellProfile | undefined {
  return profiles.find((profile) => profile.default) ?? profiles[0];
}

export function App() {
  const [profile, setProfile] = useState<ShellProfile | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    backend
      .listProfiles()
      .then((profiles) => {
        const chosen = pickDefaultProfile(profiles);
        if (chosen) setProfile(chosen);
        else setError("No shell was found on this machine.");
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    if (insideTauri) {
      // Tells the Rust side the interface is mounted (used by `noren --smoke`).
      emit("app-ready").catch(() => undefined);
    }
  }, []);

  return (
    <main className="app">
      <header className="app-title">Noren</header>
      {error !== undefined && <p role="alert">{error}</p>}
      {profile && (
        <TerminalView backend={backend} profileId={profile.id} onReady={publishTestHook} />
      )}
    </main>
  );
}
