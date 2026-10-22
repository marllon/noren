import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager, FakeBackend } from "@noren/model";
import { SettingsWriter, TYPING_WAIT_MS } from "./settings-apply";
import type { PlanContext } from "./settings-screen";
import { profileRowsOf, withNewProfile } from "./settings-profiles";

// The writes of the settings screen with no Save (NOR-F20-10c), against a real `ConfigManager` and a
// fake file: what is written, when, and what is left of the draft after.

const FILE = `{
  // my layout
  "appearance": { "sidebar": { "position": "left", "width": 240 } },
  "terminal": { "scrollback": 5000 }
}
`;

async function started(text: string | null = FILE, context: () => PlanContext = () => ({})) {
  const backend = new FakeBackend({ config: text });
  const manager = new ConfigManager();
  await manager.start(backend);
  const writer = new SettingsWriter(manager, context);
  return { backend, manager, writer };
}

const saves = (backend: FakeBackend) =>
  backend.calls.filter((call) => call.method === "saveConfig");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SettingsWriter: a choice", () => {
  it("is written at once, and only the setting that changed, with the rest of the file as it was", async () => {
    const { backend, writer } = await started();
    writer.edit((now) => ({ ...now, side: "right" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(saves(backend)).toHaveLength(1);
    // The comment, the width and the terminal section are still there; only the position changed.
    expect(backend.configContent).toBe(FILE.replace('"position": "left"', '"position": "right"'));
    expect(writer.state.draft).toEqual({});
    expect(writer.state.failure).toBeUndefined();
  });

  it("writes nothing for a setting put back where it was", async () => {
    const { backend, writer } = await started();
    writer.edit((now) => ({ ...now, side: "left" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(saves(backend)).toHaveLength(0);
    expect(writer.state.draft).toEqual({});
  });

  it("writes a setting of a section with its own plan (terminal, archive, AI)", async () => {
    const { backend, writer } = await started();
    writer.edit((now) => ({ ...now, terminal: { ...now.terminal, ligatures: true } }));
    writer.edit((now) => ({ ...now, archive: { ...now.archive, enabled: false } }));
    await vi.advanceTimersByTimeAsync(0);

    const text = backend.configContent ?? "";
    expect(text).toContain('"ligatures": true');
    expect(text).toMatch(/"archive": \{\s*"enabled": false\s*\}/);
    expect(text).toContain('"scrollback": 5000');
    expect(writer.state.draft).toEqual({});
  });
});

describe("SettingsWriter: a text on its way", () => {
  it("waits for the pause after the last key and is written once", async () => {
    const { backend, writer } = await started();
    for (const text of ["3", "30", "300"]) {
      writer.edit((now) => ({ ...now, width: text }), TYPING_WAIT_MS);
      await vi.advanceTimersByTimeAsync(TYPING_WAIT_MS - 100);
      expect(saves(backend)).toHaveLength(0);
    }
    await vi.advanceTimersByTimeAsync(100);

    expect(saves(backend)).toHaveLength(1);
    expect(backend.configContent).toContain('"width": 300');
    expect(writer.state.draft).toEqual({});
  });

  it("is written as soon as the person leaves the box", async () => {
    const { backend, writer } = await started();
    writer.edit((now) => ({ ...now, width: "280" }), TYPING_WAIT_MS);
    writer.soon();
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.configContent).toContain('"width": 280');
  });

  it("is written by the Enter of the box (a flush) and by closing (a settle)", async () => {
    const { backend, writer } = await started();
    writer.edit((now) => ({ ...now, width: "281" }), TYPING_WAIT_MS);
    expect(writer.waiting).toBe(true);
    await expect(writer.flush()).resolves.toBe(true);
    expect(backend.configContent).toContain('"width": 281');
    expect(writer.waiting).toBe(false);

    writer.edit((now) => ({ ...now, width: "282" }), TYPING_WAIT_MS);
    await expect(writer.settle()).resolves.toBe(true);
    expect(backend.configContent).toContain('"width": 282');
  });

  it("is still written when the screen goes away with the pause not over", async () => {
    const { backend, writer } = await started();
    writer.edit((now) => ({ ...now, width: "290" }), TYPING_WAIT_MS);
    writer.dispose();
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.configContent).toContain('"width": 290');
  });

  it("keeps the text in the draft while it is not a value of the file, and does not write it", async () => {
    const { backend, writer } = await started();
    writer.edit((now) => ({ ...now, width: "9999" }), TYPING_WAIT_MS);
    await vi.advanceTimersByTimeAsync(TYPING_WAIT_MS);

    expect(saves(backend)).toHaveLength(0);
    expect(backend.configContent).toBe(FILE);
    expect(writer.state.draft.width).toBe("9999");
  });

  it("writes the valid settings while another box holds a value the file would refuse", async () => {
    const { backend, writer } = await started();
    writer.edit((now) => ({ ...now, width: "9999" }), TYPING_WAIT_MS);
    writer.edit((now) => ({ ...now, density: "compact" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.configContent).toContain('"density": "compact"');
    expect(backend.configContent).toContain('"width": 240');
    // The refused box keeps its text, with the reason that the screen draws from the plan.
    expect(writer.state.draft).toEqual({ width: "9999" });
  });

  it("writes the number once it becomes valid, and the draft is empty after", async () => {
    const { backend, writer } = await started();
    writer.edit((now) => ({ ...now, width: "9999" }), TYPING_WAIT_MS);
    await vi.advanceTimersByTimeAsync(TYPING_WAIT_MS);
    writer.edit((now) => ({ ...now, width: "300" }), TYPING_WAIT_MS);
    await vi.advanceTimersByTimeAsync(TYPING_WAIT_MS);

    expect(backend.configContent).toContain('"width": 300');
    expect(writer.state.draft).toEqual({});
  });

  it("settles a text that the file writes differently (0.80 is the 0.8 of the file)", async () => {
    const { backend, writer } = await started();
    writer.edit((now) => ({ ...now, backgroundOpacity: "0.80" }), TYPING_WAIT_MS);
    await vi.advanceTimersByTimeAsync(TYPING_WAIT_MS);

    expect(backend.configContent).toContain('"opacity": 0.8');
    expect(writer.state.draft).toEqual({});
  });
});

describe("SettingsWriter: what goes wrong", () => {
  it("says why a write failed, keeps the draft, and goes on when the disk takes it", async () => {
    const { backend, writer } = await started();
    backend.setConfigSaveFailure(new Error("disk full"));
    writer.edit((now) => ({ ...now, density: "compact" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(writer.state.failure).toMatch(/disk full/);
    expect(writer.state.draft).toEqual({ density: "compact" });
    expect(backend.configContent).toBe(FILE);
    await expect(writer.settle()).resolves.toBe(false);

    backend.setConfigSaveFailure(undefined);
    await expect(writer.settle()).resolves.toBe(true);
    expect(writer.state.failure).toBeUndefined();
    expect(writer.state.draft).toEqual({});
    expect(backend.configContent).toContain('"density": "compact"');
  });

  it("writes nothing while the file has a problem of its own, and keeps what was changed", async () => {
    const { backend, writer } = await started('{ "appearance": { "density": "wide" } }');
    writer.edit((now) => ({ ...now, side: "right" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(saves(backend)).toHaveLength(0);
    expect(writer.state.draft).toEqual({ side: "right" });
    await expect(writer.settle()).resolves.toBe(false);
  });

  it("has nothing to write, and says so, when the draft is empty", async () => {
    const { writer } = await started('{ "appearance": { "density": "wide" } }');
    await expect(writer.settle()).resolves.toBe(true);
  });

  it("lets a change another program made show through once what was written is settled", async () => {
    const { backend, writer } = await started();
    writer.edit((now) => ({ ...now, width: "300" }), TYPING_WAIT_MS);
    await vi.advanceTimersByTimeAsync(TYPING_WAIT_MS);
    backend.setConfig(FILE.replace("240", "260"));
    // The draft is empty, so the next write of something else does not take the width back to 300.
    writer.edit((now) => ({ ...now, density: "compact" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.configContent).toContain('"width": 260');
    expect(backend.configContent).toContain('"density": "compact"');
  });
});

describe("SettingsWriter: the profiles", () => {
  const NEW = { name: "Work", program: "pwsh.exe" };

  it("writes a new profile once it is valid, and the row is the profile of the file after", async () => {
    const { backend, manager, writer } = await started("{}");
    writer.edit((now) => ({ ...now, profiles: withNewProfile(now.profiles ?? []) }));
    await vi.advanceTimersByTimeAsync(0);
    // A blank row is only a row waiting for its text: nothing is written for it.
    expect(saves(backend)).toHaveLength(0);

    writer.edit((now) => ({
      ...now,
      profiles: (now.profiles ?? []).map((row) => ({ ...row, ...NEW })),
    }));
    await vi.advanceTimersByTimeAsync(0);

    expect(saves(backend)).toHaveLength(1);
    expect(backend.configContent).toContain('"id": "work"');
    // The profile is the file's now, so the draft of the list is gone and the file is the list.
    expect(writer.state.draft.profiles).toBeUndefined();

    // An edit now changes that profile; it never adds a second one.
    writer.edit(
      (now) => ({
        ...now,
        profiles: (now.profiles ?? profileRowsOf(manager.state.config)).map((row) => ({
          ...row,
          program: "cmd.exe",
        })),
      }),
      TYPING_WAIT_MS,
    );
    await vi.advanceTimersByTimeAsync(TYPING_WAIT_MS);
    expect(backend.configContent).toContain('"program": "cmd.exe"');
    expect(backend.configContent?.match(/"id"/g)).toHaveLength(1);
  });

  it("holds the new profile the person is still in, until they leave it or close the screen", async () => {
    let held: ReadonlySet<string> = new Set(["new-1"]);
    const { backend, writer } = await started("{}", () => ({ heldProfileRows: held }));
    writer.edit((now) => ({
      ...now,
      profiles: withNewProfile(now.profiles ?? []).map((row) => ({ ...row, ...NEW })),
    }));
    await vi.advanceTimersByTimeAsync(TYPING_WAIT_MS);
    expect(saves(backend)).toHaveLength(0);

    // Leaving the row writes it, with the id of the whole name.
    held = new Set();
    writer.soon();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.configContent).toContain('"name": "Work"');
  });

  it("writes the held profile when the screen closes", async () => {
    const held: ReadonlySet<string> = new Set(["new-1"]);
    const { backend, writer } = await started("{}", () => ({ heldProfileRows: held }));
    writer.edit((now) => ({
      ...now,
      profiles: withNewProfile(now.profiles ?? []).map((row) => ({ ...row, ...NEW })),
    }));
    await expect(writer.settle()).resolves.toBe(true);

    expect(backend.configContent).toContain('"id": "work"');
  });

  it("tells a profile that is not valid yet, and writes the rest", async () => {
    const { backend, writer } = await started("{}");
    writer.edit((now) => ({
      ...now,
      side: "right",
      profiles: withNewProfile(now.profiles ?? []).map((row) => ({ ...row, name: "Half" })),
    }));
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.configContent).toContain('"position": "right"');
    expect(backend.configContent).not.toContain("Half");
    // The row stays, with what was typed in it.
    expect(writer.state.draft.profiles?.map((row) => row.name)).toEqual(["Half"]);
  });
});

describe("SettingsWriter: the picture", () => {
  const PATH = "backgrounds/sky.png";
  const IMAGE = /"image": "backgrounds\/sky.png"/;

  it("waits for the window to read it, and is written when the read is done and the writer is told", async () => {
    let picture: "loading" | "ready" | "failed" = "loading";
    const { backend, writer } = await started("{}", () => ({ picture }));
    writer.edit((now) => ({ ...now, backgroundImage: PATH }), TYPING_WAIT_MS);
    await vi.advanceTimersByTimeAsync(TYPING_WAIT_MS);
    expect(saves(backend)).toHaveLength(0);
    expect(writer.state.draft.backgroundImage).toBe(PATH);

    picture = "ready";
    writer.soon();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.configContent).toMatch(IMAGE);
    expect(writer.state.draft).toEqual({});
  });

  it("is never written when the window could not read it", async () => {
    const { backend, writer } = await started("{}", () => ({ picture: "failed" }));
    writer.edit((now) => ({ ...now, backgroundImage: PATH }));
    await vi.advanceTimersByTimeAsync(0);
    await expect(writer.settle()).resolves.toBe(true);

    expect(saves(backend)).toHaveLength(0);
    expect(writer.state.draft.backgroundImage).toBe(PATH);
  });

  it("goes in when the screen closes while the picture is still being read", async () => {
    const { backend, writer } = await started("{}", () => ({ picture: "loading" }));
    writer.edit((now) => ({ ...now, backgroundImage: PATH }), TYPING_WAIT_MS);
    await expect(writer.settle()).resolves.toBe(true);

    expect(backend.configContent).toMatch(IMAGE);
  });
});

describe("SettingsWriter: the list of profiles and the file that changes under it", () => {
  const TWO = `{ "profiles": [{ "id": "dev", "name": "Dev", "program": "pwsh.exe" }] }`;
  const WITH_OPS = `{ "profiles": [{ "id": "dev", "name": "Dev", "program": "pwsh.exe" }, { "id": "ops", "name": "Ops", "program": "bash" }] }`;

  it("never takes out a profile that came into the file while the list was open", async () => {
    const { backend, manager, writer } = await started(TWO);
    // The person added a row, so the list of rows is a draft that stays (the row is waiting for its text).
    writer.edit((now) => ({
      ...now,
      profiles: withNewProfile(now.profiles ?? profileRowsOf(manager.state.config)),
    }));
    await vi.advanceTimersByTimeAsync(0);
    // Another program (or a pull) puts a profile in the file.
    backend.setConfig(WITH_OPS);
    writer.edit((now) => ({ ...now, side: "right" }));
    await vi.advanceTimersByTimeAsync(0);

    const text = backend.configContent ?? "";
    expect(text).toContain('"position": "right"');
    expect(text).toContain('"id": "ops"');
    expect(text).toContain('"id": "dev"');
    // The list of rows has the profile now, besides the one waiting for its text.
    expect(writer.state.draft.profiles?.map((row) => row.key)).toEqual(["dev", "new-1", "ops"]);
  });

  it("takes out a profile the person took away, and does not bring it back with the next write", async () => {
    const { backend, manager, writer } = await started(WITH_OPS);
    writer.markProfileRemoved("dev");
    writer.edit((now) => ({
      ...now,
      profiles: (now.profiles ?? profileRowsOf(manager.state.config)).filter(
        (row) => row.key !== "dev",
      ),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.configContent).not.toContain('"id": "dev"');
    expect(backend.configContent).toContain('"id": "ops"');

    writer.edit((now) => ({ ...now, side: "right" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.configContent).not.toContain('"id": "dev"');
  });
});
