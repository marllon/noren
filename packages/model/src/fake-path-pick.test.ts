import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";

// The chooser of a path field of the settings screen (the key file and the known-hosts file of an
// ssh profile, the folder and the program of a shell profile). The fake one answers what a test
// queued, the way the fake picture chooser does, so no test ever opens the chooser of a system.

describe("FakeBackend.pickPath", () => {
  const key = { kind: "file", title: "Choose a key file" } as const;

  it("is closed without a choice (null) until a test queues what the person chooses", async () => {
    const backend = new FakeBackend();
    await expect(backend.pickPath(key)).resolves.toBeNull();
  });

  it("answers what was queued, one answer for each time it is opened, in order", async () => {
    const backend = new FakeBackend();
    backend.setPathPick("C:\\Users\\a\\.ssh\\id_ed25519");
    backend.setPathPick(null);
    backend.setPathPick("C:\\Work");
    await expect(backend.pickPath(key)).resolves.toBe("C:\\Users\\a\\.ssh\\id_ed25519");
    await expect(backend.pickPath(key)).resolves.toBeNull();
    await expect(backend.pickPath({ kind: "folder", title: "Choose a folder" })).resolves.toBe(
      "C:\\Work",
    );
    await expect(backend.pickPath(key)).resolves.toBeNull();
  });

  it("rejects when what was queued is an error, once, and then it is closed again", async () => {
    const backend = new FakeBackend();
    backend.setPathPick(new Error("no window to open it over"));
    await expect(backend.pickPath(key)).rejects.toThrow("no window to open it over");
    await expect(backend.pickPath(key)).resolves.toBeNull();
  });

  it("records what the chooser lists and its title, and queueing is not a call", async () => {
    const backend = new FakeBackend();
    backend.setPathPick("C:\\Work");
    expect(backend.callsTo("pickPath")).toEqual([]);
    await backend.pickPath({ kind: "folder", title: "Escolher uma pasta" });
    expect(backend.callsTo("pickPath").map((call) => call.args)).toEqual([
      ["folder", "Escolher uma pasta"],
    ]);
  });

  it("does not share its answers with the picture chooser", async () => {
    const backend = new FakeBackend();
    backend.setImagePick("C:\\Pictures\\a.png");
    await expect(backend.pickPath(key)).resolves.toBeNull();
    await expect(
      backend.pickBackgroundImage({ title: "Choose a picture", filter: "Pictures" }),
    ).resolves.toBe("C:\\Pictures\\a.png");
  });
});
