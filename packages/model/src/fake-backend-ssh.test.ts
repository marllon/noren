import { describe, expect, it } from "vitest";
import { FAKE_LINK_MAX_ATTEMPTS, FakeBackend } from "./index";
import type { SessionLink, UserProfile } from "./index";

// A session of an SSH profile in the fake backend, which the web build and the end-to-end tests run
// on: the shell is "on the other machine", so it gets only what its profile says, and its
// connection (`onSessionLink`) is something a test breaks and mends.

const base = [{ id: "pwsh", name: "PowerShell", default: true }];

const box: UserProfile = {
  kind: "ssh",
  id: "build-box",
  name: "Build box",
  host: "build.example.org",
  user: "deploy",
  port: 2222,
  identityFile: "C:\\keys\\id_ed25519",
  knownHostsFile: "C:\\keys\\known_hosts",
  program: "bash",
  args: ["-l"],
  cwd: "/srv/app",
};
const bare: UserProfile = { kind: "ssh", id: "bare-box", name: "Bare box", host: "bare" };
const local: UserProfile = { id: "plain", name: "Plain", program: "sh", cwd: "/work" };

async function started(...profiles: UserProfile[]): Promise<FakeBackend> {
  const backend = new FakeBackend({ profiles: base, home: "/home/me" });
  await backend.setUserProfiles(profiles);
  return backend;
}

function links(backend: FakeBackend): SessionLink[] {
  const heard: SessionLink[] = [];
  backend.onSessionLink((link) => heard.push(link));
  return heard;
}

describe("FakeBackend SSH profiles", () => {
  it("lists an SSH profile with its kind and a shell profile without one", async () => {
    const backend = await started(box, local);
    expect(await backend.listProfiles()).toEqual([
      { id: "pwsh", name: "PowerShell", default: true },
      { id: "build-box", name: "Build box", default: false, kind: "ssh" },
      { id: "plain", name: "Plain", default: false },
    ]);
  });

  it("refuses a list with an invalid SSH profile and keeps the one it had", async () => {
    const backend = await started(bare);
    await expect(backend.setUserProfiles([{ ...bare, host: "-oProxyCommand=x" }])).rejects.toThrow(
      "Profile 1: host:",
    );
    expect((await backend.listProfiles()).map((p) => p.id)).toEqual(["pwsh", "bare-box"]);
  });

  it("starts the session on the machine of the profile, which tells the machine", async () => {
    const backend = await started(box);
    const id = await backend.createSession({ profileId: "build-box", cols: 100, rows: 30 });
    expect(backend.session(id)).toMatchObject({
      profileId: "build-box",
      cols: 100,
      rows: 30,
      alive: true,
      program: "bash",
      args: ["-l"],
      ssh: {
        host: "build.example.org",
        user: "deploy",
        port: 2222,
        identityFile: "C:\\keys\\id_ed25519",
        knownHostsFile: "C:\\keys\\known_hosts",
      },
      link: { id, state: "connected" },
    });
    expect(backend.sessionLink(id)).toBe("connected");
  });

  it("sends nothing of this machine: not the folder, not the environment of the call", async () => {
    // A remote shell must not get the Windows folder or environment of the app.
    const backend = await started(box, bare);
    const withFolder = await backend.createSession({
      profileId: "build-box",
      cols: 80,
      rows: 24,
      cwd: "C:\\Users\\me\\project",
      env: { USERPROFILE: "C:\\Users\\me", PATH: "C:\\Windows" },
    });
    expect(backend.session(withFolder)?.cwd).toBe("/srv/app");
    expect(backend.session(withFolder)?.env).not.toHaveProperty("USERPROFILE");
    expect(backend.session(withFolder)?.env).not.toHaveProperty("PATH");

    const bareId = await backend.createSession({
      profileId: "bare-box",
      cols: 80,
      rows: 24,
      cwd: "C:\\Users\\me\\project",
      env: { USERPROFILE: "C:\\Users\\me" },
    });
    // No folder in the profile: the home of the user on the other machine.
    expect(backend.session(bareId)?.cwd).toBe("/home/me");
    expect(backend.session(bareId)?.env).not.toHaveProperty("USERPROFILE");
    expect(backend.session(bareId)?.program).toBe("");
  });

  it("leaves a shell on this machine as it was: its folder and environment, no connection", async () => {
    const backend = await started(local, box);
    const id = await backend.createSession({
      profileId: "plain",
      cols: 80,
      rows: 24,
      env: { A: "1" },
    });
    const info = backend.session(id);
    expect(info?.cwd).toBe("/work");
    expect(info?.env).toMatchObject({ A: "1" });
    expect(info).not.toHaveProperty("ssh");
    expect(info).not.toHaveProperty("link");
    expect(backend.sessionLink(id)).toBeUndefined();
    expect(() => backend.setSessionLink(id, { state: "failed", reason: "x" })).toThrow(
      "has no connection",
    );
    await expect(backend.retrySession(id)).rejects.toThrow("has no connection");
  });
});

describe("FakeBackend connection of a session", () => {
  it("tells whoever listens when the connection breaks, comes back and gives up", async () => {
    const backend = await started(box);
    const heard = links(backend);
    const id = await backend.createSession({ profileId: "build-box", cols: 80, rows: 24 });

    backend.setSessionLink(id, {
      state: "reconnecting",
      attempt: 2,
      maxAttempts: 5,
      retryInMs: 1000,
      reason: "Connection reset",
    });
    backend.setSessionLink(id, { state: "connected" });
    backend.setSessionLink(id, { state: "failed", reason: "Permission denied (publickey)" });

    expect(heard).toEqual([
      {
        id,
        state: "reconnecting",
        attempt: 2,
        maxAttempts: 5,
        retryInMs: 1000,
        reason: "Connection reset",
      },
      { id, state: "connected" },
      { id, state: "failed", reason: "Permission denied (publickey)" },
    ]);
    expect(backend.sessionLink(id)).toBe("failed");
    expect(backend.session(id)?.link).toEqual({
      id,
      state: "failed",
      reason: "Permission denied (publickey)",
    });
  });

  it("breaks every live session of a profile at once, and only that profile's", async () => {
    const backend = await started(box, bare);
    const a = await backend.createSession({ profileId: "build-box", cols: 80, rows: 24 });
    const b = await backend.createSession({ profileId: "build-box", cols: 80, rows: 24 });
    const other = await backend.createSession({ profileId: "bare-box", cols: 80, rows: 24 });
    const ended = await backend.createSession({ profileId: "build-box", cols: 80, rows: 24 });
    await backend.kill(ended);
    const heard = links(backend);

    backend.setProfileLink("build-box", { state: "reconnecting", attempt: 1, retryInMs: 500 });

    expect(heard.map((link) => link.id)).toEqual([a, b]);
    expect(backend.sessionLink(other)).toBe("connected");
    expect(() => backend.setProfileLink("plain", { state: "failed" })).toThrow(
      "not an SSH profile",
    );
  });

  it("stops telling after the listener unsubscribes", async () => {
    const backend = await started(box);
    const heard: SessionLink[] = [];
    const stop = backend.onSessionLink((link) => heard.push(link));
    const id = await backend.createSession({ profileId: "build-box", cols: 80, rows: 24 });
    backend.setSessionLink(id, { state: "failed", reason: "x" });
    stop();
    backend.setSessionLink(id, { state: "connected" });
    expect(heard).toHaveLength(1);
  });

  it("starts the attempts over when asked to retry after it gave up, and ignores a retry when it is up", async () => {
    const backend = await started(box);
    const id = await backend.createSession({ profileId: "build-box", cols: 80, rows: 24 });
    const heard = links(backend);

    await backend.retrySession(id);
    expect(heard).toEqual([]);

    backend.setSessionLink(id, { state: "failed", reason: "Network is unreachable" });
    heard.length = 0;
    await backend.retrySession(id);
    expect(heard).toEqual([
      {
        id,
        state: "reconnecting",
        attempt: 1,
        maxAttempts: FAKE_LINK_MAX_ATTEMPTS,
        retryInMs: 0,
        reason: "Network is unreachable",
      },
    ]);
    // It does not mend itself: the test decides when the connection is back.
    expect(backend.sessionLink(id)).toBe("reconnecting");
    expect(backend.callsTo("retrySession").map((call) => call.args)).toEqual([[id], [id]]);
  });

  it("rejects a retry for a session that is gone, and sets no link on it", async () => {
    const backend = await started(box);
    const id = await backend.createSession({ profileId: "build-box", cols: 80, rows: 24 });
    await backend.kill(id);
    await expect(backend.retrySession(id)).rejects.toThrow("has no connection");
    expect(() => backend.setSessionLink(id, { state: "failed" })).toThrow("has no connection");
    await expect(backend.retrySession(9999)).rejects.toThrow("has no connection");
  });

  it("keeps working as a shell while the connection is down in the fake (the fake never loses bytes)", async () => {
    const backend = await started(box);
    const id = await backend.createSession({ profileId: "build-box", cols: 80, rows: 24 });
    const seen: string[] = [];
    backend.onOutput(id, (data) => seen.push(new TextDecoder().decode(data)));
    backend.setSessionLink(id, { state: "reconnecting", attempt: 1 });
    await backend.write(id, "echo hi\r");
    expect(seen.join("")).toContain("hi");
  });
});
