// Example plugin: puts one action in the command palette; choosing it opens a new tab.
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

// The app tells the plugin which action was chosen. How that message is delivered is settled with
// the host that runs the plugin (NOR-F18-01c); this is the shape the example expects.
globalThis.onmessage = (event) => {
  const message = event.data;
  if (message && message.event === "action" && message.id === "open-tab") {
    ask("tabs.create", {});
  }
};
