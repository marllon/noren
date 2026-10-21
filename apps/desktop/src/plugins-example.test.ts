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
// protocol v1 to a broker. (Running it in a Worker, and the actions making a tab and opening the
// panel, is shown by e2e/plugins.spec.ts and e2e/plugin-panel.spec.ts.)

const root = new URL("../../../", import.meta.url);
const folder = new URL(`examples/plugins/${EXAMPLE_PLUGIN_FOLDER}/`, root);
const onDisk = (name: string): string =>
  readFileSync(new URL(name, folder), "utf8").replace(/\r\n/g, "\n");

describe("the example plugin in examples/plugins", () => {
  it("has a manifest that parses, with its folder as its id and the three permissions it uses", () => {
    const parsed = parsePluginManifest(JSON.parse(onDisk("plugin.json")));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.id).toBe(EXAMPLE_PLUGIN_FOLDER);
    expect(parsed.manifest.main).toBe("main.js");
    expect(parsed.manifest.permissions).toEqual(["palette.actions", "tabs.create", "panel"]);
  });

  it("is the plugin FakeBackend lists, file for file", async () => {
    expect(onDisk("plugin.json")).toBe(EXAMPLE_PLUGIN_MANIFEST);
    expect(onDisk("main.js")).toBe(EXAMPLE_PLUGIN_MAIN);
    const { valid, invalid } = checkPluginFolders(await new FakeBackend().listPlugins());
    expect(invalid).toEqual([]);
    expect(valid.map((plugin) => plugin.folder)).toEqual([EXAMPLE_PLUGIN_FOLDER]);
  });

  it("registers its palette actions over protocol v1, which the broker takes, and asks for a tab or a panel when one is chosen", async () => {
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
    expect(sent).toHaveLength(2);

    for (const request of sent) expect("error" in (await broker.handle(request))).toBe(false);
    expect(broker.registry.actions()).toEqual([
      { id: "open-tab", label: "Open a new tab (example plugin)" },
      { id: "open-panel", label: "Show the panel (sample)" },
    ]);

    scope.onmessage?.({ data: { event: "action", id: "other" } });
    expect(sent).toHaveLength(2);
    scope.onmessage?.({ data: { event: "action", id: "open-tab" } });
    expect(sent[2]).toEqual({ version: 1, id: 3, method: "tabs.create", params: {} });

    // The panel action asks for a panel with a title and a content; the broker keeps both.
    scope.onmessage?.({ data: { event: "action", id: "open-panel" } });
    expect(sent[3]).toMatchObject({ version: 1, id: 4, method: "panel.open" });
    expect("error" in (await broker.handle(sent[3]))).toBe(false);
    const panel = broker.registry.panel();
    expect(panel?.title).toBe("Example panel");
    expect(panel?.html).toContain("Hello from the plugin");
    expect(panel?.html).not.toContain("<script");
  });

  it("is refused the panel by a broker whose manifest does not hold panel", async () => {
    const parsed = parsePluginManifest({
      ...JSON.parse(onDisk("plugin.json")),
      permissions: ["palette.actions", "tabs.create"],
    });
    if (!parsed.ok) throw new Error("the manifest is not valid");
    const broker = createPluginBroker(parsed.manifest, {} as ApiHost);
    const sent: unknown[] = [];
    const scope: { postMessage(message: unknown): void; onmessage?: (event: unknown) => void } = {
      postMessage: (message) => sent.push(message),
    };
    runInNewContext(onDisk("main.js"), scope);
    scope.onmessage?.({ data: { event: "action", id: "open-panel" } });
    const answer = await broker.handle(sent.at(-1));
    expect("error" in answer && answer.error.code).toBe("permission_denied");
    expect("error" in answer && answer.error.permission).toBe("panel");
    expect(broker.registry.panel()).toBeNull();
  });

  it("is refused by a broker whose manifest does not hold palette.actions", async () => {
    const parsed = parsePluginManifest({
      ...JSON.parse(onDisk("plugin.json")),
      permissions: ["tabs.create", "panel"],
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
