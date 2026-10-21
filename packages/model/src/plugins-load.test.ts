import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";
import { EXAMPLE_PLUGIN_FOLDER, EXAMPLE_PLUGIN_MANIFEST, FAKE_PLUGINS } from "./plugins-example";
import { checkPluginFolders } from "./plugins-load";
import type { PluginFolder } from "./plugins-load";

// The loading of plugins without a disk (NOR-F18-01b): `checkPluginFolders` over what
// `Backend.listPlugins` answers, and `FakeBackend.listPlugins` itself. The Rust side that reads the
// folder is tested in crates/noren-core/src/plugins.rs.

const manifestText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "hello",
    name: "Hello",
    version: "1.0.0",
    apiVersion: 1,
    main: "main.js",
    permissions: ["tabs.create"],
    ...over,
  });

const folderOf = (folder: string, manifest: string, main = "// code"): PluginFolder => ({
  folder,
  manifest,
  main,
});

describe("checkPluginFolders", () => {
  it("accepts a plugin whose manifest is valid and whose id is the name of its folder", () => {
    const { valid, invalid } = checkPluginFolders([folderOf("hello", manifestText(), "// hi")]);
    expect(invalid).toEqual([]);
    expect(valid).toEqual([
      {
        folder: "hello",
        manifest: JSON.parse(manifestText()),
        main: "// hi",
      },
    ]);
  });

  it("rejects an id that is not the name of the folder, and says both", () => {
    const { valid, invalid } = checkPluginFolders([folderOf("other", manifestText())]);
    expect(valid).toEqual([]);
    expect(invalid).toEqual([
      { folder: "other", reason: 'id "hello" must be the name of the folder, "other"' },
    ]);
  });

  it("rejects a manifest that does not fit, with the field in the reason", () => {
    const { valid, invalid } = checkPluginFolders([
      folderOf("hello", manifestText({ apiVersion: 2 })),
      folderOf("hello-2", manifestText({ id: "hello-2", permissions: ["root"] })),
      folderOf("hello-3", manifestText({ id: "hello-3", main: "../x.js" })),
      folderOf("hello-4", manifestText({ id: "hello-4", extra: true })),
      folderOf("hello-5", "[]"),
    ]);
    expect(valid).toEqual([]);
    expect(invalid.map((entry) => entry.folder)).toEqual([
      "hello",
      "hello-2",
      "hello-3",
      "hello-4",
      "hello-5",
    ]);
    expect(invalid[0]?.reason).toContain("apiVersion");
    expect(invalid[1]?.reason).toContain("permissions.0");
    expect(invalid[2]?.reason).toContain("main");
    expect(invalid[3]?.reason).toContain("extra");
  });

  it("rejects text that is not JSON", () => {
    const { invalid } = checkPluginFolders([folderOf("hello", "{ nope"), folderOf("empty", "")]);
    expect(invalid).toEqual([
      { folder: "hello", reason: "plugin.json is not valid JSON" },
      { folder: "empty", reason: "plugin.json is not valid JSON" },
    ]);
  });

  it("reads a manifest that starts with a byte order mark", () => {
    const { valid } = checkPluginFolders([
      folderOf("hello", `${String.fromCharCode(0xfeff)}${manifestText()}`),
    ]);
    expect(valid.map((plugin) => plugin.folder)).toEqual(["hello"]);
  });

  it("passes the sentence of a folder the backend could not read, and keeps the order", () => {
    const { valid, invalid } = checkPluginFolders([
      { folder: "a-broken", error: "plugin.json not found" },
      folderOf("hello", manifestText()),
      { folder: "z-broken", error: "main file is outside the plugin folder" },
      folderOf("hello-2", manifestText({ id: "hello-2" })),
    ]);
    expect(valid.map((plugin) => plugin.folder)).toEqual(["hello", "hello-2"]);
    expect(invalid).toEqual([
      { folder: "a-broken", reason: "plugin.json not found" },
      { folder: "z-broken", reason: "main file is outside the plugin folder" },
    ]);
  });

  it("answers nothing for no folders", () => {
    expect(checkPluginFolders([])).toEqual({ valid: [], invalid: [] });
  });
});

describe("FakeBackend.listPlugins", () => {
  it("lists the example plugin until told otherwise, and it checks out", async () => {
    const backend = new FakeBackend();
    const folders = await backend.listPlugins();
    expect(folders).toEqual(FAKE_PLUGINS);
    expect(folders.map((folder) => folder.folder)).toEqual([EXAMPLE_PLUGIN_FOLDER]);
    const { valid, invalid } = checkPluginFolders(folders);
    expect(invalid).toEqual([]);
    expect(valid[0]?.manifest.permissions).toEqual(["palette.actions", "tabs.create", "panel"]);
    expect(backend.calls.map((call) => call.method)).toEqual(["listPlugins"]);
  });

  it("lists what setPlugins says, and a copy each time", async () => {
    const backend = new FakeBackend();
    backend.setPlugins([folderOf("hello", manifestText()), { folder: "bad", error: "no" }]);
    const first = await backend.listPlugins();
    expect(first.map((folder) => folder.folder)).toEqual(["hello", "bad"]);
    const [head] = first;
    if (head === undefined) throw new Error("expected a folder");
    head.folder = "changed";
    expect((await backend.listPlugins())[0]?.folder).toBe("hello");
    backend.setPlugins([]);
    expect(await backend.listPlugins()).toEqual([]);
  });

  it("rejects when told the folder cannot be read, and stops when told to", async () => {
    const backend = new FakeBackend();
    backend.setPluginsListFailure(new Error("could not read the plugins folder"));
    await expect(backend.listPlugins()).rejects.toThrow("could not read the plugins folder");
    backend.setPluginsListFailure(undefined);
    expect(await backend.listPlugins()).toHaveLength(1);
  });

  it("keeps the id of the example manifest equal to the folder of the example", () => {
    expect(JSON.parse(EXAMPLE_PLUGIN_MANIFEST).id).toBe(EXAMPLE_PLUGIN_FOLDER);
  });
});
