import { useEffect, useRef, useState } from "react";
import type { Backend, SyncStatus } from "@noren/model";
import { useT } from "./i18n";
import { NumberBox } from "./SettingsFields";
import {
  checkRemote,
  connectedMessage,
  failureMessage,
  pendingLines,
  statusText,
} from "./settings-sync";
import type { SyncMessage } from "./settings-sync";
import { runPull, runPush } from "./sync-run";

type SyncPanelBackend = Pick<
  Backend,
  "syncStatus" | "syncConnect" | "syncPull" | "syncPush" | "listUserThemes" | "listMods"
>;

type View = { state: "loading" } | { state: "ready"; status: SyncStatus | undefined };

/**
 * The sync of the settings through git, inside the settings screen: the address of the remote and
 * Connect, where the sync stands (read when the screen opens, with no network), and Pull and Push.
 * Every answer is a sentence in a `status` region: the files pulled or pushed, the paths in conflict
 * with the words that nothing changed, or the text of the error git gave. An address that
 * `syncRemoteProblem` refuses says why and is never sent. After a pull the status is read again,
 * and the themes and mods it wrote are read again by `sync-run.ts`.
 */
export function SyncPanel({ backend }: { backend: SyncPanelBackend }) {
  const t = useT();
  const [view, setView] = useState<View>({ state: "loading" });
  const [remote, setRemote] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SyncMessage>();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void backend.syncStatus().then(
      (status) => {
        if (!alive.current) return;
        setView({ state: "ready", status });
        if (status.remote !== null) setRemote(status.remote);
      },
      (error: unknown) => {
        if (!alive.current) return;
        setView({ state: "ready", status: undefined });
        setNote(failureMessage("status", error));
      },
    );
    return () => {
      alive.current = false;
    };
  }, [backend]);

  /** Reads the status again after a pull or a push; a failure leaves the one shown. */
  const refreshStatus = async () => {
    try {
      const status = await backend.syncStatus();
      if (alive.current) setView({ state: "ready", status });
    } catch {
      // The answer of the pull or the push is already on screen; the status stays as it was.
    }
  };

  const connect = async () => {
    const checked = checkRemote(remote);
    if (!checked.ok) {
      setNote(checked.message);
      return;
    }
    setBusy(true);
    setNote(undefined);
    try {
      const status = await backend.syncConnect(checked.remote);
      if (!alive.current) return;
      setView({ state: "ready", status });
      setNote(connectedMessage(status));
    } catch (error) {
      if (alive.current) setNote(failureMessage("connect", error));
    }
    if (alive.current) setBusy(false);
  };

  const step = async (run: () => Promise<SyncMessage>) => {
    setBusy(true);
    setNote(undefined);
    const message = await run();
    if (alive.current) setNote(message);
    await refreshStatus();
    if (alive.current) setBusy(false);
  };

  if (view.state === "loading") {
    return (
      <p role="status" className="settings-hint" data-nr-part="settings-sync-status">
        {t("settings.syncLoading")}
      </p>
    );
  }
  const status = view.status;
  const connected = status?.connected === true;
  const pending = status === undefined ? [] : pendingLines(status);
  return (
    <>
      <p className="settings-hint">{t("settings.syncHint")}</p>
      <p className="settings-hint" data-nr-part="settings-sync-warning">
        {t("settings.syncWarning")}
      </p>
      <NumberBox
        label={t("settings.syncRemote")}
        value={remote}
        problem={undefined}
        text
        wide
        onChange={setRemote}
      />
      <div className="settings-sync-buttons">
        <button
          type="button"
          className="settings-link"
          disabled={busy || remote.trim() === ""}
          onClick={() => void connect()}
        >
          {t("settings.syncConnect")}
        </button>
        <button
          type="button"
          className="settings-link"
          disabled={busy || !connected}
          onClick={() => void step(() => runPull(backend))}
        >
          {t("settings.syncPull")}
        </button>
        <button
          type="button"
          className="settings-link"
          disabled={busy || !connected}
          onClick={() => void step(() => runPush(backend))}
        >
          {t("settings.syncPush")}
        </button>
      </div>
      <p role="status" className="settings-hint" data-nr-part="settings-sync-status">
        {status === undefined ? t("settings.syncStatus.notConnected") : statusText(status)}
      </p>
      {pending.length > 0 && (
        <ul className="settings-sync-pending" data-nr-part="settings-sync-pending">
          {pending.map((line) => (
            <li key={line} className="settings-hint">
              {line}
            </li>
          ))}
        </ul>
      )}
      {note !== undefined && (
        <p
          role="status"
          className={note.alert ? "settings-warning" : "settings-hint"}
          data-nr-part="settings-sync-note"
        >
          {note.text}
        </p>
      )}
    </>
  );
}
