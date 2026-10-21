import { afterEach, describe, expect, it } from "vitest";
import type { UpdateInfo } from "@noren/model";
import { setLanguage } from "./i18n";
import {
  IDLE_PHASE,
  canCheck,
  canInstall,
  classifyUpdateFailure,
  failureText,
  isBusy,
  nextPhase,
  phaseIsAlert,
  phaseText,
  progressView,
  publishedText,
  updateOfPhase,
} from "./update-screen";
import type { UpdateEvent, UpdateFailureKind, UpdatePhase } from "./update-screen";

// The pure part of the screen of the update (NOR-F20-02b): the phases and the events that move
// between them, the words of every refusal in English and in Brazilian Portuguese, and the download.

afterEach(() => setLanguage("en"));

const INFO: UpdateInfo = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  notes: "Fixes",
  publishedAt: 1_792_584_000,
};

/** Runs the events in order from `from`. */
const run = (from: UpdatePhase, ...events: UpdateEvent[]): UpdatePhase =>
  events.reduce(nextPhase, from);

const NO_KEY = "this build has no update key yet, so it cannot check or install updates";
const BAD_SIGNATURE =
  "the update was refused: the signature does not match the package and the update key";

/** Every sentence `UpdateError` of `noren-core::update` and the refusals of the app's plugin can end with. */
const SENTENCES: readonly [string, UpdateFailureKind][] = [
  [NO_KEY, "no-key"],
  ["this run does not update", "off"],
  ["the update settings are not usable: no endpoint", "feed"],
  ["the update address is not usable: not https", "feed"],
  ["the update server could not be reached: offline", "unreachable"],
  ["the update server took too long to answer", "timeout"],
  ["the update server answered 404", "server"],
  ["the update answer is larger than 1048576 bytes", "too-large"],
  ["the update feed is not usable: it does not follow the format of the updater", "feed"],
  ["there is no update to install: check first", "nothing-to-install"],
  ["another step of the update is still running", "busy"],
  ["the update was refused: the release has no package for this platform", "no-package"],
  [BAD_SIGNATURE, "signature"],
  ["the update was refused: the signature or the update key is not valid text", "signature-text"],
  [
    "the update was refused: the package was signed for version 0.2.0, not for 9.9.9",
    "signed-version",
  ],
  [
    "the update was refused: the signature does not say which version it was made for",
    "signed-version-missing",
  ],
  ["the update could not be installed: access denied", "install"],
  ["something nobody foresaw", "other"],
];

describe("classifyUpdateFailure", () => {
  it.each(SENTENCES)("reads %j as %s", (message, kind) => {
    expect(classifyUpdateFailure(message).kind).toBe(kind);
  });

  it("keeps what the signed version and the status say", () => {
    const signed = classifyUpdateFailure(
      "the update was refused: the package was signed for version 0.2.0, not for 9.9.9",
    );
    expect(signed).toMatchObject({ signed: "0.2.0", announced: "9.9.9" });
    expect(classifyUpdateFailure("the update server answered 503")).toMatchObject({ status: 503 });
  });

  it("keeps the sentence of one it does not know, trimmed", () => {
    expect(classifyUpdateFailure("  weird\n")).toMatchObject({ kind: "other", detail: "weird" });
  });
});

describe("failureText", () => {
  it("says a sentence for every refusal, in English", () => {
    for (const [message] of SENTENCES) {
      const text = failureText(classifyUpdateFailure(message));
      expect(text, message).not.toBe("");
      expect(text, message).not.toContain("{");
    }
  });

  it("says nothing was installed for each refusal of a package", () => {
    const refusals = SENTENCES.filter(([message]) => message.startsWith("the update was refused"));
    expect(refusals.length).toBeGreaterThan(0);
    for (const [message] of refusals) {
      expect(failureText(classifyUpdateFailure(message)), message).toMatch(/Nothing was installed/);
    }
  });

  it("tells the missing key in words a person can act on", () => {
    expect(failureText(classifyUpdateFailure(NO_KEY))).toBe(
      "This build cannot update yet: it has no update key to check an update against. Nothing was checked or installed.",
    );
  });

  it("is in Brazilian Portuguese, with no English left from the backend, for the known refusals", () => {
    setLanguage("pt-BR");
    for (const [message, kind] of SENTENCES) {
      const text = failureText(classifyUpdateFailure(message));
      expect(text, message).not.toBe("");
      if (kind === "other" || kind === "install") continue;
      expect(text, message).not.toMatch(/the update|This build|server/i);
    }
    expect(failureText(classifyUpdateFailure(BAD_SIGNATURE))).toBe(
      "A atualização foi recusada: a assinatura não corresponde ao pacote e à chave de atualização desta versão. Nada foi instalado.",
    );
    expect(failureText(classifyUpdateFailure(NO_KEY))).toMatch(/chave de atualização/);
  });

  it("shows an unknown or install failure with the backend's own words", () => {
    expect(failureText(classifyUpdateFailure("something nobody foresaw"))).toBe(
      "The update did not work: something nobody foresaw",
    );
    expect(failureText(classifyUpdateFailure("the update could not be installed: denied"))).toBe(
      "The update could not be installed: the update could not be installed: denied",
    );
  });
});

describe("the phases", () => {
  it("goes idle, checking, available, saving, downloading, installed", () => {
    const phase = run(
      IDLE_PHASE,
      { type: "check-started" },
      { type: "check-done", info: INFO, currentVersion: "0.1.0" },
      { type: "save-started" },
      { type: "download-started" },
      { type: "progress", progress: { downloaded: 10, total: 40 } },
    );
    expect(phase).toEqual({
      kind: "downloading",
      info: INFO,
      progress: { downloaded: 10, total: 40 },
    });
    expect(run(phase, { type: "install-done" })).toEqual({ kind: "installed", info: INFO });
  });

  it("says there is nothing newer, with the version that runs", () => {
    const phase = run(
      IDLE_PHASE,
      { type: "check-started" },
      { type: "check-done", info: null, currentVersion: "0.1.0" },
    );
    expect(phase).toEqual({ kind: "current", currentVersion: "0.1.0" });
    expect(phaseText(phase)).toBe("Noren 0.1.0 is the latest version.");
    expect(phaseText({ kind: "current", currentVersion: undefined })).toBe(
      "You have the latest version.",
    );
  });

  it("keeps a refusal of the check and of the install as such", () => {
    const refused = run(
      IDLE_PHASE,
      { type: "check-started" },
      { type: "check-failed", message: NO_KEY },
    );
    expect(refused).toMatchObject({ kind: "failed", step: "check", failure: { kind: "no-key" } });
    expect(phaseIsAlert(refused)).toBe(true);
    const install = run(
      { kind: "available", info: INFO },
      { type: "save-started" },
      { type: "download-started" },
      { type: "install-failed", message: BAD_SIGNATURE },
    );
    expect(install).toMatchObject({
      kind: "failed",
      step: "install",
      failure: { kind: "signature" },
    });
    // The person can check again after a refusal.
    expect(canCheck(install)).toBe(true);
    expect(canInstall(install)).toBe(false);
  });

  it("installs only an update that was found", () => {
    const without: UpdatePhase[] = [
      IDLE_PHASE,
      { kind: "checking" },
      { kind: "current", currentVersion: "1.0.0" },
    ];
    for (const phase of without) {
      expect(canInstall(phase)).toBe(false);
      expect(nextPhase(phase, { type: "save-started" })).toBe(phase);
      expect(nextPhase(phase, { type: "download-started" })).toBe(phase);
    }
    expect(canInstall({ kind: "available", info: INFO })).toBe(true);
  });

  it("is busy while a step runs and lets nothing else start", () => {
    const busy: UpdatePhase[] = [
      { kind: "checking" },
      { kind: "saving", info: INFO },
      { kind: "downloading", info: INFO, progress: null },
    ];
    for (const phase of busy) {
      expect(isBusy(phase)).toBe(true);
      expect(canCheck(phase)).toBe(false);
      expect(nextPhase(phase, { type: "check-started" })).toBe(phase);
    }
    expect(isBusy(IDLE_PHASE)).toBe(false);
  });

  it("ignores an answer that comes after its step ended", () => {
    const current: UpdatePhase = { kind: "current", currentVersion: "0.1.0" };
    expect(nextPhase(current, { type: "progress", progress: { downloaded: 1, total: 2 } })).toBe(
      current,
    );
    expect(nextPhase(current, { type: "install-done" })).toBe(current);
    expect(nextPhase(current, { type: "check-failed", message: "late" })).toBe(current);
    expect(nextPhase(current, { type: "check-done", info: INFO, currentVersion: "0.1.0" })).toBe(
      current,
    );
    const installed: UpdatePhase = { kind: "installed", info: INFO };
    expect(nextPhase(installed, { type: "progress", progress: { downloaded: 1, total: 2 } })).toBe(
      installed,
    );
  });

  it("ignores the progress that comes before the download starts", () => {
    const saving: UpdatePhase = { kind: "saving", info: INFO };
    expect(nextPhase(saving, { type: "progress", progress: { downloaded: 1, total: 2 } })).toBe(
      saving,
    );
  });

  it("knows the update a phase is about", () => {
    expect(updateOfPhase({ kind: "available", info: INFO })).toBe(INFO);
    expect(updateOfPhase({ kind: "downloading", info: INFO, progress: null })).toBe(INFO);
    expect(updateOfPhase(IDLE_PHASE)).toBeUndefined();
    expect(updateOfPhase({ kind: "current", currentVersion: "1.0.0" })).toBeUndefined();
  });

  it("has a line for each phase but the idle one", () => {
    expect(phaseText(IDLE_PHASE)).toBeUndefined();
    expect(phaseText({ kind: "checking" })).toBe("Looking for a new version...");
    expect(phaseText({ kind: "available", info: INFO })).toBe(
      "Noren 0.2.0 is available. You have 0.1.0.",
    );
    expect(phaseText({ kind: "saving", info: INFO })).toBe("Saving your tabs before the update...");
    expect(phaseText({ kind: "downloading", info: INFO, progress: null })).toBe(
      "Downloading Noren 0.2.0...",
    );
    expect(phaseText({ kind: "installed", info: INFO })).toBe(
      "Noren 0.2.0 is installed. Restart Noren to use it.",
    );
    setLanguage("pt-BR");
    expect(phaseText({ kind: "available", info: INFO })).toBe(
      "O Noren 0.2.0 está disponível. Você tem a 0.1.0.",
    );
  });
});

describe("progressView", () => {
  it("starts without a size", () => {
    expect(progressView(null)).toEqual({ percent: null, label: "Starting the download..." });
  });

  it("tells the share, whole and rounded down", () => {
    expect(progressView({ downloaded: 12 * 1024 * 1024, total: 48 * 1024 * 1024 })).toEqual({
      percent: 25,
      label: "25% (12.0 MiB of 48.0 MiB)",
    });
    expect(progressView({ downloaded: 1, total: 3 }).percent).toBe(33);
    expect(progressView({ downloaded: 3, total: 3 }).percent).toBe(100);
  });

  it("never goes over 100 when the server sends more than it said", () => {
    expect(progressView({ downloaded: 90, total: 60 }).percent).toBe(100);
  });

  it("has no share when the size is not known", () => {
    expect(progressView({ downloaded: 2048, total: null })).toEqual({
      percent: null,
      label: "2.0 KiB downloaded",
    });
    expect(progressView({ downloaded: 0, total: 0 }).percent).toBeNull();
  });

  it("is in Brazilian Portuguese", () => {
    setLanguage("pt-BR");
    expect(progressView({ downloaded: 1024, total: 2048 }).label).toBe("50% (1.0 KiB de 2.0 KiB)");
  });
});

describe("publishedText", () => {
  it("writes the date of the release in the language in force", () => {
    expect(publishedText(1_792_584_000)).toBe("October 21, 2026");
    setLanguage("pt-BR");
    expect(publishedText(1_792_584_000)).toBe("21 de outubro de 2026");
  });

  it("has nothing when the feed has no date", () => {
    expect(publishedText(null)).toBeNull();
  });
});
