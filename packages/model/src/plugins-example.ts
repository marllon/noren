import type { PluginFolder } from "./plugins-load";

// The example plugin of `examples/plugins/new-tab-action/`, as text. `FakeBackend` lists it as the
// only plugin of the user, so a test has one that works without a disk; a test of the app holds
// these strings to the files (`plugins-example.test.ts`), so the two cannot drift apart.

/** The folder, and so the id, of the example plugin. */
export const EXAMPLE_PLUGIN_FOLDER = "new-tab-action";

/** `plugin.json` of the example. */
export const EXAMPLE_PLUGIN_MANIFEST = `{
  "id": "new-tab-action",
  "name": "New tab action",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "main.js",
  "permissions": ["palette.actions", "tabs.create"]
}
`;

/** `main.js` of the example. */
export const EXAMPLE_PLUGIN_MAIN = `// Example plugin: puts one action in the command palette; choosing it opens a new tab.
//
// A plugin runs apart from the page (in a Worker, where globalThis is the scope that posts and
// hears messages) and has no power of its own. Everything it does is a message of protocol v1
// ({ version, id, method, params }), and the app answers each one only if plugin.json holds the
// permission the method needs: palette.register needs "palette.actions" and tabs.create needs
// "tabs.create".

let lastId = 0;
const ask = (method, params) =>
  globalThis.postMessage({ version: 1, id: ++lastId, method, params });

ask("palette.register", { id: "open-tab", label: "Open a new tab (example plugin)" });

// The app tells the plugin which action was chosen with a message { event: "action", id }, where id
// is the one given to palette.register. Every answer to a request comes the same way, as
// { version, id, result } or { version, id, error }, and is not an event.
globalThis.onmessage = (event) => {
  const message = event.data;
  if (message && message.event === "action" && message.id === "open-tab") {
    ask("tabs.create", {});
  }
};
`;

/** What `FakeBackend.listPlugins` answers until `setPlugins` says otherwise. */
export const FAKE_PLUGINS: readonly PluginFolder[] = [
  {
    folder: EXAMPLE_PLUGIN_FOLDER,
    manifest: EXAMPLE_PLUGIN_MANIFEST,
    main: EXAMPLE_PLUGIN_MAIN,
  },
];
