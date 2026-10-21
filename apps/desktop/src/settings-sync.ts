import { syncRemoteProblem } from "@noren/model";
import type { SyncPullResult, SyncPushResult, SyncStatus } from "@noren/model";
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

/** What a pull said: up to date, the files it wrote, or the paths in conflict and that nothing changed. */
export function pullMessage(result: SyncPullResult): SyncMessage {
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
        text: t("settings.syncPull.conflict", { paths: listOf(result.paths) }),
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
