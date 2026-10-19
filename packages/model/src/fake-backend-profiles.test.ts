import { describe, expect, it } from "vitest";
import { FakeBackend } from "./index";
import type { UserProfile } from "./index";

// The profiles of the user in the fake backend, which the web build and the end-to-end tests run on:
// it checks the list as the real backend does, lists the user's profiles after the others and
// starts them in their own folder.

const base = [
  { id: "pwsh", name: "PowerShell", default: true },
  { id: "cmd", name: "Command Prompt", default: false },
];

const dev: UserProfile = {
  id: "dev-shell",
  name: "Dev Shell",
  program: "pwsh.exe",
  args: ["-NoLogo"],
  cwd: "/work",
};
const plain: UserProfile = { id: "plain", name: "Plain", program: "sh" };

const ids = async (backend: FakeBackend): Promise<string[]> =>
  (await backend.listProfiles()).map((profile) => profile.id);

describe("FakeBackend profiles of the user", () => {
  it("lists them after the profiles it was built with, never as the default", async () => {
    const backend = new FakeBackend({ profiles: base });
    await backend.setUserProfiles([dev, plain]);
    expect(await backend.listProfiles()).toEqual([
      { id: "pwsh", name: "PowerShell", default: true },
      { id: "cmd", name: "Command Prompt", default: false },
      { id: "dev-shell", name: "Dev Shell", default: false },
      { id: "plain", name: "Plain", default: false },
    ]);
  });

  it("replaces the whole list each time, and an empty list takes them all away", async () => {
    const backend = new FakeBackend({ profiles: base });
    await backend.setUserProfiles([dev, plain]);
    await backend.setUserProfiles([plain]);
    expect(await ids(backend)).toEqual(["pwsh", "cmd", "plain"]);
    await backend.setUserProfiles([]);
    expect(await ids(backend)).toEqual(["pwsh", "cmd"]);
  });

  it("refuses a profile with no program and keeps the profiles it had", async () => {
    const backend = new FakeBackend({ profiles: base });
    await backend.setUserProfiles([plain]);
    await expect(
      backend.setUserProfiles([dev, { id: "empty", name: "Empty", program: "  " }]),
    ).rejects.toThrow("Profile 2: program: The program is empty");
    expect(await ids(backend)).toEqual(["pwsh", "cmd", "plain"]);
  });

  it("refuses an id of the machine, an id twice and `default`", async () => {
    const backend = new FakeBackend({ profiles: base });
    await expect(backend.setUserProfiles([{ ...plain, id: "cmd" }])).rejects.toThrow(
      "already a shell of this machine",
    );
    await expect(backend.setUserProfiles([plain, plain])).rejects.toThrow("used by another");
    await expect(backend.setUserProfiles([{ ...plain, id: "default" }])).rejects.toThrow(
      "reserved",
    );
    expect(await ids(backend)).toEqual(["pwsh", "cmd"]);
  });

  it("does not keep the list it was given, so changing it later changes nothing", async () => {
    const backend = new FakeBackend({ profiles: base });
    const kept = { ...plain };
    const list = [kept];
    await backend.setUserProfiles(list);
    kept.program = "";
    list.push(dev);
    expect(await ids(backend)).toEqual(["pwsh", "cmd", "plain"]);
    const [first] = backend.callsTo("setUserProfiles");
    expect(first?.args).toEqual([[{ ...plain }]]);
  });

  it("starts a session of one in its folder, and the folder of the call wins", async () => {
    const backend = new FakeBackend({ profiles: base });
    await backend.setUserProfiles([dev, plain]);

    const own = await backend.createSession({ profileId: "dev-shell", cols: 80, rows: 24 });
    expect(backend.session(own)).toMatchObject({
      profileId: "dev-shell",
      cwd: "/work",
      program: "pwsh.exe",
      args: ["-NoLogo"],
      alive: true,
    });

    const named = await backend.createSession({
      profileId: "dev-shell",
      cols: 80,
      rows: 24,
      cwd: "/elsewhere",
    });
    expect(backend.session(named)?.cwd).toBe("/elsewhere");

    // A profile with no folder starts where the backend does; the others carry no program at all.
    const noFolder = await backend.createSession({ profileId: "plain", cols: 80, rows: 24 });
    expect(backend.session(noFolder)).toMatchObject({ cwd: "/home/fake", program: "sh", args: [] });
    const detected = await backend.createSession({ profileId: "pwsh", cols: 80, rows: 24 });
    expect(backend.session(detected)?.program).toBeUndefined();
  });

  it("no longer starts a profile that was taken away", async () => {
    const backend = new FakeBackend({ profiles: base });
    await backend.setUserProfiles([plain]);
    await backend.setUserProfiles([]);
    await expect(backend.createSession({ profileId: "plain", cols: 80, rows: 24 })).rejects.toThrow(
      "unknown shell profile 'plain'",
    );
  });

  it("records the call, with the list as it was given", async () => {
    const backend = new FakeBackend({ profiles: base });
    await backend.setUserProfiles([plain]);
    expect(backend.callsTo("setUserProfiles")).toEqual([
      { method: "setUserProfiles", args: [[plain]] },
    ]);
  });
});
