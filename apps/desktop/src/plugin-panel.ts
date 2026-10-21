// The document of a plugin's panel (NOR-F18-01d): the HTML text a plugin gave `panel.open`, wrapped
// into a whole page that the frame of `PluginPanel` shows through `srcdoc`.
//
// The frame has `sandbox=""` (no `allow-same-origin`, no `allow-scripts`, no `allow-forms`, no
// `allow-popups`, no `allow-top-navigation`), so the page is of an opaque origin that the app
// cannot read and that cannot read the app, and it cannot run a script, send a form, open a window
// or move the app elsewhere. The policy below is a second lock, inside the page: nothing loads (no
// image, no font, no frame, no request) and only inline styles are allowed, so the text of a plugin
// can draw but not call out. A `srcdoc` page also inherits the policy of the app, which is the same
// or stricter. docs/SECURITY_REVIEW.md, section 1, tells why the policy of the app needed no new
// source for this.

/** The policy of the page inside the frame. */
export const PANEL_POLICY = "default-src 'none'; style-src 'unsafe-inline'";

/** The `sandbox` attribute of the frame: empty, which holds back everything the attribute can. */
export const PANEL_SANDBOX = "";

/** The page the frame shows: the content of the plugin inside a body, under the policy. */
export function panelDocument(html: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${PANEL_POLICY}">` +
    '<meta name="color-scheme" content="light dark">' +
    "<style>body{margin:10px;font:13px/1.45 system-ui,sans-serif}</style>" +
    `</head><body>${html}</body></html>`
  );
}
