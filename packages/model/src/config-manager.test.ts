import { describe, expect, it, vi } from "vitest";
import type { ConfigSource, ConfigState } from "./index";
import { ConfigManager, FakeBackend, describeConfigError } from "./index";

const RIGHT = '{ "appearance": { "sidebar": { "position": "right" } } }';
const LEFT = '{ "appearance": { "sidebar": { "position": "left" } } }';
const BROKEN = `{
  "appearance": {
    "sidebar": { "position": "middle" }
  }
}`;

async function started(config: string | null = null) {
  const backend = new FakeBackend({ config });
  const manager = new ConfigManager();
  await manager.start(backend);
  return { backend, manager };
}

describe("ConfigManager", () => {
  it("starts with nothing set and no errors", () => {
    const manager = new ConfigManager();
    expect(manager.state).toEqual({ config: {}, errors: [] });
  });

  it("reads the file at start; no file means nothing is set", async () => {
    expect((await started(RIGHT)).manager.state.config).toEqual({
      appearance: { sidebar: { position: "right" } },
    });
    expect((await started()).manager.state).toEqual({ config: {}, errors: [] });
  });

  it("applies a change of the file at once, without a restart", async () => {
    const { backend, manager } = await started(LEFT);
    backend.setConfig(RIGHT);
    expect(manager.state.config.appearance?.sidebar?.position).toBe("right");
    backend.setConfig(LEFT);
    expect(manager.state.config.appearance?.sidebar?.position).toBe("left");
  });

  it("keeps the previous settings when the new text is invalid, and gives the line", async () => {
    const { backend, manager } = await started(RIGHT);
    const before = manager.state.config;
    backend.setConfig(BROKEN);

    expect(manager.state.config).toBe(before);
    expect(manager.state.errors).toHaveLength(1);
    expect(manager.state.errors[0]).toMatchObject({ path: "appearance.sidebar.position", line: 3 });
    expect(manager.state.errors.map(describeConfigError)).toEqual([
      expect.stringMatching(/^line 3, column \d+: appearance\.sidebar\.position: /),
    ]);
  });

  it("keeps the previous settings when the new text is not even JSON", async () => {
    const { backend, manager } = await started(RIGHT);
    backend.setConfig('{ "appearance": ');
    expect(manager.state.config.appearance?.sidebar?.position).toBe("right");
    expect(manager.state.errors[0]?.line).toBe(1);
  });

  it("clears the errors, and applies, once the text is valid again", async () => {
    const { backend, manager } = await started(RIGHT);
    backend.setConfig(BROKEN);
    expect(manager.state.errors).toHaveLength(1);
    backend.setConfig(LEFT);
    expect(manager.state.errors).toEqual([]);
    expect(manager.state.config.appearance?.sidebar?.position).toBe("left");
  });

  it("starts with the defaults when the file is invalid from the start", async () => {
    const { manager } = await started(BROKEN);
    expect(manager.state.config).toEqual({});
    expect(manager.state.errors).toHaveLength(1);
  });

  it("goes back to nothing set when the file is removed", async () => {
    const { backend, manager } = await started(RIGHT);
    backend.setConfig(null);
    expect(manager.state).toEqual({ config: {}, errors: [] });
  });

  it("does not tell the listeners about a text it already applied", async () => {
    const { backend, manager } = await started(RIGHT);
    const listener = vi.fn();
    manager.subscribe(listener);
    const before = manager.state;

    manager.apply(RIGHT);
    backend.setConfig(RIGHT);
    expect(listener).not.toHaveBeenCalled();
    expect(manager.state).toBe(before);

    backend.setConfig(LEFT);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.state).not.toBe(before);
  });

  it("tells the listeners about new errors, and stops telling one that unsubscribed", async () => {
    const { backend, manager } = await started(RIGHT);
    const heard: ConfigState[] = [];
    const stop = manager.subscribe(() => heard.push(manager.state));
    backend.setConfig(BROKEN);
    expect(heard.map((state) => state.errors.length)).toEqual([1]);
    stop();
    backend.setConfig(LEFT);
    expect(heard).toHaveLength(1);
  });

  it("stops following the file after stop()", async () => {
    const { backend, manager } = await started(RIGHT);
    manager.stop();
    backend.setConfig(LEFT);
    expect(manager.state.config.appearance?.sidebar?.position).toBe("right");
  });

  it("follows only the newest source after start() is called again", async () => {
    const first = new FakeBackend({ config: RIGHT });
    const second = new FakeBackend({ config: LEFT });
    const manager = new ConfigManager();
    await manager.start(first);
    await manager.start(second);
    expect(manager.state.config.appearance?.sidebar?.position).toBe("left");
    first.setConfig('{ "appearance": { "density": "compact" } }');
    expect(manager.state.config.appearance?.density).toBeUndefined();
  });

  it("watches before it reads, so a change made while reading is not lost", async () => {
    const backend = new FakeBackend({ config: RIGHT });
    const calls: string[] = [];
    const source: ConfigSource = {
      watchConfig: (callback) => {
        calls.push("watch");
        return backend.watchConfig(callback);
      },
      saveConfig: (text) => backend.saveConfig(text),
      loadConfig: async () => {
        calls.push("load");
        // The file is changed while this read is in flight, and the read still answers the old text.
        const old = await backend.loadConfig();
        backend.setConfig(LEFT);
        return old;
      },
    };
    const manager = new ConfigManager();
    await manager.start(source);
    expect(calls).toEqual(["watch", "load"]);
    expect(manager.state.config.appearance?.sidebar?.position).toBe("left");
  });

  it("turns a failed read into an error and keeps what it had", async () => {
    const backend = new FakeBackend({ config: RIGHT });
    const manager = new ConfigManager();
    await manager.start(backend);
    await manager.start({
      watchConfig: (callback) => backend.watchConfig(callback),
      saveConfig: (text) => backend.saveConfig(text),
      loadConfig: () => Promise.reject(new Error("access denied")),
    });
    expect(manager.state.config.appearance?.sidebar?.position).toBe("right");
    expect(manager.state.errors.map(describeConfigError)).toEqual([
      "Could not read config.jsonc: access denied",
    ]);
    // The watcher is still there: a good text clears the error.
    backend.setConfig(LEFT);
    expect(manager.state.errors).toEqual([]);
    expect(manager.state.config.appearance?.sidebar?.position).toBe("left");
  });
});

describe("FakeBackend config", () => {
  it("answers the text it holds, records the calls, and tells the watchers of a change only", async () => {
    const backend = new FakeBackend({ config: "{}" });
    await expect(backend.loadConfig()).resolves.toBe("{}");
    const heard: (string | null)[] = [];
    const stop = backend.watchConfig((text) => heard.push(text));

    backend.setConfig("{}");
    backend.setConfig('{ "a": 1 }');
    backend.setConfig(null);
    expect(heard).toEqual(['{ "a": 1 }', null]);
    expect(backend.configContent).toBeNull();
    await expect(backend.loadConfig()).resolves.toBeNull();

    stop();
    backend.setConfig("{}");
    expect(heard).toHaveLength(2);
    expect(backend.calls.map((call) => call.method)).toEqual([
      "loadConfig",
      "watchConfig",
      "loadConfig",
    ]);
  });
});

describe("ConfigManager.update", () => {
  const COMMENTED = `// mine
{
  "appearance": {
    "sidebar": { "position": "left" }, // keep it here
  },
}
`;

  it("edits only the settings asked for, keeps the comments, and applies at once", async () => {
    const { backend, manager } = await started(COMMENTED);
    const heard: (string | null)[] = [];
    backend.watchConfig((text) => heard.push(text));

    const result = await manager.update([
      { path: ["appearance", "sidebar", "width"], value: 260 },
      { path: ["notifications", "enabled"], value: false },
    ]);

    expect(result).toEqual({ ok: true, written: true });
    expect(backend.configContent).toContain("// mine");
    expect(backend.configContent).toContain("// keep it here");
    expect(backend.configContent).toContain('"position": "left"');
    expect(manager.state.config).toEqual({
      appearance: { sidebar: { position: "left", width: 260 } },
      notifications: { enabled: false },
    });
    // The file reported its own change and the manager already had that text: one tell, not a loop.
    expect(heard).toEqual([backend.configContent]);
    expect(backend.callsTo("saveConfig")).toHaveLength(1);
  });

  it("creates the file when there is none", async () => {
    const { backend, manager } = await started(null);
    const result = await manager.update([{ path: ["keybindings", "preset"], value: "browser" }]);
    expect(result).toEqual({ ok: true, written: true });
    expect(backend.configContent).toBe('{\n  "keybindings": {\n    "preset": "browser"\n  }\n}\n');
    expect(manager.state.config).toEqual({ keybindings: { preset: "browser" } });
  });

  it("writes nothing when the file already says it", async () => {
    const { backend, manager } = await started(COMMENTED);
    const result = await manager.update([
      { path: ["appearance", "sidebar", "position"], value: "left" },
    ]);
    expect(result).toEqual({ ok: true, written: false });
    expect(backend.callsTo("saveConfig")).toHaveLength(0);
    expect(backend.configContent).toBe(COMMENTED);
  });

  it("refuses to edit a file that has a problem of its own, and says where", async () => {
    const { backend, manager } = await started(BROKEN);
    const result = await manager.update([{ path: ["appearance", "tabs"], value: "top" }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("nothing was saved");
    expect(result.message).toContain("line 3");
    expect(result.errors).toHaveLength(1);
    expect(backend.callsTo("saveConfig")).toHaveLength(0);
    expect(backend.configContent).toBe(BROKEN);
  });

  it("refuses a value the settings do not allow, and leaves the file as it was", async () => {
    const { backend, manager } = await started(COMMENTED);
    const result = await manager.update([
      { path: ["appearance", "sidebar", "width"], value: 9999 },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("appearance.sidebar.width");
    expect(result.message).not.toContain("line ");
    expect(backend.configContent).toBe(COMMENTED);
    expect(manager.state.config.appearance?.sidebar?.width).toBeUndefined();
  });

  it("reports a file that could not be written and changes nothing", async () => {
    const { backend, manager } = await started(COMMENTED);
    backend.setConfigSaveFailure(new Error("disk full"));
    const result = await manager.update([{ path: ["appearance", "tabs"], value: "top" }]);
    expect(result).toEqual({
      ok: false,
      message: "Could not write config.jsonc: disk full",
      errors: [],
    });
    expect(backend.configContent).toBe(COMMENTED);
    expect(manager.state.config.appearance?.tabs).toBeUndefined();
    // And the next one works once the disk does.
    backend.setConfigSaveFailure(undefined);
    expect(await manager.update([{ path: ["appearance", "tabs"], value: "top" }])).toEqual({
      ok: true,
      written: true,
    });
  });

  it("reports a file that could not be read", async () => {
    const backend = new FakeBackend({ config: COMMENTED });
    const manager = new ConfigManager();
    await manager.start({
      watchConfig: (callback) => backend.watchConfig(callback),
      saveConfig: (text) => backend.saveConfig(text),
      loadConfig: () => Promise.reject(new Error("access denied")),
    });
    const result = await manager.update([{ path: ["appearance", "tabs"], value: "top" }]);
    expect(result).toEqual({
      ok: false,
      message: "Could not read config.jsonc: access denied",
      errors: [],
    });
    expect(backend.callsTo("saveConfig")).toHaveLength(0);
  });

  it("does nothing before the file is followed", async () => {
    const result = await new ConfigManager().update([
      { path: ["appearance", "tabs"], value: "top" },
    ]);
    expect(result).toEqual({ ok: false, message: "The settings are not available.", errors: [] });
  });

  it("lets two quick updates both land, each on the file the one before it wrote", async () => {
    const { backend, manager } = await started(COMMENTED);
    const first = manager.update([{ path: ["appearance", "density"], value: "compact" }]);
    const second = manager.update([{ path: ["appearance", "paneHeaders"], value: true }]);
    const third = manager.update([{ path: ["appearance", "density"], value: "comfortable" }]);
    expect(await Promise.all([first, second, third])).toEqual([
      { ok: true, written: true },
      { ok: true, written: true },
      { ok: true, written: true },
    ]);
    expect(manager.state.config.appearance).toEqual({
      sidebar: { position: "left" },
      density: "comfortable",
      paneHeaders: true,
    });
    expect(backend.configContent).toContain("// keep it here");
  });

  it("edits the file as it is on disk now, not as the manager last heard of it", async () => {
    const { backend, manager } = await started(COMMENTED);
    // Another program saved the file; its event has not reached the manager yet.
    manager.stop();
    await manager.start(backend);
    backend.setConfig(`${COMMENTED}// added by hand\n`);
    await manager.update([{ path: ["appearance", "tabs"], value: "top" }]);
    expect(backend.configContent).toContain("// added by hand");
    expect(backend.configContent).toContain('"tabs": "top"');
  });
});

describe("FakeBackend.saveConfig", () => {
  it("replaces the text, tells the watchers, and is recorded", async () => {
    const backend = new FakeBackend();
    const heard: (string | null)[] = [];
    backend.watchConfig((text) => heard.push(text));
    await backend.saveConfig("// saved\n{}");
    expect(backend.configContent).toBe("// saved\n{}");
    expect(heard).toEqual(["// saved\n{}"]);
    expect(backend.callsTo("saveConfig")[0]?.args).toEqual(["// saved\n{}"]);
  });
});
