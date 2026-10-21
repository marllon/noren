import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  EXAMPLE_PLUGIN_FOLDER,
  EXAMPLE_PLUGIN_MAIN,
  EXAMPLE_PLUGIN_MANIFEST,
  FakeBackend,
  checkPluginFolders,
  createPluginBroker,
  parsePluginManifest,
} from "@noren/model";
import type { ApiHost } from "@noren/model";

// The example plugin in examples/plugins/new-tab-action/ (NOR-F18-01b): its manifest is valid, its
// folder is its id, the text `FakeBackend` lists is what the files hold, and its main file speaks
// protocol v1 to a broker. (Running it in a Worker, and the action making a tab, is NOR-F18-01c.)

const root = new URL("../../../", import.meta.url);
const folder = new URL(`examples/plugins/${EXAMPLE_PLUGIN_FOLDER}/`, root);
const onDisk = (name: string): string =>
  readFileSync(new URL(name, folder), "utf8").replace(/\r\n/g, "\n");

describe("the example plugin in examples/plugins", () => {
  it("has a manifest that parses, with its folder as its id and the two permissions it uses", () => {
    const parsed = parsePluginManifest(JSON.parse(onDisk("plugin.json")));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.id).toBe(EXAMPLE_PLUGIN_FOLDER);
    expect(parsed.manifest.main).toBe("main.js");
    expect(parsed.manifest.permissions).toEqual(["palette.actions", "tabs.create"]);
  });

  it("is the plugin FakeBackend lists, file for file", async () => {
    expect(onDisk("plugin.json")).toBe(EXAMPLE_PLUGIN_MANIFEST);
    expect(onDisk("main.js")).toBe(EXAMPLE_PLUGIN_MAIN);
    const { valid, invalid } = checkPluginFolders(await new FakeBackend().listPlugins());
    expect(invalid).toEqual([]);
    expect(valid.map((plugin) => plugin.folder)).toEqual([EXAMPLE_PLUGIN_FOLDER]);
  });

  it("registers a palette action over protocol v1, which the broker takes, and asks for a tab when the action is chosen", async () => {
    const manifest = parsePluginManifest(JSON.parse(onDisk("plugin.json")));
    if (!manifest.ok) throw new Error("the manifest of the example is not valid");
    // The palette needs nothing from the host; the tab is only asked for, not made, here.
    const broker = createPluginBroker(manifest.manifest, {} as ApiHost);

    const sent: unknown[] = [];
    // The scope of a Worker, reduced to what the plugin uses: where it posts and where it hears.
    const scope: { postMessage(message: unknown): void; onmessage?: (event: unknown) => void } = {
      postMessage: (message) => sent.push(message),
    };
    runInNewContext(onDisk("main.js"), scope);
    expect(sent).toHaveLength(1);

    const answer = await broker.handle(sent[0]);
    expect("error" in answer).toBe(false);
    expect(broker.registry.actions()).toEqual([
      { id: "open-tab", label: "Open a new tab (example plugin)" },
    ]);

    scope.onmessage?.({ data: { event: "action", id: "other" } });
    expect(sent).toHaveLength(1);
    scope.onmessage?.({ data: { event: "action", id: "open-tab" } });
    expect(sent[1]).toEqual({ version: 1, id: 2, method: "tabs.create", params: {} });
  });

  it("is refused by a broker whose manifest does not hold palette.actions", async () => {
    const parsed = parsePluginManifest({
      ...JSON.parse(onDisk("plugin.json")),
      permissions: ["tabs.create"],
    });
    if (!parsed.ok) throw new Error("the manifest is not valid");
    const broker = createPluginBroker(parsed.manifest, {} as ApiHost);
    const sent: unknown[] = [];
    runInNewContext(onDisk("main.js"), { postMessage: (m: unknown) => sent.push(m) });
    const answer = await broker.handle(sent[0]);
    expect("error" in answer && answer.error.code).toBe("permission_denied");
    expect(broker.registry.actions()).toEqual([]);
  });
});
