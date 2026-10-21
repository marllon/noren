// Example plugin: puts two actions in the command palette; one opens a new tab, the other a panel.
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
