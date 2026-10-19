import { ConfigManager, FakeBackend } from "@noren/model";
import type { UserProfile } from "@noren/model";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProfiles,
  getProfilesProblem,
  resetProfiles,
  startProfiles,
  syncProfiles,
} from "./profiles-store";

const base = [
  { id: "pwsh", name: "PowerShell", default: true },
  { id: "cmd", name: "Command Prompt", default: false },
];
const dev: UserProfile = { id: "dev-shell", name: "Dev Shell", program: "pwsh.exe" };
const plain: UserProfile = { id: "plain", name: "Plain", program: "sh" };

const ids = (): string[] => getProfiles().map((profile) => profile.id);

/** A config text that lists these profiles, with a comment the tests can look for. */
const configWith = (profiles: UserProfile[]): string =>
  `// kept\n{\n  "profiles": ${JSON.stringify(profiles)}\n}\n`;

beforeEach(() => resetProfiles());

describe("syncProfiles", () => {
  it("hands the backend the profiles of the user and keeps the joined list it answers", async () => {
    const backend = new FakeBackend({ profiles: base });
    await syncProfiles(backend, [dev, plain]);
    expect(ids()).toEqual(["pwsh", "cmd", "dev-shell", "plain"]);
    expect(getProfilesProblem()).toBeUndefined();
    expect(getProfiles()[2]).toEqual({ id: "dev-shell", name: "Dev Shell", default: false });
  });

  it("keeps the profiles the backend had, and says why, when it refuses the list", async () => {
    const backend = new FakeBackend({ profiles: base });
    await syncProfiles(backend, [plain]);
    await syncProfiles(backend, [dev, { id: "empty", name: "Empty", program: "" }]);
    expect(ids()).toEqual(["pwsh", "cmd", "plain"]);
    expect(getProfilesProblem()).toBe("Profile 2: program: The program is empty");
    // The next good list clears the problem.
    await syncProfiles(backend, [dev]);
    expect(ids()).toEqual(["pwsh", "cmd", "dev-shell"]);
    expect(getProfilesProblem()).toBeUndefined();
  });

  it("rejects only when the list cannot be read", async () => {
    const backend = new FakeBackend({ profiles: base });
    backend.listProfiles = () => Promise.reject(new Error("no list"));
    await expect(syncProfiles(backend, [])).rejects.toThrow("no list");
  });

  it("tells the views only when the list or the problem changed", async () => {
    const backend = new FakeBackend({ profiles: base });
    const first = getProfiles();
    await syncProfiles(backend, []);
    const second = getProfiles();
    expect(second).not.toBe(first);
    await syncProfiles(backend, []);
    expect(getProfiles()).not.toBe(second);
    expect(getProfiles()).toEqual(second);
  });
});

describe("startProfiles", () => {
  it("syncs the profiles of the settings in force before it resolves, and again at every change", async () => {
    const backend = new FakeBackend({ profiles: base, config: configWith([dev]) });
    const manager = new ConfigManager();
    await manager.start(backend);
    const stop = await startProfiles(backend, manager);
    expect(ids()).toEqual(["pwsh", "cmd", "dev-shell"]);

    backend.setConfig(configWith([dev, plain]));
    await vi.waitFor(() => expect(ids()).toEqual(["pwsh", "cmd", "dev-shell", "plain"]));

    backend.setConfig(configWith([]));
    await vi.waitFor(() => expect(ids()).toEqual(["pwsh", "cmd"]));
    stop();
  });

  it("hands over nothing new when the profiles did not change, and ignores a file with a problem", async () => {
    const backend = new FakeBackend({ profiles: base, config: configWith([dev]) });
    const manager = new ConfigManager();
    await manager.start(backend);
    const stop = await startProfiles(backend, manager);
    expect(backend.callsTo("setUserProfiles")).toHaveLength(1);

    // Another setting changed: the profiles are the same.
    backend.setConfig(
      '// kept\n{ "notifications": { "enabled": false }, "profiles": [' +
        JSON.stringify(dev) +
        "] }",
    );
    await vi.waitFor(() => expect(manager.state.config.notifications?.enabled).toBe(false));
    // A text that is not valid keeps the settings in force, so the profiles stay.
    backend.setConfig('{ "profiles": [ { "id": "x" } ] }');
    await vi.waitFor(() => expect(manager.state.errors).not.toEqual([]));
    expect(backend.callsTo("setUserProfiles")).toHaveLength(1);
    expect(ids()).toEqual(["pwsh", "cmd", "dev-shell"]);
    stop();
  });

  it("lists no profile of the user while the file has none, and when it does not exist", async () => {
    const backend = new FakeBackend({ profiles: base });
    const manager = new ConfigManager();
    await manager.start(backend);
    const stop = await startProfiles(backend, manager);
    expect(ids()).toEqual(["pwsh", "cmd"]);
    stop();
  });

  it("reports a profile the backend refuses, and lists none of the profiles of the file", async () => {
    const backend = new FakeBackend({
      profiles: base,
      config: configWith([{ ...plain, id: "cmd" }]),
    });
    const manager = new ConfigManager();
    await manager.start(backend);
    const stop = await startProfiles(backend, manager);
    expect(ids()).toEqual(["pwsh", "cmd"]);
    expect(getProfilesProblem()).toMatch(/already a shell of this machine/);
    stop();
  });

  it("rejects, and stops following, when the first list cannot be read", async () => {
    const backend = new FakeBackend({ profiles: base, config: configWith([dev]) });
    const manager = new ConfigManager();
    await manager.start(backend);
    const original = backend.listProfiles.bind(backend);
    backend.listProfiles = () => Promise.reject(new Error("no list"));
    await expect(startProfiles(backend, manager)).rejects.toThrow("no list");
    backend.listProfiles = original;
    backend.setConfig(configWith([dev, plain]));
    await Promise.resolve();
    expect(backend.callsTo("setUserProfiles")).toHaveLength(1);
  });

  it("stops following when asked", async () => {
    const backend = new FakeBackend({ profiles: base, config: configWith([dev]) });
    const manager = new ConfigManager();
    await manager.start(backend);
    const stop = await startProfiles(backend, manager);
    stop();
    backend.setConfig(configWith([dev, plain]));
    await vi.waitFor(() => expect(manager.state.config.profiles).toHaveLength(2));
    expect(backend.callsTo("setUserProfiles")).toHaveLength(1);
  });
});
