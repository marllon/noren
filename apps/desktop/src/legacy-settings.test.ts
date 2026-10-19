import { describe, expect, it } from "vitest";
import { ConfigManager, DEFAULT_NOTIFICATION_SETTINGS, FakeBackend } from "@noren/model";
import { KEYBINDINGS_KEY } from "./keybindings";
import {
  NOTIFICATION_SETTINGS_KEY,
  legacyChanges,
  legacyValues,
  migrateLegacySettings,
  parseNotificationSettings,
} from "./legacy-settings";
import type { LegacyStorage, LegacyStorageArea } from "./legacy-settings";
import { LAYOUT_KEY } from "./layout";

const nothing: LegacyStorage = { layout: null, notifications: null, keybindings: null };

describe("parseNotificationSettings", () => {
  it("is on with a limit of 30 s when nothing is saved", () => {
    expect(parseNotificationSettings(null)).toEqual({ enabled: true, longCommandMs: 30_000 });
    expect(parseNotificationSettings(null)).not.toBe(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("reads the switch and the limit in seconds", () => {
    expect(parseNotificationSettings('{"enabled":false}')).toEqual({
      enabled: false,
      longCommandMs: 30_000,
    });
    expect(parseNotificationSettings('{"longCommandSeconds":60.5}')).toEqual({
      enabled: true,
      longCommandMs: 60_500,
    });
    expect(parseNotificationSettings('{"longCommandSeconds":0}').longCommandMs).toBe(0);
  });

  it("keeps the default of every field that is not usable", () => {
    for (const raw of [
      "",
      "not json",
      "[]",
      "7",
      "null",
      '{"enabled":"no","longCommandSeconds":"60"}',
      '{"longCommandSeconds":-1}',
      '{"longCommandSeconds":null}',
    ]) {
      expect(parseNotificationSettings(raw), raw).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    }
  });
});

describe("legacyValues", () => {
  it("is nothing when nothing was stored, and nothing for what was stored at its default", () => {
    expect(legacyValues(nothing)).toEqual({});
    expect(
      legacyValues({
        layout: JSON.stringify({
          side: "left",
          width: 200,
          density: "comfortable",
          tabs: "sidebar",
        }),
        notifications: '{"enabled":true,"longCommandSeconds":30}',
        keybindings: '{"preset":"safe","overrides":{}}',
      }),
    ).toEqual({});
  });

  it("is each choice that is not the default, in the words of the file's settings", () => {
    expect(
      legacyValues({
        layout: JSON.stringify({
          side: "right",
          width: 333,
          density: "compact",
          compact: true,
          keepOpen: true,
          tabs: "top",
          paneHeaders: true,
        }),
        notifications: '{"enabled":false,"longCommandSeconds":90}',
        keybindings: '{"preset":"browser"}',
      }),
    ).toEqual({
      side: "right",
      width: 333,
      density: "compact",
      compact: true,
      keepOpen: true,
      tabs: "top",
      paneHeaders: true,
      notifications: false,
      longCommandSeconds: 90,
      preset: "browser",
    });
  });

  it("ignores text that is not usable", () => {
    expect(
      legacyValues({ layout: "garbage", notifications: "[]", keybindings: "{not json" }),
    ).toEqual({});
  });
});

describe("legacyChanges", () => {
  const stored: LegacyStorage = {
    layout: JSON.stringify({ side: "right", width: 300, paneHeaders: true }),
    notifications: '{"longCommandSeconds":45}',
    keybindings: '{"preset":"browser"}',
  };

  it("asks for each choice, in the order of the file", () => {
    expect(
      legacyChanges(stored, {}).map((change) => [change.path.join("."), change.value]),
    ).toEqual([
      ["appearance.sidebar.position", "right"],
      ["appearance.sidebar.width", 300],
      ["appearance.paneHeaders", true],
      ["keybindings.preset", "browser"],
      ["notifications.longCommandSeconds", 45],
    ]);
  });

  it("leaves out what the file already says: the file wins", () => {
    const changes = legacyChanges(stored, {
      appearance: { sidebar: { position: "left" }, paneHeaders: false },
      keybindings: { preset: "safe" },
    });
    expect(changes.map((change) => change.path.join("."))).toEqual([
      "appearance.sidebar.width",
      "notifications.longCommandSeconds",
    ]);
  });

  it("is nothing when there is nothing", () => {
    expect(legacyChanges(nothing, {})).toEqual([]);
  });
});

/** A browser storage in memory; `blocked` makes every call throw. */
function memoryStorage(initial: Record<string, string> = {}, blocked = false) {
  const data = new Map(Object.entries(initial));
  const area: LegacyStorageArea = {
    getItem: (key) => {
      if (blocked) throw new Error("blocked");
      return data.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (blocked) throw new Error("blocked");
      data.set(key, value);
    },
    removeItem: (key) => {
      if (blocked) throw new Error("blocked");
      data.delete(key);
    },
  };
  return { area, data };
}

async function started(config: string | null) {
  const backend = new FakeBackend({ config });
  const manager = new ConfigManager();
  await manager.start(backend);
  return { backend, manager };
}

const OLD = {
  [LAYOUT_KEY]: JSON.stringify({ side: "right", width: 320, density: "compact" }),
  [NOTIFICATION_SETTINGS_KEY]: '{"enabled":false,"longCommandSeconds":60}',
  [KEYBINDINGS_KEY]: JSON.stringify({
    preset: "browser",
    overrides: { "pane.zoom": "Ctrl+Alt+KeyM" },
  }),
};

describe("migrateLegacySettings", () => {
  it("does nothing, and writes nothing, without the old keys", async () => {
    const { backend, manager } = await started("// mine\n{}\n");
    const { area } = memoryStorage();
    expect(await migrateLegacySettings(area, manager)).toBe("nothing");
    expect(await migrateLegacySettings(undefined, manager)).toBe("nothing");
    expect(backend.callsTo("saveConfig")).toHaveLength(0);
  });

  it("moves the old choices into the file, keeps its comments, and removes the old keys", async () => {
    const { backend, manager } = await started(
      '// my settings\n{\n  "appearance": { "tabs": "top" }, // up there\n}\n',
    );
    const { area, data } = memoryStorage(OLD);

    expect(await migrateLegacySettings(area, manager)).toBe("moved");

    expect(backend.configContent).toContain("// my settings");
    expect(backend.configContent).toContain("// up there");
    expect(manager.state.config).toEqual({
      appearance: { sidebar: { position: "right", width: 320 }, density: "compact", tabs: "top" },
      keybindings: { preset: "browser" },
      notifications: { enabled: false, longCommandSeconds: 60 },
    });
    // The user's own chords stay in the storage, without the preset; the rest is gone.
    expect([...data.keys()]).toEqual([KEYBINDINGS_KEY]);
    expect(JSON.parse(data.get(KEYBINDINGS_KEY) ?? "null")).toEqual({
      overrides: { "pane.zoom": "Ctrl+Alt+KeyM" },
    });
    // One write for all of it.
    expect(backend.callsTo("saveConfig")).toHaveLength(1);
  });

  it("creates the file when there is none", async () => {
    const { backend, manager } = await started(null);
    const { area } = memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ side: "right" }) });
    expect(await migrateLegacySettings(area, manager)).toBe("moved");
    expect(backend.configContent).toBe(
      '{\n  "appearance": {\n    "sidebar": {\n      "position": "right"\n    }\n  }\n}\n',
    );
  });

  it("lets the file win over an old choice", async () => {
    const { backend, manager } = await started(
      '{ "appearance": { "sidebar": { "position": "left" } } }',
    );
    const { area } = memoryStorage({
      [LAYOUT_KEY]: JSON.stringify({ side: "right", density: "compact" }),
    });
    await migrateLegacySettings(area, manager);
    expect(manager.state.config.appearance?.sidebar?.position).toBe("left");
    expect(manager.state.config.appearance?.density).toBe("compact");
    expect(backend.configContent).toContain('"position": "left"');
  });

  it("removes the old keys without creating a file when every old choice was the default", async () => {
    const { backend, manager } = await started(null);
    const { area, data } = memoryStorage({
      [LAYOUT_KEY]: JSON.stringify({ side: "left", width: 200 }),
      [NOTIFICATION_SETTINGS_KEY]: '{"enabled":true}',
      [KEYBINDINGS_KEY]: '{"preset":"safe","overrides":{}}',
    });
    expect(await migrateLegacySettings(area, manager)).toBe("moved");
    expect(backend.callsTo("saveConfig")).toHaveLength(0);
    expect(backend.configContent).toBeNull();
    expect(data.size).toBe(0);
  });

  it("leaves the user's own chords alone when the stored shortcuts have no preset", async () => {
    const { manager } = await started(null);
    const stored = JSON.stringify({ overrides: { "pane.zoom": null } });
    const { area, data } = memoryStorage({ [KEYBINDINGS_KEY]: stored });
    expect(await migrateLegacySettings(area, manager)).toBe("nothing");
    expect(data.get(KEYBINDINGS_KEY)).toBe(stored);
  });

  it("is done once: a second start finds nothing to move", async () => {
    const { manager } = await started(null);
    const { area } = memoryStorage(OLD);
    expect(await migrateLegacySettings(area, manager)).toBe("moved");
    expect(await migrateLegacySettings(area, manager)).toBe("nothing");
  });

  it("waits for the next start when the file has a problem, and loses nothing", async () => {
    const broken = '{ "appearance": { "sidebar": { "position": "middle" } } }';
    const { backend, manager } = await started(broken);
    const { area, data } = memoryStorage(OLD);
    expect(await migrateLegacySettings(area, manager)).toBe("postponed");
    expect(backend.configContent).toBe(broken);
    expect(data.size).toBe(3);
  });

  it("waits for the next start when the file cannot be written, and loses nothing", async () => {
    const { backend, manager } = await started(null);
    backend.setConfigSaveFailure(new Error("disk full"));
    const { area, data } = memoryStorage(OLD);
    expect(await migrateLegacySettings(area, manager)).toBe("postponed");
    expect(data.size).toBe(3);
    backend.setConfigSaveFailure(undefined);
    expect(await migrateLegacySettings(area, manager)).toBe("moved");
    expect(manager.state.config.keybindings?.preset).toBe("browser");
  });

  it("does not fail when the storage is blocked", async () => {
    const { backend, manager } = await started(null);
    const { area } = memoryStorage(OLD, true);
    expect(await migrateLegacySettings(area, manager)).toBe("nothing");
    expect(backend.callsTo("saveConfig")).toHaveLength(0);
  });
});
