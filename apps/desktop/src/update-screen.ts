import type { UpdateInfo, UpdateProgress } from "@noren/model";
import { formatBytes } from "./bench-format";
import { getLanguage, t } from "./i18n";

// The pure part of the screen of the update of the app (NOR-F20-02b): what the screen shows at each
// step of a check and an install, how a download is told, and the sentence of every refusal. The
// layers below (`Backend.updateCheck`, `updateInstall`, `onUpdateProgress`) answer in English with
// the words of `noren-core::update`; the screen puts them in the language in force, and a sentence
// it does not know is shown as the backend said it. Nothing here touches the backend: the steps are
// driven by `update-controller.ts`.

/** Why a step of the update ended without an update, by what the person has to know about it. */
export type UpdateFailureKind =
  | "no-key"
  | "off"
  | "signature"
  | "signature-text"
  | "signed-version"
  | "signed-version-missing"
  | "no-package"
  | "unreachable"
  | "timeout"
  | "server"
  | "too-large"
  | "feed"
  | "nothing-to-install"
  | "busy"
  | "install"
  | "other";

/** A failure as the screen keeps it: its kind, and the values its sentence needs. */
export interface UpdateFailure {
  kind: UpdateFailureKind;
  /** What the backend said (the sentence itself for `other`, the cause for `install`). */
  detail: string;
  /** The status the server answered, for `server`. */
  status?: number;
  /** The versions of a signature made for another one, for `signed-version`. */
  signed?: string;
  announced?: string;
}

const SIGNED_VERSION =
  /^the update was refused: the package was signed for version (.+), not for (.+)$/;
const SERVER_STATUS = /^the update server answered (\d{3})$/;

/** Reads the sentence a step was rejected with into the kind of failure it is. */
export function classifyUpdateFailure(message: string): UpdateFailure {
  const detail = message.trim();
  const failure = (kind: UpdateFailureKind, extra: Partial<UpdateFailure> = {}): UpdateFailure => ({
    kind,
    detail,
    ...extra,
  });
  if (detail.startsWith("this build has no update key")) return failure("no-key");
  if (detail === "this run does not update") return failure("off");
  const signed = SIGNED_VERSION.exec(detail);
  if (signed !== null) {
    return failure("signed-version", { signed: signed[1] ?? "", announced: signed[2] ?? "" });
  }
  if (
    detail === "the update was refused: the signature does not match the package and the update key"
  ) {
    return failure("signature");
  }
  if (detail === "the update was refused: the signature or the update key is not valid text") {
    return failure("signature-text");
  }
  if (
    detail === "the update was refused: the signature does not say which version it was made for"
  ) {
    return failure("signed-version-missing");
  }
  if (detail === "the update was refused: the release has no package for this platform") {
    return failure("no-package");
  }
  if (detail.startsWith("the update server could not be reached")) return failure("unreachable");
  if (detail === "the update server took too long to answer") return failure("timeout");
  const status = SERVER_STATUS.exec(detail);
  if (status !== null) return failure("server", { status: Number(status[1]) });
  if (detail.startsWith("the update answer is larger than")) return failure("too-large");
  if (
    detail.startsWith("the update feed is not usable") ||
    detail.startsWith("the update settings are not usable") ||
    detail.startsWith("the update address is not usable")
  ) {
    return failure("feed");
  }
  if (detail === "there is no update to install: check first") return failure("nothing-to-install");
  if (detail === "another step of the update is still running") return failure("busy");
  if (detail.startsWith("the update could not be installed")) return failure("install");
  return failure("other");
}

/** The sentence for the person: what happened and, when it matters, that nothing was installed. */
export function failureText(failure: UpdateFailure): string {
  switch (failure.kind) {
    case "no-key":
      return t("update.failure.noKey");
    case "off":
      return t("update.failure.off");
    case "signature":
      return t("update.failure.signature");
    case "signature-text":
      return t("update.failure.signatureText");
    case "signed-version":
      return t("update.failure.signedVersion", {
        signed: failure.signed ?? "",
        announced: failure.announced ?? "",
      });
    case "signed-version-missing":
      return t("update.failure.signedVersionMissing");
    case "no-package":
      return t("update.failure.noPackage");
    case "unreachable":
      return t("update.failure.unreachable");
    case "timeout":
      return t("update.failure.timeout");
    case "server":
      return t("update.failure.server", { status: failure.status ?? 0 });
    case "too-large":
      return t("update.failure.tooLarge");
    case "feed":
      return t("update.failure.feed");
    case "nothing-to-install":
      return t("update.failure.nothingToInstall");
    case "busy":
      return t("update.failure.busy");
    case "install":
      return t("update.failure.install", { reason: failure.detail });
    case "other":
      return t("update.failure.other", { reason: failure.detail });
  }
}

/** What the screen is doing, and what it shows because of it. */
export type UpdatePhase =
  /** Nothing asked yet: the screen only offers the check. */
  | { kind: "idle" }
  | { kind: "checking" }
  /** The check found nothing newer than `currentVersion` (`undefined` when the status could not be read). */
  | { kind: "current"; currentVersion: string | undefined }
  | { kind: "available"; info: UpdateInfo }
  /** The person asked to install: the state of the app is being written before anything is downloaded. */
  | { kind: "saving"; info: UpdateInfo }
  | { kind: "downloading"; info: UpdateInfo; progress: UpdateProgress | null }
  /** The installer took the package (on Windows the app is about to exit; elsewhere it restarts the app). */
  | { kind: "installed"; info: UpdateInfo }
  | { kind: "failed"; step: "check" | "install"; failure: UpdateFailure };

export const IDLE_PHASE: UpdatePhase = { kind: "idle" };

/** A step of the screen. */
export type UpdateEvent =
  | { type: "check-started" }
  | { type: "check-done"; info: UpdateInfo | null; currentVersion: string | undefined }
  | { type: "check-failed"; message: string }
  | { type: "save-started" }
  | { type: "download-started" }
  | { type: "progress"; progress: UpdateProgress }
  | { type: "install-done" }
  | { type: "install-failed"; message: string };

/** The update the phase is about, if it is about one. */
export function updateOfPhase(phase: UpdatePhase): UpdateInfo | undefined {
  switch (phase.kind) {
    case "available":
    case "saving":
    case "downloading":
    case "installed":
      return phase.info;
    default:
      return undefined;
  }
}

/**
 * The next phase. An event that does not belong to the phase it finds (a progress event after the
 * install ended, a second click while a step runs) changes nothing, so a late answer cannot undo
 * what the screen already shows.
 */
export function nextPhase(phase: UpdatePhase, event: UpdateEvent): UpdatePhase {
  switch (event.type) {
    case "check-started":
      return canCheck(phase) ? { kind: "checking" } : phase;
    case "check-done":
      if (phase.kind !== "checking") return phase;
      return event.info === null
        ? { kind: "current", currentVersion: event.currentVersion }
        : { kind: "available", info: event.info };
    case "check-failed":
      if (phase.kind !== "checking") return phase;
      return { kind: "failed", step: "check", failure: classifyUpdateFailure(event.message) };
    case "save-started":
      return phase.kind === "available" ? { kind: "saving", info: phase.info } : phase;
    case "download-started":
      return phase.kind === "saving"
        ? { kind: "downloading", info: phase.info, progress: null }
        : phase;
    case "progress":
      return phase.kind === "downloading" ? { ...phase, progress: event.progress } : phase;
    case "install-done":
      return phase.kind === "downloading" || phase.kind === "saving"
        ? { kind: "installed", info: phase.info }
        : phase;
    case "install-failed":
      return phase.kind === "downloading" || phase.kind === "saving"
        ? { kind: "failed", step: "install", failure: classifyUpdateFailure(event.message) }
        : phase;
  }
}

/** Whether a check may start: not while a step runs, and not over a package already coming. */
export function canCheck(phase: UpdatePhase): boolean {
  return phase.kind !== "checking" && phase.kind !== "saving" && phase.kind !== "downloading";
}

/** Whether Install may be pressed: only on an update that was found. */
export function canInstall(phase: UpdatePhase): boolean {
  return phase.kind === "available";
}

/** Whether a step is running (the controls wait). */
export function isBusy(phase: UpdatePhase): boolean {
  return !canCheck(phase);
}

// ---- the download ------------------------------------------------------------------------------

/** How a download is drawn: the filled part (`null` when the size is not known) and the words. */
export interface ProgressView {
  /** 0 to 100, whole; `null` while the size of the package is not known. */
  percent: number | null;
  label: string;
}

/** Tells how much has come. Never over 100: a server that sends more than it said fills the bar. */
export function progressView(progress: UpdateProgress | null): ProgressView {
  if (progress === null) return { percent: null, label: t("update.progress.starting") };
  const { downloaded, total } = progress;
  if (total === null || total === 0) {
    return {
      percent: null,
      label: t("update.progress.unknownSize", { done: formatBytes(downloaded) }),
    };
  }
  const percent = Math.min(100, Math.floor((downloaded / total) * 100));
  return {
    percent,
    label: t("update.progress.of", {
      percent,
      done: formatBytes(downloaded),
      total: formatBytes(total),
    }),
  };
}

// ---- the words of each phase -------------------------------------------------------------------

/** The date of a release, as the language in force writes it (`null` when the feed has none). */
export function publishedText(publishedAt: number | null): string | null {
  if (publishedAt === null) return null;
  const date = new Date(publishedAt * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(getLanguage(), { dateStyle: "long", timeZone: "UTC" }).format(
    date,
  );
}

/** The line that says where the update stands; `undefined` for the phase that has nothing to say yet. */
export function phaseText(phase: UpdatePhase): string | undefined {
  switch (phase.kind) {
    case "idle":
      return undefined;
    case "checking":
      return t("update.checking");
    case "current":
      return phase.currentVersion === undefined
        ? t("update.current.noVersion")
        : t("update.current", { version: phase.currentVersion });
    case "available":
      return t("update.available", {
        version: phase.info.version,
        current: phase.info.currentVersion,
      });
    case "saving":
      return t("update.saving");
    case "downloading":
      return t("update.downloading", { version: phase.info.version });
    case "installed":
      return t("update.installed", { version: phase.info.version });
    case "failed":
      return failureText(phase.failure);
  }
}

/** Whether the phase's line is an alert (a refusal), drawn as a warning. */
export function phaseIsAlert(phase: UpdatePhase): boolean {
  return phase.kind === "failed";
}
