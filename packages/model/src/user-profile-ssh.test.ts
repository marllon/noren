import { describe, expect, it } from "vitest";
import { describeConfigError, parseConfigText } from "./config";
import { editConfigText } from "./config-edit";
import {
  MAX_SSH_NAME,
  SSH_HOST_PATTERN,
  SSH_USER_PATTERN,
  ShellUserProfileSchema,
  SshUserProfileSchema,
  UserProfileSchema,
  isSshProfile,
  profilesProblem,
} from "./user-profile-schema";
import type { SshUserProfile } from "./user-profile-schema";

// The "SSH (norend)" kind of profile: a machine to reach with the `ssh` of the system, whose shell
// lives in a `norend` there. It names the machine and the files (a key, the known hosts), never a
// password; the kind is told by `kind: "ssh"`, and a profile without `kind` is a shell profile as
// before.

const full: SshUserProfile = {
  kind: "ssh",
  id: "build-box",
  name: "Build box",
  host: "build.example.org",
  user: "deploy",
  port: 2222,
  identityFile: "%USERPROFILE%\\.ssh\\id_ed25519",
  knownHostsFile: "C:\\Users\\me\\.ssh\\known_hosts_noren",
  program: "bash",
  args: ["-l"],
  cwd: "/srv/app",
};
const smallest: SshUserProfile = { kind: "ssh", id: "box", name: "Box", host: "box" };

describe("an SSH profile", () => {
  it("is a host and a name, and nothing else is needed", () => {
    expect(UserProfileSchema.parse(smallest)).toEqual(smallest);
  });

  it("can carry the user, the port, the key, the known hosts and what the remote shell runs", () => {
    expect(UserProfileSchema.parse(full)).toEqual(full);
  });

  it("is told from a shell profile by its kind, which a shell profile may leave out", () => {
    expect(isSshProfile(UserProfileSchema.parse(full))).toBe(true);
    const shell = UserProfileSchema.parse({ id: "sh", name: "Sh", program: "sh" });
    expect(isSshProfile(shell)).toBe(false);
    expect(UserProfileSchema.parse({ kind: "shell", id: "sh", name: "Sh", program: "sh" })).toEqual(
      {
        kind: "shell",
        id: "sh",
        name: "Sh",
        program: "sh",
      },
    );
  });

  it("needs a host", () => {
    const without: Record<string, unknown> = { ...smallest };
    delete without["host"];
    expect(SshUserProfileSchema.safeParse(without).success).toBe(false);
    expect(profilesProblem([without])).toBe(
      "Profile 1: host: Invalid input: expected string, received undefined",
    );
    expect(profilesProblem([{ ...smallest, host: "" }])).toBe("Profile 1: host: The host is empty");
  });

  it("does not take a host or a user that ssh could read as an option or split in two", () => {
    for (const host of ["-oProxyCommand=x", "a b", "a;b", "a/b", "a@b", "h\n", "ü.example.org"]) {
      expect(SshUserProfileSchema.safeParse({ ...smallest, host }).success, host).toBe(false);
    }
    for (const user of ["-x", "a b", "a@b", "a:b", "me;", ""]) {
      expect(SshUserProfileSchema.safeParse({ ...smallest, user }).success, user).toBe(false);
    }
    for (const host of [
      "box",
      "10.0.0.7",
      "::1",
      "fe80::1",
      "a_b.example-org",
      "h".repeat(MAX_SSH_NAME),
    ]) {
      expect(SshUserProfileSchema.safeParse({ ...smallest, host }).success, host).toBe(true);
    }
    expect(
      SshUserProfileSchema.safeParse({ ...smallest, host: "h".repeat(MAX_SSH_NAME + 1) }).success,
    ).toBe(false);
    expect(SSH_HOST_PATTERN.test("-h")).toBe(false);
    expect(SSH_USER_PATTERN.test("me.name-1_x")).toBe(true);
  });

  it("takes a port from 1 to 65535, a whole number", () => {
    for (const port of [0, 65536, -1, 22.5, Number.NaN]) {
      expect(SshUserProfileSchema.safeParse({ ...smallest, port }).success, String(port)).toBe(
        false,
      );
    }
    for (const port of [1, 22, 65535]) {
      expect(SshUserProfileSchema.safeParse({ ...smallest, port }).success, String(port)).toBe(
        true,
      );
    }
    expect(profilesProblem([{ ...smallest, port: 0 }])).toBe("Profile 1: port: Must be at least 1");
    expect(profilesProblem([{ ...smallest, port: "22" }])).toContain("Profile 1: port:");
  });

  it("takes the key and the known hosts as paths without a control character or an empty path", () => {
    for (const field of ["identityFile", "knownHostsFile"] as const) {
      expect(SshUserProfileSchema.safeParse({ ...smallest, [field]: "" }).success, field).toBe(
        false,
      );
      expect(SshUserProfileSchema.safeParse({ ...smallest, [field]: "   " }).success, field).toBe(
        false,
      );
      expect(SshUserProfileSchema.safeParse({ ...smallest, [field]: "a\nb" }).success, field).toBe(
        false,
      );
      expect(SshUserProfileSchema.safeParse({ ...smallest, [field]: "a\0b" }).success, field).toBe(
        false,
      );
      expect(
        SshUserProfileSchema.safeParse({ ...smallest, [field]: "x".repeat(1025) }).success,
      ).toBe(false);
      expect(SshUserProfileSchema.safeParse({ ...smallest, [field]: "C:\\a b\\k" }).success).toBe(
        true,
      );
    }
  });

  it("has nowhere to put a password, a passphrase or a key's text", () => {
    for (const secret of ["password", "passphrase", "privateKey", "identity", "key"]) {
      const result = UserProfileSchema.safeParse({ ...smallest, [secret]: "hunter2" });
      expect(result.success, secret).toBe(false);
    }
  });

  it("keeps the shell fields of the remote shell optional, and refuses them when blank", () => {
    expect(UserProfileSchema.safeParse({ ...smallest, program: "  " }).success).toBe(false);
    expect(UserProfileSchema.safeParse({ ...smallest, cwd: "" }).success).toBe(false);
    expect(UserProfileSchema.safeParse({ ...smallest, program: "a\0b" }).success).toBe(false);
  });

  it("is refused in a shell profile, and a shell profile still needs its program", () => {
    expect(
      ShellUserProfileSchema.safeParse({ id: "x", name: "X", program: "sh", host: "h" }).success,
    ).toBe(false);
    expect(profilesProblem([{ id: "x", name: "X" }])).toBe(
      "Profile 1: program: Invalid input: expected string, received undefined",
    );
    expect(profilesProblem([{ kind: "telnet", id: "x", name: "X" }])).toContain("Profile 1: kind:");
  });

  it("follows the rules of ids of every profile, whichever kind", () => {
    expect(profilesProblem([smallest, { id: "sh", name: "Sh", program: "sh" }])).toBeUndefined();
    expect(profilesProblem([smallest, { ...smallest, name: "Again" }])).toBe(
      'Profile "Again": the id "box" is used by another profile',
    );
    expect(profilesProblem([{ ...smallest, id: "default" }])).toBe(
      'Profile "Box": the id "default" is reserved',
    );
    expect(profilesProblem([smallest], ["box"])).toBe(
      'Profile "Box": the id "box" is already a shell of this machine',
    );
    expect(profilesProblem([{ ...smallest, id: "Not An Id" }])).toContain("Profile 1: id:");
  });
});

/** The first profile of a file that has no comments, as the object it is. */
function firstProfileOf(text: string): object {
  const parsed = JSON.parse(text) as { profiles: object[] };
  return parsed.profiles[0] ?? {};
}

describe("config.jsonc with an SSH profile", () => {
  const text = `{
  "profiles": [
    // The shell of the build machine.
    { "id": "sh", "name": "Sh", "program": "sh" },
    {
      "kind": "ssh",
      "id": "build-box",
      "name": "Build box",
      "host": "build.example.org",
      "user": "deploy",
      "port": 2222,
      "identityFile": "C:\\\\Users\\\\me\\\\.ssh\\\\id_ed25519",
      "knownHostsFile": "C:\\\\Users\\\\me\\\\.ssh\\\\known_hosts"
    }
  ]
}`;

  it("is read, next to a shell profile, with its fields as written", () => {
    const parsed = parseConfigText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.profiles).toEqual([
      { id: "sh", name: "Sh", program: "sh" },
      {
        kind: "ssh",
        id: "build-box",
        name: "Build box",
        host: "build.example.org",
        user: "deploy",
        port: 2222,
        identityFile: "C:\\Users\\me\\.ssh\\id_ed25519",
        knownHostsFile: "C:\\Users\\me\\.ssh\\known_hosts",
      },
    ]);
  });

  it("says which field of which profile is wrong, with the line", () => {
    const bad = text.replace('"port": 2222', '"port": 70000');
    const parsed = parseConfigText(bad);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const [error] = parsed.errors;
    expect(error).toMatchObject({ path: "profiles[1].port" });
    expect(error === undefined ? "" : describeConfigError(error)).toContain("profiles[1].port");
  });

  it("says a profile of an unknown kind is not one", () => {
    const parsed = parseConfigText(text.replace('"kind": "ssh"', '"kind": "serial"'));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors[0]).toMatchObject({ path: "profiles[1].kind" });
  });

  it("gets a setting it lacked in the order of the schema, whichever kind the profile is", () => {
    const ssh = `{ "profiles": [ { "kind": "ssh", "id": "b", "name": "B", "host": "h", "port": 22, "cwd": "/x" } ] }`;
    const edited = editConfigText(ssh, [
      { path: ["profiles", 0, "user"], value: "me" },
      { path: ["profiles", 0, "identityFile"], value: "k" },
      { path: ["profiles", 0, "knownHostsFile"], value: "kh" },
      { path: ["profiles", 0, "program"], value: "bash" },
    ]);
    expect(Object.keys(firstProfileOf(edited))).toEqual([
      "kind",
      "id",
      "name",
      "host",
      "user",
      "port",
      "identityFile",
      "knownHostsFile",
      "program",
      "cwd",
    ]);
    const shell = `{ "profiles": [ { "id": "s", "name": "S", "program": "sh", "cwd": "/x" } ] }`;
    const args = editConfigText(shell, [{ path: ["profiles", 0, "args"], value: ["-l"] }]);
    expect(Object.keys(firstProfileOf(args))).toEqual(["id", "name", "program", "args", "cwd"]);
  });

  it("gets a new SSH profile appended with the comments and the other profile kept", () => {
    const base = `{
  // my shells
  "profiles": [
    { "id": "sh", "name": "Sh", "program": "sh" } // the plain one
  ]
}`;
    const edited = editConfigText(base, [{ path: ["profiles"], append: [full] }]);
    expect(edited).toContain("// my shells");
    expect(edited).toContain("// the plain one");
    const parsed = parseConfigText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.profiles?.[1]).toEqual(full);
  });
});
