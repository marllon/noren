import { describe, expect, it } from "vitest";
import { EXAMPLE_PLUGIN_MAIN, EXAMPLE_PLUGIN_MANIFEST, FakeBackend } from "@noren/model";
import type { ApiHost, PluginFolder } from "@noren/model";
import { PluginHost } from "./plugin-host";
import type { PluginTraffic, PluginWorker } from "./plugin-host";

// The host of the plugins with a stand-in for the Worker (NOR-F18-01c). jsdom has no real Worker,
// so this proves the wiring (what a Worker posts reaches the broker of that plugin, the answer goes
// back to it, an action chosen reaches it, one plugin failing leaves the others); that a real Worker
// runs under the policy is shown by the Playwright tests (e2e/plugins.spec.ts, e2e/csp.spec.ts).

class FakeWorker implements PluginWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { preventDefault?(): void; message?: string }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly received: unknown[] = [];
  terminated = false;
  failOnPost = false;

  constructor(readonly source: string) {}

  postMessage(message: unknown): void {
    if (this.failOnPost) throw new Error("the Worker is gone");
    this.received.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** The plugin posts a message to the app. */
  say(message: unknown): void {
    this.onmessage?.({ data: message });
  }
}

const manifestOf = (id: string, permissions: string[]): string =>
  JSON.stringify({
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    apiVersion: 1,
    main: "main.js",
    permissions,
  });

const folder = (id: string, permissions: string[], main = `// ${id}`): PluginFolder => ({
  folder: id,
  manifest: manifestOf(id, permissions),
  main,
});

const register = (id: number, action: string, label = action) => ({
  version: 1,
  id,
  method: "palette.register",
  params: { id: action, label },
});

/** An `ApiHost` that records that it was touched; `tabs.create` and `terminal.read` reach it. */
function touchedHost(): { host: ApiHost; touched: () => number } {
  let touched = 0;
  const boom = () => {
    touched += 1;
    throw new Error("the host was touched");
  };
  const host = {
    workspace: boom,
    dispatch: boom,
    attachSession: boom,
    readLines: boom,
    backend: new FakeBackend(),
  } as unknown as ApiHost;
  return { host, touched: () => touched };
}

function setup(folders: PluginFolder[]) {
  const workers = new Map<string, FakeWorker>();
  const traffic: PluginTraffic[] = [];
  const api = touchedHost();
  const backend = new FakeBackend();
  backend.setPlugins(folders);
  const host = new PluginHost({
    backend,
    apiHost: api.host,
    createWorker: (source, name) => {
      if (source.includes("// cannot start")) throw new Error("no Worker here");
      const worker = new FakeWorker(source);
      workers.set(name, worker);
      return worker;
    },
    observe: (entry) => traffic.push(entry),
  });
  return { host, workers, traffic, api };
}

const openPanel = (id: number, title: string, html: string) => ({
  version: 1,
  id,
  method: "panel.open",
  params: { title, html },
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const denied = (id: number, permission: string) =>
  expect.objectContaining({
    id,
    error: expect.objectContaining({ code: "permission_denied", permission }),
  });

describe("PluginHost", () => {
  it("starts one Worker per valid plugin with the text of its main file, and records the others", async () => {
    const { host, workers } = setup([
      folder("alpha", ["palette.actions"], "// alpha main"),
      { folder: "beta", manifest: "{ not json", main: "// beta" },
      { folder: "gamma", error: "plugin.json not found" },
      folder("delta", [], "// delta main"),
    ]);
    await host.start();
    expect([...workers.keys()]).toEqual(["alpha", "delta"]);
    expect(workers.get("alpha")?.source).toBe("// alpha main");
    expect(host.status()).toEqual([
      { folder: "beta", state: "invalid", reason: "plugin.json is not valid JSON" },
      { folder: "gamma", state: "invalid", reason: "plugin.json not found" },
      { folder: "alpha", state: "running", id: "alpha", name: "Plugin alpha" },
      { folder: "delta", state: "running", id: "delta", name: "Plugin delta" },
    ]);
  });

  it("starts once: a second start lists and runs nothing more", async () => {
    const { host, workers } = setup([folder("alpha", [])]);
    await host.start();
    const first = workers.get("alpha");
    await host.start();
    expect(workers.get("alpha")).toBe(first);
    expect(host.status()).toHaveLength(1);
  });

  it("hands what a Worker posts to the broker of that plugin and posts the answer back to it", async () => {
    const { host, workers, traffic } = setup([folder("alpha", ["palette.actions"])]);
    await host.start();
    const worker = workers.get("alpha");
    worker?.say(register(7, "go", "Go there"));
    await settle();
    expect(worker?.received).toEqual([{ version: 1, id: 7, result: { id: "go" } }]);
    expect(host.actions()).toEqual([
      { pluginId: "alpha", pluginName: "Plugin alpha", actionId: "go", label: "Go there" },
    ]);
    expect(traffic.map((entry) => entry.direction)).toEqual(["from-plugin", "to-plugin"]);
  });

  it("keeps the actions of two plugins apart, each under the name of its own plugin", async () => {
    const { host, workers } = setup([
      folder("alpha", ["palette.actions"]),
      folder("beta", ["palette.actions"]),
    ]);
    await host.start();
    for (const id of ["alpha", "beta"]) workers.get(id)?.say(register(1, "same", `From ${id}`));
    await settle();
    expect(host.actions().map((a) => [a.pluginId, a.actionId, a.label])).toEqual([
      ["alpha", "same", "From alpha"],
      ["beta", "same", "From beta"],
    ]);
  });

  it("answers permission_denied to a method the manifest does not hold, and never touches the app", async () => {
    const { host, workers, api } = setup([folder("alpha", ["palette.actions"])]);
    await host.start();
    const worker = workers.get("alpha");
    worker?.say({ version: 1, id: 1, method: "tabs.create", params: {} });
    worker?.say({ version: 1, id: 2, method: "terminal.read", params: {} });
    worker?.say({ version: 1, id: 3, method: "panel.open", params: { title: "x" } });
    await settle();
    expect(worker?.received).toEqual([
      denied(1, "tabs.create"),
      denied(2, "terminal.read"),
      denied(3, "panel"),
    ]);
    expect(api.touched()).toBe(0);
    expect(host.actions()).toEqual([]);
  });

  it("lets a method the manifest holds reach the app", async () => {
    const { host, workers, api } = setup([folder("alpha", ["tabs.create"])]);
    await host.start();
    workers.get("alpha")?.say({ version: 1, id: 1, method: "tabs.create", params: {} });
    await settle();
    expect(api.touched()).toBeGreaterThan(0);
    // The host broke on purpose: the plugin gets an error answer for its own id, not silence.
    expect(workers.get("alpha")?.received).toEqual([
      expect.objectContaining({ id: 1, error: expect.objectContaining({ code: "internal" }) }),
    ]);
  });

  it("tells a plugin which action was chosen, only an action it registered", async () => {
    const { host, workers } = setup([folder("alpha", ["palette.actions"])]);
    await host.start();
    const worker = workers.get("alpha");
    worker?.say(register(1, "go", "Go"));
    await settle();
    worker?.received.splice(0);
    host.choose("alpha", "go");
    host.choose("alpha", "never-registered");
    host.choose("nobody", "go");
    expect(worker?.received).toEqual([{ event: "action", id: "go" }]);
  });

  it("tells the subscribers when the actions change, and not when an answer changes nothing", async () => {
    const { host, workers } = setup([folder("alpha", ["palette.actions"])]);
    let heard = 0;
    host.subscribe(() => (heard += 1));
    await host.start();
    const afterStart = heard;
    const version = host.version();
    workers.get("alpha")?.say(register(1, "go", "Go"));
    await settle();
    expect(heard).toBe(afterStart + 1);
    expect(host.version()).toBe(version + 1);
    workers.get("alpha")?.say(register(2, "go", "Go"));
    await settle();
    expect(host.version()).toBe(version + 1);
  });

  it("isolates a Worker that fails: it is recorded, its actions leave, the others go on", async () => {
    const { host, workers } = setup([
      folder("alpha", ["palette.actions"]),
      folder("beta", ["palette.actions"]),
      folder("gamma", [], "// cannot start"),
    ]);
    await host.start();
    expect(host.status().find((s) => s.folder === "gamma")).toMatchObject({
      state: "failed",
      reason: "no Worker here",
    });
    for (const id of ["alpha", "beta"]) workers.get(id)?.say(register(1, "go", id));
    await settle();
    expect(host.actions()).toHaveLength(2);

    let prevented = false;
    workers.get("alpha")?.onerror?.({
      message: "Uncaught Error: boom",
      preventDefault: () => (prevented = true),
    });
    expect(prevented).toBe(true);
    expect(workers.get("alpha")?.terminated).toBe(true);
    expect(host.status().find((s) => s.folder === "alpha")).toMatchObject({
      state: "failed",
      reason: "Uncaught Error: boom",
    });
    expect(host.actions().map((a) => a.pluginId)).toEqual(["beta"]);

    // The one that is left still talks to its broker and hears the actions chosen.
    workers.get("beta")?.say(register(2, "two", "Two"));
    await settle();
    expect(host.actions().map((a) => a.actionId)).toEqual(["go", "two"]);
    host.choose("beta", "two");
    expect(workers.get("beta")?.received.at(-1)).toEqual({ event: "action", id: "two" });
  });

  it("fails a plugin whose Worker cannot be posted to, without throwing", async () => {
    const { host, workers } = setup([folder("alpha", ["palette.actions"])]);
    await host.start();
    const worker = workers.get("alpha");
    worker?.say(register(1, "go", "Go"));
    await settle();
    if (worker) worker.failOnPost = true;
    expect(() => host.choose("alpha", "go")).not.toThrow();
    expect(host.status()[0]).toMatchObject({ state: "failed", reason: "the Worker is gone" });
    expect(host.actions()).toEqual([]);
  });

  it("ignores what a Worker says after it failed", async () => {
    const { host, workers } = setup([folder("alpha", ["palette.actions"])]);
    await host.start();
    const worker = workers.get("alpha");
    const late = worker?.onmessage;
    worker?.onerror?.({ message: "boom" });
    late?.({ data: register(1, "go", "Go") });
    await settle();
    expect(host.actions()).toEqual([]);
    expect(worker?.received).toEqual([]);
  });

  it("answers an unreadable folder list with no plugins and no throw", async () => {
    const backend = new FakeBackend();
    backend.setPluginsListFailure(new Error("cannot read"));
    const host = new PluginHost({ backend, apiHost: touchedHost().host });
    await expect(host.start()).resolves.toBeUndefined();
    expect(host.status()).toEqual([]);
  });

  it("runs the example plugin from the text FakeBackend lists", async () => {
    const { host, workers } = setup([
      { folder: "new-tab-action", manifest: EXAMPLE_PLUGIN_MANIFEST, main: EXAMPLE_PLUGIN_MAIN },
    ]);
    await host.start();
    expect(host.status()[0]).toMatchObject({ state: "running", id: "new-tab-action" });
    expect(workers.get("new-tab-action")?.source).toBe(EXAMPLE_PLUGIN_MAIN);
  });

  it("shows the panel a plugin with the permission opened, and closes it when asked", async () => {
    const { host, workers } = setup([folder("alpha", ["panel"])]);
    let heard = 0;
    host.subscribe(() => (heard += 1));
    await host.start();
    expect(host.panel()).toBeNull();
    const before = host.version();
    workers.get("alpha")?.say(openPanel(1, "Notes", "<p>hi</p>"));
    await settle();
    expect(host.panel()).toEqual({
      pluginId: "alpha",
      pluginName: "Plugin alpha",
      title: "Notes",
      html: "<p>hi</p>",
    });
    expect(host.version()).toBe(before + 1);
    expect(workers.get("alpha")?.received).toEqual([
      { version: 1, id: 1, result: { title: "Notes" } },
    ]);

    // A later panel replaces it; the same one again changes nothing.
    workers.get("alpha")?.say(openPanel(2, "Other", ""));
    await settle();
    expect(host.panel()?.title).toBe("Other");
    const version = host.version();
    workers.get("alpha")?.say(openPanel(3, "Other", ""));
    await settle();
    expect(host.version()).toBe(version);

    host.closePanel();
    expect(host.panel()).toBeNull();
    expect(host.version()).toBe(version + 1);
    // Closing again is nothing, and the plugin can open another panel.
    host.closePanel();
    expect(host.version()).toBe(version + 1);
    workers.get("alpha")?.say(openPanel(4, "Back", "<p>back</p>"));
    await settle();
    expect(host.panel()?.title).toBe("Back");
    expect(heard).toBeGreaterThan(0);
  });

  it("shows no panel for a plugin without the permission panel, which is told permission_denied", async () => {
    const { host, workers, api } = setup([
      folder("alpha", ["palette.actions", "tabs.create", "terminal.read"]),
    ]);
    await host.start();
    workers.get("alpha")?.say(openPanel(1, "Sneaky", "<p>x</p>"));
    await settle();
    expect(workers.get("alpha")?.received).toEqual([denied(1, "panel")]);
    expect(host.panel()).toBeNull();
    expect(api.touched()).toBe(0);
  });

  it("shows no panel for a request the broker refused, and keeps the one on screen", async () => {
    const { host, workers } = setup([folder("alpha", ["panel"])]);
    await host.start();
    workers.get("alpha")?.say(openPanel(1, "Keep", "<p>keep</p>"));
    workers.get("alpha")?.say({ version: 1, id: 2, method: "panel.open", params: { title: "" } });
    workers.get("alpha")?.say(openPanel(3, "Big", "x".repeat(20_001)));
    await settle();
    expect(host.panel()).toMatchObject({ title: "Keep", html: "<p>keep</p>" });
    expect(workers.get("alpha")?.received.slice(1)).toEqual([
      expect.objectContaining({
        id: 2,
        error: expect.objectContaining({ code: "invalid_params" }),
      }),
      expect.objectContaining({
        id: 3,
        error: expect.objectContaining({ code: "invalid_params" }),
      }),
    ]);
  });

  it("takes the panel away when its plugin fails or stops, and leaves the panel of nobody else", async () => {
    const { host, workers } = setup([folder("alpha", ["panel"]), folder("beta", ["panel"])]);
    await host.start();
    workers.get("alpha")?.say(openPanel(1, "Alpha", "<p>a</p>"));
    await settle();
    // beta fails: alpha's panel stays.
    workers.get("beta")?.onerror?.({ message: "boom" });
    expect(host.panel()?.pluginId).toBe("alpha");
    // alpha fails: its panel goes, no error is thrown, the status says why.
    workers.get("alpha")?.onerror?.({ message: "alpha broke" });
    expect(host.panel()).toBeNull();
    expect(host.status().find((s) => s.folder === "alpha")).toMatchObject({ state: "failed" });
  });

  it("takes the panel away on stop", async () => {
    const { host, workers } = setup([folder("alpha", ["panel"])]);
    await host.start();
    workers.get("alpha")?.say(openPanel(1, "Alpha", "<p>a</p>"));
    await settle();
    host.stop();
    expect(host.panel()).toBeNull();
  });

  it("ends every Worker on stop", async () => {
    const { host, workers } = setup([folder("alpha", []), folder("beta", [])]);
    await host.start();
    host.stop();
    expect([...workers.values()].map((w) => w.terminated)).toEqual([true, true]);
    expect(host.actions()).toEqual([]);
  });
});
