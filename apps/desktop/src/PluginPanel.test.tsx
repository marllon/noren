import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginPanel } from "./PluginPanel";
import { setLanguage } from "./i18n";
import type { PluginPanelView } from "./plugin-host";
import { PANEL_POLICY, PANEL_SANDBOX, panelDocument } from "./plugin-panel";

// The panel of a plugin as markup (NOR-F18-01d): what the frame is given and what it is denied.
// jsdom does not run an iframe, so that the frame really has an opaque origin, that the page cannot
// read it and that the policy lets it draw is shown by e2e/plugin-panel.spec.ts in a real browser.

let shown: PluginPanelView | null = null;
vi.mock("./plugin-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-host")>()),
  usePluginPanel: () => shown,
}));

const view = (overrides: Partial<PluginPanelView> = {}): PluginPanelView => ({
  pluginId: "demo",
  pluginName: "Demo plugin",
  title: "Notes",
  html: "<p>hello</p>",
  ...overrides,
});

afterEach(() => {
  shown = null;
  setLanguage("en");
});

describe("the document of a panel", () => {
  it("wraps the content of the plugin as it came, after a policy that lets nothing load", () => {
    const html = '<h3>Hi</h3><p style="color: red">text</p><img src="https://example.com/x.png">';
    const page = panelDocument(html);
    expect(page).toContain(`<body>${html}</body>`);
    expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="${PANEL_POLICY}">`);
    // The policy comes before the content, so nothing the plugin wrote is parsed without it.
    expect(page.indexOf("Content-Security-Policy")).toBeLessThan(page.indexOf("<body>"));
  });

  it("has a policy with no script, no source and no way out", () => {
    expect(PANEL_POLICY).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(PANEL_POLICY).not.toMatch(/script-src|unsafe-eval|\*|https?:|data:|blob:/);
  });

  it("has a sandbox with no permission at all", () => {
    expect(PANEL_SANDBOX).toBe("");
  });
});

describe("PluginPanel", () => {
  it("draws nothing while no plugin has a panel open", () => {
    expect(renderToStaticMarkup(<PluginPanel />)).toBe("");
  });

  it("draws the title, the plugin and a frame with an empty sandbox that gets its page by srcdoc", () => {
    shown = view();
    const markup = renderToStaticMarkup(<PluginPanel />);
    expect(markup).toContain('data-nr-part="plugin-panel"');
    expect(markup).toContain("<h2>Notes</h2>");
    expect(markup).toContain("Plugin · Demo plugin");
    expect(markup).toContain('aria-label="Close plugin panel"');
    const frame = /<iframe[^>]*>/.exec(markup)?.[0] ?? "";
    expect(frame).toContain('sandbox=""');
    expect(frame).toContain("srcDoc=");
    expect(frame).not.toMatch(/\ssrc=/);
    expect(markup).not.toContain("allow-");
    // The page inside the frame is the content between the policy and the end of the body.
    expect(markup).toContain("&lt;p&gt;hello&lt;/p&gt;");
  });

  it("writes the text of the plugin into the attribute escaped, never as markup of the app", () => {
    shown = view({ title: "<b>Bold</b>", html: '"><script>alert(1)</script>' });
    const markup = renderToStaticMarkup(<PluginPanel />);
    expect(markup).toContain("<h2>&lt;b&gt;Bold&lt;/b&gt;</h2>");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("speaks Portuguese when the language is Portuguese", () => {
    setLanguage("pt-BR");
    shown = view();
    const markup = renderToStaticMarkup(<PluginPanel />);
    expect(markup).toContain('aria-label="Fechar o painel do plugin"');
    expect(markup).toContain("Painel do plugin: Notes");
  });
});
