import { FakeBackend } from "@noren/model";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  DEFAULT_KEYBINDINGS,
  createResolver,
  findConflicts,
  resolveBindings,
} from "./keybindings";
import type { Keybindings, ShortcutEvent } from "./keybindings";
import { QUICK_TOGGLE_ACTION, QuickShortcutSync, quickShortcutLine } from "./quick-shortcut";
import { shortcutRows } from "./shortcuts-screen";
import { TauriBackend } from "./tauri-backend";
import type { TauriBridge } from "./tauri-backend";

const ctrlBackquote: ShortcutEvent = {
  code: "Backquote",
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  metaKey: false,
};

describe("the quick terminal action", () => {
  it("has Ctrl+` in both presets and nothing else holds it", () => {
    for (const preset of ["safe", "browser"] as const) {
      const keybindings: Keybindings = { preset, overrides: {} };
      const { chords } = resolveBindings(keybindings);
      expect(chords[QUICK_TOGGLE_ACTION]).toBe("Ctrl+Backquote");
      expect(findConflicts(chords)).toEqual([]);
      expect(createResolver(chords)(ctrlBackquote)?.command).toEqual({ kind: "quick-toggle" });
    }
  });

  it("is listed on the shortcuts screen with its chord, and follows a chord the user records", () => {
    const row = shortcutRows(DEFAULT_KEYBINDINGS).find((r) => r.id === QUICK_TOGGLE_ACTION);
    expect(row).toMatchObject({
      title: "Show or hide quick terminal",
      category: "General",
      chord: "Ctrl+Backquote",
      overridden: false,
    });
    const moved = shortcutRows({
      preset: "safe",
      overrides: { [QUICK_TOGGLE_ACTION]: "Ctrl+Alt+KeyQ" },
    }).find((r) => r.id === QUICK_TOGGLE_ACTION);
    expect(moved).toMatchObject({ chord: "Ctrl+Alt+KeyQ", overridden: true });
    expect(ACTIONS.filter((a) => a.id === QUICK_TOGGLE_ACTION)).toHaveLength(1);
  });
});

describe("QuickShortcutSync", () => {
  it("registers the chord in force", async () => {
    const backend = new FakeBackend();
    const sync = new QuickShortcutSync(backend);
    expect(sync.status).toEqual({ kind: "unknown" });
    expect(await sync.sync("Ctrl+Backquote")).toEqual({
      kind: "registered",
      chord: "Ctrl+Backquote",
    });
    expect(backend.quickShortcut).toBe("Ctrl+Backquote");
  });

  it("registers again when the chord changes, and takes it off when the key is removed", async () => {
    const backend = new FakeBackend();
    const sync = new QuickShortcutSync(backend);
    await sync.sync("Ctrl+Backquote");
    await sync.sync("Ctrl+Alt+KeyQ");
    expect(backend.quickShortcut).toBe("Ctrl+Alt+KeyQ");
    expect(sync.status).toEqual({ kind: "registered", chord: "Ctrl+Alt+KeyQ" });
    expect(await sync.sync(undefined)).toEqual({ kind: "off" });
    expect(backend.quickShortcut).toBeNull();
    expect(backend.callsTo("setQuickShortcut").map((call) => call.args[0])).toEqual([
      "Ctrl+Backquote",
      "Ctrl+Alt+KeyQ",
      null,
    ]);
  });

  it("asks once for a chord asked twice in a row", async () => {
    const backend = new FakeBackend();
    const sync = new QuickShortcutSync(backend);
    await Promise.all([sync.sync("Ctrl+Backquote"), sync.sync("Ctrl+Backquote")]);
    await sync.sync("Ctrl+Backquote");
    expect(backend.callsTo("setQuickShortcut")).toHaveLength(1);
  });

  it("ends with the last chord when changes come one after the other", async () => {
    const backend = new FakeBackend();
    const sync = new QuickShortcutSync(backend);
    void sync.sync("Ctrl+Backquote");
    void sync.sync("Ctrl+Alt+KeyQ");
    await sync.sync("Ctrl+Alt+KeyW");
    expect(backend.callsTo("setQuickShortcut").map((call) => call.args[0])).toEqual([
      "Ctrl+Backquote",
      "Ctrl+Alt+KeyQ",
      "Ctrl+Alt+KeyW",
    ]);
    expect(backend.quickShortcut).toBe("Ctrl+Alt+KeyW");
  });

  it("reports a chord another program holds, keeps the one before, and tries again when asked again", async () => {
    const backend = new FakeBackend();
    const sync = new QuickShortcutSync(backend);
    await sync.sync("Ctrl+Backquote");
    backend.setQuickShortcutFailure(new Error("HotKey already registered"));
    const status = await sync.sync("Ctrl+Alt+KeyQ");
    expect(status).toEqual({
      kind: "refused",
      chord: "Ctrl+Alt+KeyQ",
      reason: "HotKey already registered",
    });
    expect(backend.quickShortcut).toBe("Ctrl+Backquote");
    // The other program let go.
    backend.setQuickShortcutFailure(undefined);
    expect(await sync.sync("Ctrl+Alt+KeyQ")).toEqual({
      kind: "registered",
      chord: "Ctrl+Alt+KeyQ",
    });
    expect(backend.quickShortcut).toBe("Ctrl+Alt+KeyQ");
  });

  it("tells its listeners about each status", async () => {
    const sync = new QuickShortcutSync(new FakeBackend());
    const seen: string[] = [];
    const stop = sync.subscribe(() => seen.push(sync.status.kind));
    await sync.sync("Ctrl+Backquote");
    await sync.sync(undefined);
    stop();
    await sync.sync("Ctrl+Alt+KeyQ");
    expect(seen).toEqual(["registered", "off"]);
  });
});

describe("the toggle on the FakeBackend", () => {
  it("flips the fake window and says whether it shows", async () => {
    const backend = new FakeBackend();
    expect(backend.quickVisible).toBe(false);
    expect(await backend.quickToggle()).toBe(true);
    expect(backend.quickVisible).toBe(true);
    expect(await backend.quickToggle()).toBe(false);
    expect(backend.callsTo("quickToggle")).toHaveLength(2);
  });
});

describe("TauriBackend", () => {
  function bridge() {
    const invocations: { command: string; args: Record<string, unknown> | undefined }[] = [];
    const answers: Record<string, unknown> = { quick_toggle: true };
    const failing = new Map<string, string>();
    const made: TauriBridge = {
      invoke: <T>(command: string, args?: Record<string, unknown>) => {
        invocations.push({ command, args });
        const failure = failing.get(command);
        // Tauri rejects with the string the command returned.
        if (failure !== undefined) return Promise.reject(failure);
        return Promise.resolve(answers[command] as T);
      },
      listen: () => Promise.resolve(() => undefined),
      createChannel: () => ({ onmessage: () => undefined }),
    };
    return { made, invocations, failing };
  }

  it("toggles through quick_toggle and sets the chord through quick_shortcut_set", async () => {
    const fake = bridge();
    const backend = new TauriBackend(fake.made);
    expect(await backend.quickToggle()).toBe(true);
    await backend.setQuickShortcut("Ctrl+Backquote");
    await backend.setQuickShortcut(null);
    expect(fake.invocations).toEqual([
      { command: "quick_toggle", args: undefined },
      { command: "quick_shortcut_set", args: { chord: "Ctrl+Backquote" } },
      { command: "quick_shortcut_set", args: { chord: null } },
    ]);
  });

  it("shows the reason the Rust side gave when the system refuses the chord", async () => {
    const fake = bridge();
    fake.failing.set("quick_shortcut_set", "could not register the shortcut: already registered");
    const sync = new QuickShortcutSync(new TauriBackend(fake.made));
    const status = await sync.sync("Ctrl+Backquote");
    expect(status.kind).toBe("refused");
    if (status.kind === "refused") expect(status.reason).toContain("already registered");
  });
});

describe("quickShortcutLine", () => {
  it("shows the chord as the screens spell it", () => {
    expect(
      quickShortcutLine("Ctrl+Backquote", { kind: "registered", chord: "Ctrl+Backquote" }),
    ).toBe(
      "Quick terminal: Ctrl+` shows and hides it from any program. Change it in Keyboard shortcuts.",
    );
  });

  it("says when there is no key, and when the system refused this one", () => {
    expect(quickShortcutLine(undefined, { kind: "off" })).toContain("no shortcut");
    const line = quickShortcutLine("Ctrl+Backquote", {
      kind: "refused",
      chord: "Ctrl+Backquote",
      reason: "already registered",
    });
    expect(line).toContain("Ctrl+` is not available (already registered)");
    // A refusal of an older chord says nothing about the one shown now.
    expect(
      quickShortcutLine("Ctrl+Alt+KeyQ", {
        kind: "refused",
        chord: "Ctrl+Backquote",
        reason: "x",
      }),
    ).toContain("shows and hides");
  });
});
