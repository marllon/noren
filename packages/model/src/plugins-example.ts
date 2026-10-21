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
  "permissions": ["palette.actions", "tabs.create", "panel"]
}
`;

/** `main.js` of the example. */
export const EXAMPLE_PLUGIN_MAIN = `// Example plugin: puts two actions in the command palette; one opens a new tab, the other a panel.
//
// A plugin runs apart from the page (in a Worker, where globalThis is the scope that posts and
// hears messages) and has no power of its own. Everything it does is a message of protocol v1
// ({ version, id, method, params }), and the app answers each one only if plugin.json holds the
// permission the method needs: palette.register needs "palette.actions", tabs.create needs
// "tabs.create" and panel.open needs "panel".

let lastId = 0;
const ask = (method, params) =>
  globalThis.postMessage({ version: 1, id: ++lastId, method, params });

ask("palette.register", { id: "open-tab", label: "Open a new tab (example plugin)" });
ask("palette.register", { id: "open-panel", label: "Show the panel (sample)" });

// The app tells the plugin which action was chosen with a message { event: "action", id }, where id
// is the one given to palette.register. Every answer to a request comes the same way, as
// { version, id, result } or { version, id, error }, and is not an event.
globalThis.onmessage = (event) => {
  const message = event.data;
  if (!message || message.event !== "action") return;
  if (message.id === "open-tab") {
    ask("tabs.create", {});
  } else if (message.id === "open-panel") {
    // The panel is a title and the HTML text of its content. The app shows that text in a frame of
    // its own with no scripts, no forms, no windows and no access to the app, so it can draw (text,
    // lists, inline styles) and nothing else.
    ask("panel.open", {
      title: "Example panel",
      html: '<h3>Hello from the plugin</h3><p id="from-plugin">This panel is drawn from text the plugin sent.</p>',
    });
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
