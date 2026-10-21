import { useCallback, useEffect, useRef, useState } from "react";
import { SYNC_METHODS, pushOnCloseAllowed, syncMethodOf } from "@noren/model";
import type { Backend, SyncGistStatus, SyncMethod, SyncStatus } from "@noren/model";
import { configManager, useConfigState } from "./config-store";
import { useT } from "./i18n";
import { NumberBox, SelectBox } from "./SettingsFields";
import {
  checkGistId,
  checkGistToken,
  checkRemote,
  connectedMessage,
  failureMessage,
  gistConnectedMessage,
  gistPendingLines,
  gistPublicWarning,
  gistStatusText,
  gistTokenText,
  pendingLines,
  reasonOf,
  statusText,
} from "./settings-sync";
import type { SyncMessage } from "./settings-sync";
import type { SpaceSyncBackend, SpaceSyncPort } from "./space-sync";
import { runPull, runPush } from "./sync-run";

type SyncPanelBackend = Pick<
  Backend,
  | "syncStatus"
  | "syncConnect"
  | "syncPull"
  | "syncPush"
  | "syncGistStatus"
  | "syncGistSetToken"
  | "syncGistClearToken"
  | "syncGistConnect"
  | "syncGistPull"
  | "syncGistPush"
  | "listUserThemes"
  | "listMods"
> &
  SpaceSyncBackend;

interface PanelProps {
  backend: SyncPanelBackend;
  spaces?: SpaceSyncPort | undefined;
}

type View = { state: "loading" } | { state: "ready"; status: SyncStatus | undefined };

type GistView =
  | { state: "loading" }
  | {
      state: "ready";
      status: SyncGistStatus | undefined;
      /** Why the status could not be read, shown in place of it while the rest of the section works. */
      problem: SyncMessage | undefined;
    };

const isMethod = (value: string): value is SyncMethod => SYNC_METHODS.some((m) => m === value);

/**
 * The sync of the settings, inside the settings screen: how to sync (a git remote or a secret
 * GitHub gist, `sync.method` of `config.jsonc`), what each method needs, and the choice to push
 * when the app closes. Every answer is a sentence in a `status` region; the palette commands and
 * the push on close follow the method chosen here.
 */
export function SyncPanel({ backend, spaces }: PanelProps) {
  const t = useT();
  const sync = useConfigState().config.sync;
  const method = syncMethodOf(sync);
  const pushOnClose = pushOnCloseAllowed(sync);
  const [note, setNote] = useState<SyncMessage>();

  /** Writes `sync.<key>` to `config.jsonc` (comments kept); a file that cannot be edited says why. */
  const write = async (key: "method" | "pushOnClose", value: string | boolean) => {
    const result = await configManager.update([{ path: ["sync", key], value }]);
    setNote(result.ok ? undefined : { text: result.message, alert: true });
  };

  return (
    <>
      <SelectBox
        label={t("settings.syncMethod")}
        field="sync.method"
        value={method}
        options={[
          { value: "git", label: t("settings.syncMethod.git") },
          { value: "gist", label: t("settings.syncMethod.gist") },
        ]}
        problem={undefined}
        onChange={(value) => {
          if (isMethod(value)) void write("method", value);
        }}
      />
      {method === "gist" ? (
        <GistSync backend={backend} spaces={spaces} />
      ) : (
        <GitSync backend={backend} spaces={spaces} />
      )}
      <label className="settings-option" title={t("field.sync.pushOnClose")}>
        <input
          type="checkbox"
          checked={pushOnClose}
          onChange={(event) => void write("pushOnClose", event.target.checked)}
        />
        <span>{t("settings.syncPushOnClose")}</span>
      </label>
      <p className="settings-hint">{t("settings.syncPushOnCloseHint")}</p>
      {note !== undefined && (
        <p
          role="status"
          className={note.alert ? "settings-warning" : "settings-hint"}
          data-nr-part="settings-sync-config-note"
        >
          {note.text}
        </p>
      )}
    </>
  );
}

/**
 * The sync through git: the address of the remote and Connect, where the sync stands (read when the
 * section opens, with no network), and Pull and Push. An address that `syncRemoteProblem` refuses
 * says why and is never sent. After a pull the status is read again, and the themes and mods it
 * wrote are read again by `sync-run.ts`. With `spaces` (the window's spaces and profiles), a push
 * writes every space as a file first and a pull makes spaces of the files that came in.
 */
function GitSync({ backend, spaces }: PanelProps) {
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
          onClick={() => void step(() => runPull(backend, spaces, "git"))}
        >
          {t("settings.syncPull")}
        </button>
        <button
          type="button"
          className="settings-link"
          disabled={busy || !connected}
          onClick={() => void step(() => runPush(backend, spaces, "git"))}
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

/**
 * The sync through a secret GitHub gist (NOR-F19-02b): the token (saved in the system keychain and
 * removed from it; the section only says whether one is stored, and the box is emptied as soon as
 * the token has been handed over), Connect to a gist by id or Make a secret gist, where the sync
 * stands (read when the section opens, with no network), and Pull and Push. A gist that anyone can
 * read gets a warning of its own; a status that cannot be read (a file over 1 MiB, say) shows the
 * reason in place of the status and leaves the rest of the section working.
 */
function GistSync({ backend, spaces }: PanelProps) {
  const t = useT();
  const [view, setView] = useState<GistView>({ state: "loading" });
  const [gistId, setGistId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SyncMessage>();
  const alive = useRef(true);

  /** Reads the status; a failure is shown in place of it, and the status already shown stays. */
  const readStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await backend.syncGistStatus();
      if (!alive.current) return;
      setView({ state: "ready", status, problem: undefined });
      if (status.gistId !== null)
        setGistId((typed) => (typed === "" ? (status.gistId ?? "") : typed));
    } catch (error) {
      if (!alive.current) return;
      const problem = failureMessage("status", error);
      setView((held) => ({
        state: "ready",
        status: held.state === "ready" ? held.status : undefined,
        problem,
      }));
    }
  }, [backend]);

  useEffect(() => {
    alive.current = true;
    void readStatus();
    return () => {
      alive.current = false;
    };
  }, [readStatus]);

  const saveToken = async () => {
    const checked = checkGistToken(token);
    if (!checked.ok) {
      setNote(checked.message);
      return;
    }
    setBusy(true);
    setNote(undefined);
    try {
      await backend.syncGistSetToken(checked.token);
      if (alive.current) setNote({ text: t("settings.gistTokenSaved"), alert: false });
    } catch (error) {
      if (alive.current) {
        setNote({ text: t("settings.gistTokenFailed", { reason: reasonOf(error) }), alert: true });
      }
    }
    // The token is in the keychain or the backend said no: either way the screen lets go of it.
    if (alive.current) setToken("");
    await readStatus();
    if (alive.current) setBusy(false);
  };

  const clearToken = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      await backend.syncGistClearToken();
      if (alive.current) setNote({ text: t("settings.gistTokenCleared"), alert: false });
    } catch (error) {
      if (alive.current) {
        setNote({
          text: t("settings.gistTokenClearFailed", { reason: reasonOf(error) }),
          alert: true,
        });
      }
    }
    await readStatus();
    if (alive.current) setBusy(false);
  };

  /** Connects to the gist typed, or, with \`undefined\`, makes a secret gist from the files that may travel. */
  const connect = async (id: string | undefined) => {
    let target: string | undefined;
    if (id !== undefined) {
      const checked = checkGistId(id);
      if (!checked.ok) {
        setNote(checked.message);
        return;
      }
      target = checked.gistId;
    }
    setBusy(true);
    setNote(undefined);
    try {
      const status = await backend.syncGistConnect(target);
      if (!alive.current) return;
      setView({ state: "ready", status, problem: undefined });
      if (status.gistId !== null) setGistId(status.gistId);
      setNote(gistConnectedMessage(status, target === undefined));
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
    await readStatus();
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
  const pending = status === undefined ? [] : gistPendingLines(status);
  const publicWarning = gistPublicWarning(status);
  return (
    <>
      <p className="settings-hint">{t("settings.gistHint")}</p>
      <p className="settings-hint" data-nr-part="settings-sync-warning">
        {t("settings.gistWarning")}
      </p>
      <NumberBox
        label={t("settings.gistToken")}
        value={token}
        problem={undefined}
        text
        wide
        secret
        onChange={setToken}
      />
      <p className="settings-hint">{t("settings.gistTokenHint")}</p>
      <div className="settings-sync-buttons">
        <button
          type="button"
          className="settings-link"
          disabled={busy || token.trim() === ""}
          onClick={() => void saveToken()}
        >
          {t("settings.gistTokenSave")}
        </button>
        <button
          type="button"
          className="settings-link"
          disabled={busy || status?.hasToken !== true}
          onClick={() => void clearToken()}
        >
          {t("settings.gistTokenClear")}
        </button>
      </div>
      <p role="status" className="settings-hint" data-nr-part="settings-sync-token">
        {gistTokenText(status)}
      </p>
      <NumberBox
        label={t("settings.gistId")}
        value={gistId}
        problem={undefined}
        text
        wide
        onChange={setGistId}
      />
      <div className="settings-sync-buttons">
        <button
          type="button"
          className="settings-link"
          disabled={busy || gistId.trim() === ""}
          onClick={() => void connect(gistId)}
        >
          {t("settings.syncConnect")}
        </button>
        <button
          type="button"
          className="settings-link"
          disabled={busy}
          onClick={() => void connect(undefined)}
        >
          {t("settings.gistCreate")}
        </button>
        <button
          type="button"
          className="settings-link"
          disabled={busy || !connected}
          onClick={() => void step(() => runPull(backend, spaces, "gist"))}
        >
          {t("settings.syncPull")}
        </button>
        <button
          type="button"
          className="settings-link"
          disabled={busy || !connected}
          onClick={() => void step(() => runPush(backend, spaces, "gist"))}
        >
          {t("settings.syncPush")}
        </button>
      </div>
      <p
        role="status"
        className={view.problem !== undefined ? "settings-warning" : "settings-hint"}
        data-nr-part="settings-sync-status"
      >
        {view.problem !== undefined
          ? view.problem.text
          : status === undefined
            ? t("settings.gistStatus.notConnected")
            : gistStatusText(status)}
      </p>
      {publicWarning !== undefined && (
        <p role="status" className="settings-warning" data-nr-part="settings-sync-gist-public">
          {publicWarning.text}
        </p>
      )}
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
