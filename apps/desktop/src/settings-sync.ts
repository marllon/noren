import { isSyncGistId, syncGistTokenProblem, syncRemoteProblem } from "@noren/model";
import type {
  SyncGistStatus,
  SyncMethod,
  SyncPullResult,
  SyncPushResult,
  SyncStatus,
} from "@noren/model";
import { t } from "./i18n";

// What the Sync section of the settings screen and the palette commands say (NOR-F19-01b): the
// words for the status, a pull and a push, the check of the address before it is sent to the
// backend, and which of the files a pull brought need the app to read them again. Pure; the panel
// draws it and `sync-run.ts` asks the backend.

/** A sentence for the person, and whether it is a warning (a conflict, a refusal, a failure). */
export interface SyncMessage {
  text: string;
  alert: boolean;
}

/** The files named in a sentence, in the order the backend gave them. */
const listOf = (paths: readonly string[]): string => paths.join(", ");

/** The reason of an error, as the backend worded it. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where the sync stands, in one sentence: not connected, or the remote with one of "up to date",
 * "N files to send", "saved here, not sent yet" and "the remote has changes to pull" (together
 * when more than one is true).
 */
export function statusText(status: SyncStatus): string {
  if (!status.connected || status.remote === null) return t("settings.syncStatus.notConnected");
  const head =
    status.branch === null
      ? t("settings.syncStatus.connected", { remote: status.remote })
      : t("settings.syncStatus.connectedBranch", { remote: status.remote, branch: status.branch });
  const parts: string[] = [];
  if (status.behind > 0) parts.push(t("settings.syncState.behind"));
  if (status.pending.length > 0) {
    parts.push(
      status.pending.length === 1
        ? t("settings.syncState.toSend.one")
        : t("settings.syncState.toSend.other", { n: status.pending.length }),
    );
  } else if (status.ahead > 0) {
    parts.push(t("settings.syncState.committed"));
  }
  if (parts.length === 0) parts.push(t("settings.syncState.upToDate"));
  return `${head} ${parts.join(" ")}`;
}

/** The files a push would carry, one line each (`config.jsonc (changed)`), for the list under the status. */
export function pendingLines(status: SyncStatus): string[] {
  return status.pending.map(({ path, change }) =>
    t(change === "added" ? "settings.syncPending.added" : "settings.syncPending.modified", {
      path,
    }),
  );
}

/** What the address typed in the box comes to: the address to send, or why it is not sent. */
export type RemoteCheck = { ok: true; remote: string } | { ok: false; message: SyncMessage };

/**
 * The address typed, without the blanks around it, checked by `syncRemoteProblem` before anything
 * is asked of the backend: a refused address says why and nothing is connected.
 */
export function checkRemote(input: string): RemoteCheck {
  const remote = input.trim();
  const problem = syncRemoteProblem(remote);
  if (problem !== undefined) {
    return {
      ok: false,
      message: { text: t("settings.syncRemoteRefused", { reason: problem }), alert: true },
    };
  }
  return { ok: true, remote };
}

/**
 * What a pull said: up to date, the files it wrote, or the paths in conflict and that nothing
 * changed. A conflict says how to settle it for the method: in the repository for git, on either
 * side of the file for a gist.
 */
export function pullMessage(result: SyncPullResult, method: SyncMethod = "git"): SyncMessage {
  switch (result.kind) {
    case "up_to_date":
      return { text: t("settings.syncPull.upToDate"), alert: false };
    case "updated":
      return {
        text:
          result.files.length === 1
            ? t("settings.syncPull.updated.one", { files: listOf(result.files) })
            : t("settings.syncPull.updated.other", {
                n: result.files.length,
                files: listOf(result.files),
              }),
        alert: false,
      };
    case "conflict":
      return {
        text: t(method === "gist" ? "settings.gistPull.conflict" : "settings.syncPull.conflict", {
          paths: listOf(result.paths),
        }),
        alert: true,
      };
  }
}

/** What a push said: nothing to send, the files sent, or that commits waiting were sent. */
export function pushMessage(result: SyncPushResult): SyncMessage {
  if (result.pushed) {
    if (result.files.length === 0) {
      return { text: t("settings.syncPush.sentWaiting"), alert: false };
    }
    return {
      text:
        result.files.length === 1
          ? t("settings.syncPush.sent.one", { files: listOf(result.files) })
          : t("settings.syncPush.sent.other", {
              n: result.files.length,
              files: listOf(result.files),
            }),
      alert: false,
    };
  }
  if (result.committed) {
    return {
      text: t("settings.syncPush.notSent", { files: listOf(result.files) }),
      alert: true,
    };
  }
  return { text: t("settings.syncPush.nothing"), alert: false };
}

/** What a step that failed said: the sentence of the step, then the text of the backend as it came. */
export function failureMessage(step: "status" | "connect" | "pull" | "push", error: unknown) {
  const reason = reasonOf(error);
  const text =
    step === "status"
      ? t("settings.syncFailed.status", { reason })
      : step === "connect"
        ? t("settings.syncFailed.connect", { reason })
        : step === "pull"
          ? t("settings.syncFailed.pull", { reason })
          : t("settings.syncFailed.push", { reason });
  return { text, alert: true } satisfies SyncMessage;
}

/** What the person is told once connected: the remote, and what travels and what the app does not ask. */
export function connectedMessage(status: SyncStatus): SyncMessage {
  return {
    text: `${statusText(status)} ${t("settings.syncConnectedWarning")}`,
    alert: false,
  };
}

/** Which of the files a pull wrote the app has to read again. */
export interface PulledKinds {
  /** `config.jsonc`: the app watches the file, so it follows by itself. */
  config: boolean;
  /** `themes/`: nothing watches the folder, so the list of themes is read again. */
  themes: boolean;
  /** `mods/`: watched too, and read again anyway so the screen is right as the pull ends. */
  mods: boolean;
}

/** Sorts the paths of an `updated` pull by what the app has to read again. */
export function pulledKinds(files: readonly string[]): PulledKinds {
  return {
    config: files.includes("config.jsonc"),
    themes: files.some((file) => file.startsWith("themes/")),
    mods: files.some((file) => file.startsWith("mods/")),
  };
}

// ---- the sync through a gist (NOR-F19-02b) ----------------------------------------------------

/**
 * Where the sync through a gist stands, in one sentence: not connected, or the gist with one of "up
 * to date" and "N files to send". A gist has no branch and nothing to compare with before the
 * network, so there is no "behind" here: Pull is what finds out.
 */
export function gistStatusText(status: SyncGistStatus): string {
  if (!status.connected || status.gistId === null) return t("settings.gistStatus.notConnected");
  const head = t("settings.gistStatus.connected", { id: status.gistId });
  const state =
    status.pending.length === 0
      ? t("settings.syncState.upToDate")
      : status.pending.length === 1
        ? t("settings.syncState.toSend.one")
        : t("settings.syncState.toSend.other", { n: status.pending.length });
  return `${head} ${state}`;
}

/** Whether a token is stored, in a sentence. The token itself is never known to the screen. */
export function gistTokenText(status: SyncGistStatus | undefined): string {
  return status?.hasToken === true ? t("settings.gistToken.stored") : t("settings.gistToken.none");
}

/** The files a push through the gist would carry, one line each; the same lines as for git. */
export function gistPendingLines(status: SyncGistStatus): string[] {
  return pendingLines({ ...status, remote: null, branch: null, ahead: 0, behind: 0 });
}

/** The warning for a gist that anyone can read, or `undefined` for a secret one (or none). */
export function gistPublicWarning(status: SyncGistStatus | undefined): SyncMessage | undefined {
  if (status === undefined || !status.connected || !status.public) return undefined;
  return { text: t("settings.gistPublic"), alert: true };
}

/** What the id typed in the box comes to: the id to connect to, or why not. */
export type GistIdCheck = { ok: true; gistId: string } | { ok: false; message: SyncMessage };

/** The id typed, without the blanks around it, checked before anything is asked of the backend. */
export function checkGistId(input: string): GistIdCheck {
  const gistId = input.trim();
  if (!isSyncGistId(gistId)) {
    return { ok: false, message: { text: t("settings.gistIdRefused"), alert: true } };
  }
  return { ok: true, gistId };
}

/** What the token typed in the box comes to: the token to store, or why it is not stored. */
export type GistTokenCheck = { ok: true; token: string } | { ok: false; message: SyncMessage };

/**
 * The token typed, checked by `syncGistTokenProblem` before it is handed to the backend. The
 * sentence of a refusal never repeats it.
 */
export function checkGistToken(input: string): GistTokenCheck {
  const problem = syncGistTokenProblem(input);
  if (problem !== undefined) {
    return {
      ok: false,
      message: { text: t("settings.gistTokenRefused", { reason: problem }), alert: true },
    };
  }
  return { ok: true, token: input.trim() };
}

/**
 * What the person is told once connected to a gist: the status, what travels, and, for a gist that
 * anyone can read, the warning for that. A gist the app just made says it is secret and what that
 * does and does not mean (not listed, but open to whoever has the link).
 */
export function gistConnectedMessage(status: SyncGistStatus, created: boolean): SyncMessage {
  const publicWarning = gistPublicWarning(status);
  const head =
    created && status.gistId !== null
      ? t("settings.gistCreated", { id: status.gistId })
      : gistStatusText(status);
  const parts = [head, t("settings.gistConnectedWarning")];
  if (publicWarning !== undefined) parts.push(publicWarning.text);
  return { text: parts.join(" "), alert: publicWarning !== undefined };
}

/** What a palette command says when the method has no connection: where to connect, or that a token is missing. */
export function notConnectedMessage(method: SyncMethod, hasToken = true): SyncMessage {
  if (method === "git") return { text: t("settings.syncNoRemote"), alert: true };
  return { text: t(hasToken ? "settings.gistNoGist" : "settings.gistNoToken"), alert: true };
}
