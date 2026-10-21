import { FakeBackend } from "@noren/model";
import { describe, expect, it } from "vitest";
import { saveBeforeExit, setExitSave } from "./exit-save";
import { UpdateController } from "./update-controller";
import type { UpdateBackend } from "./update-controller";

// The steps behind the screen of the update, over the fake backend: the check and the install are
// the person's, the install saves first (finding 302), the progress reaches the phase, and every
// refusal ends in a phase the screen can draw.

const RELEASE = { version: "0.2.0", notes: "Fixes", publishedAt: 1_792_584_000, bytes: 4000 };

const later = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A controller on a fake whose save is recorded in the same log as the calls of the backend. */
function make(seed?: (fake: FakeBackend) => void) {
  const fake = new FakeBackend();
  fake.setUpdateRelease(RELEASE);
  seed?.(fake);
  const log: string[] = [];
  const backend: UpdateBackend = {
    updateStatus: () => {
      log.push("updateStatus");
      return fake.updateStatus();
    },
    updateCheck: () => {
      log.push("updateCheck");
      return fake.updateCheck();
    },
    updateInstall: () => {
      log.push("updateInstall");
      return fake.updateInstall();
    },
    onUpdateProgress: (callback) => fake.onUpdateProgress(callback),
  };
  const controller = new UpdateController(backend, async () => {
    log.push("save:start");
    await Promise.resolve();
    log.push("save:end");
  });
  return { fake, controller, log };
}

describe("UpdateController", () => {
  it("does nothing until it is asked", () => {
    const { controller, log, fake } = make();
    expect(controller.phase).toEqual({ kind: "idle" });
    expect(log).toEqual([]);
    expect(fake.installedUpdates()).toEqual([]);
  });

  it("finds a newer version and installs nothing", async () => {
    const { controller, log, fake } = make();
    await controller.check();
    expect(controller.phase).toMatchObject({ kind: "available", info: { version: "0.2.0" } });
    expect(log).toEqual(["updateCheck"]);
    expect(fake.installedUpdates()).toEqual([]);
  });

  it("says there is nothing new, with the version that runs", async () => {
    const { controller } = make((fake) => fake.setUpdateRelease({ version: "0.1.0" }));
    await controller.check();
    expect(controller.phase).toEqual({ kind: "current", currentVersion: "0.1.0" });
  });

  it("still says there is nothing new when the version cannot be read", async () => {
    const fake = new FakeBackend();
    const controller = new UpdateController(
      {
        updateStatus: () => Promise.reject(new Error("no")),
        updateCheck: () => fake.updateCheck(),
        updateInstall: () => fake.updateInstall(),
        onUpdateProgress: (callback) => fake.onUpdateProgress(callback),
      },
      saveBeforeExit,
    );
    await controller.check();
    expect(controller.phase).toEqual({ kind: "current", currentVersion: undefined });
  });

  it("turns a refused check into a phase with the kind of refusal", async () => {
    const noKey = make((fake) => fake.setUpdateConfigured(false));
    await noKey.controller.check();
    expect(noKey.controller.phase).toMatchObject({
      kind: "failed",
      step: "check",
      failure: { kind: "no-key" },
    });
    const down = make((fake) =>
      fake.setUpdateFailure(new Error("the update server could not be reached: offline")),
    );
    await down.controller.check();
    expect(down.controller.phase).toMatchObject({ failure: { kind: "unreachable" } });
    // A refused check can be asked again.
    down.fake.setUpdateFailure(undefined);
    await down.controller.check();
    expect(down.controller.phase).toMatchObject({ kind: "available" });
  });

  it("saves before it asks for the install, and installs only after the save ended (finding 302)", async () => {
    const { controller, log, fake } = make();
    await controller.check();
    await controller.install();
    expect(log).toEqual(["updateCheck", "save:start", "save:end", "updateInstall"]);
    expect(fake.installedUpdates()).toEqual(["0.2.0"]);
    expect(controller.phase).toMatchObject({ kind: "installed", info: { version: "0.2.0" } });
  });

  it("does not install an update that was not found, nor twice", async () => {
    const { controller, log, fake } = make();
    await controller.install();
    expect(log).toEqual([]);
    expect(fake.installedUpdates()).toEqual([]);
    await controller.check();
    await controller.install();
    await controller.install();
    expect(fake.installedUpdates()).toEqual(["0.2.0"]);
    expect(log.filter((entry) => entry === "updateInstall")).toHaveLength(1);
  });

  it("shows the progress of the download while the install is held", async () => {
    const { controller, fake } = make();
    await controller.check();
    const release = fake.holdUpdateInstall();
    const installing = controller.install();
    await later();
    expect(controller.phase).toMatchObject({
      kind: "downloading",
      info: { version: "0.2.0" },
      progress: { downloaded: 1000, total: 4000 },
    });
    release();
    await installing;
    expect(controller.phase.kind).toBe("installed");
  });

  it("ignores a check while the install runs", async () => {
    const { controller, fake, log } = make();
    await controller.check();
    const release = fake.holdUpdateInstall();
    const installing = controller.install();
    await later();
    await controller.check();
    expect(log.filter((entry) => entry === "updateCheck")).toHaveLength(1);
    release();
    await installing;
  });

  it("ends in a refusal, with nothing installed, when the signature does not match", async () => {
    const { controller, fake } = make((f) =>
      f.setUpdateRelease({
        ...RELEASE,
        refusal: "the signature does not match the package and the update key",
      }),
    );
    await controller.check();
    await controller.install();
    expect(controller.phase).toMatchObject({
      kind: "failed",
      step: "install",
      failure: { kind: "signature" },
    });
    expect(fake.installedUpdates()).toEqual([]);
  });

  it("stops listening to the progress when the install ends", async () => {
    const { controller, fake } = make();
    await controller.check();
    await controller.install();
    const before = controller.phase;
    // Another install of the same fake tells its progress to nobody the controller still has.
    fake.setUpdateRelease({ ...RELEASE, version: "0.3.0" });
    await fake.updateCheck();
    await fake.updateInstall();
    expect(controller.phase).toBe(before);
  });

  it("tells whoever listens, and lets the palette ask for the section to be shown once", async () => {
    const { controller } = make();
    const seen: string[] = [];
    const stop = controller.subscribe(() => seen.push(controller.phase.kind));
    await controller.check();
    stop();
    await controller.check();
    expect(seen).toEqual(["checking", "available"]);
    expect(controller.takeReveal()).toBe(false);
    controller.requestReveal();
    expect(controller.takeReveal()).toBe(true);
    expect(controller.takeReveal()).toBe(false);
  });
});

describe("saveBeforeExit", () => {
  it("runs the save the app set, and never rejects", async () => {
    let ran = 0;
    setExitSave(async () => {
      ran += 1;
    });
    await saveBeforeExit();
    expect(ran).toBe(1);
    setExitSave(() => Promise.reject(new Error("disk full")));
    await expect(saveBeforeExit()).resolves.toBeUndefined();
    setExitSave(undefined);
    await expect(saveBeforeExit()).resolves.toBeUndefined();
  });
});
