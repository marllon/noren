import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEYBINDINGS } from "./keybindings";
import type { Keybindings } from "./keybindings";
import { setLanguage } from "./i18n";
import { Keycap, SidebarHead, SidebarSearch, SidebarSettings } from "./SidebarGlass";

// The head, the search and the settings button of the glass sidebar, rendered to markup: their names
// in both languages, which of the two texts the search shows, the keycap that follows the shortcut,
// and the button that is left out when it would mean nothing. The look, the click and the keyboard are
// in e2e/glass-sidebar.spec.ts.

let keybindings: Keybindings = DEFAULT_KEYBINDINGS;
vi.mock("./keybindings-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./keybindings-store")>()),
  useKeybindings: () => keybindings,
}));

afterEach(() => {
  keybindings = DEFAULT_KEYBINDINGS;
  setLanguage("en");
});

describe("SidebarHead", () => {
  it("has the brand and a button that folds the sidebar", () => {
    const html = renderToStaticMarkup(
      <SidebarHead compact={false} canToggle={true} onToggle={() => undefined} />,
    );
    expect(html).toContain("noren");
    expect(html).toContain('data-nr-part="sidebar-brand"');
    expect(html).toContain('aria-label="Collapse the sidebar"');
    // The mark is for the eyes.
    expect(html).toMatch(/class="sidebar-mark" aria-hidden="true"/);
  });

  it("keeps the sidebar open from the button once it is folded", () => {
    const html = renderToStaticMarkup(
      <SidebarHead compact={true} canToggle={true} onToggle={() => undefined} />,
    );
    expect(html).toContain('aria-label="Keep the sidebar open"');
    expect(html).not.toContain("Collapse the sidebar");
  });

  it("leaves the button out when the sidebar hides anyway (top tabs)", () => {
    const html = renderToStaticMarkup(
      <SidebarHead compact={false} canToggle={false} onToggle={() => undefined} />,
    );
    expect(html).toContain("noren");
    expect(html).not.toContain("sidebar-collapse");
  });

  it("speaks Portuguese", () => {
    setLanguage("pt-BR");
    expect(
      renderToStaticMarkup(
        <SidebarHead compact={false} canToggle={true} onToggle={() => undefined} />,
      ),
    ).toContain('aria-label="Recolher a barra lateral"');
    expect(
      renderToStaticMarkup(
        <SidebarHead compact={true} canToggle={true} onToggle={() => undefined} />,
      ),
    ).toContain('aria-label="Manter a barra lateral aberta"');
  });
});

describe("SidebarSearch", () => {
  it("shows the short word with a narrow sidebar and the sentence as its tooltip", () => {
    const html = renderToStaticMarkup(<SidebarSearch roomy={false} onOpen={() => undefined} />);
    expect(html).toContain('<span class="sidebar-search-text">Search</span>');
    expect(html).toContain('title="Search or run a command"');
  });

  it("shows the whole sentence with room", () => {
    const html = renderToStaticMarkup(<SidebarSearch roomy={true} onOpen={() => undefined} />);
    expect(html).toContain('<span class="sidebar-search-text">Search or run a command</span>');
  });

  it("carries the shortcut of the palette as a keycap and as aria-keyshortcuts", () => {
    const html = renderToStaticMarkup(<SidebarSearch roomy={false} onOpen={() => undefined} />);
    expect(html).toContain('aria-keyshortcuts="Control+Shift+P"');
    expect(html).toMatch(/<span class="keycap"[^>]*aria-hidden="true">Ctrl ⇧ P<\/span>/);
  });

  it("follows the shortcut the person set", () => {
    keybindings = { preset: "safe", overrides: { "palette.open": "Ctrl+Alt+KeyK" } };
    const html = renderToStaticMarkup(<SidebarSearch roomy={false} onOpen={() => undefined} />);
    expect(html).toContain("Ctrl Alt K");
    expect(html).toContain('aria-keyshortcuts="Control+Alt+K"');
  });

  it("has no keycap and no shortcut property when the person took the key away", () => {
    keybindings = { preset: "safe", overrides: { "palette.open": null } };
    const html = renderToStaticMarkup(<SidebarSearch roomy={false} onOpen={() => undefined} />);
    expect(html).not.toContain("keycap");
    expect(html).not.toContain("aria-keyshortcuts");
  });

  it("speaks Portuguese", () => {
    setLanguage("pt-BR");
    const html = renderToStaticMarkup(<SidebarSearch roomy={false} onOpen={() => undefined} />);
    expect(html).toContain(">Buscar</span>");
    expect(html).toContain('title="Buscar ou rodar comando"');
  });
});

describe("Keycap", () => {
  it("draws the chord an action has, for the eyes only", () => {
    expect(renderToStaticMarkup(<Keycap actionId="tab.new" />)).toBe(
      '<span class="keycap" data-nr-part="keycap" aria-hidden="true">Ctrl ⇧ T</span>',
    );
  });

  it("draws nothing for an action with no key", () => {
    expect(renderToStaticMarkup(<Keycap actionId="layout.compact-mode" />)).toBe("");
  });
});

describe("SidebarSettings", () => {
  it("is the settings button, named like the one of the title bar", () => {
    const html = renderToStaticMarkup(<SidebarSettings onOpen={() => undefined} />);
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('data-nr-part="sidebar-settings"');
    setLanguage("pt-BR");
    expect(renderToStaticMarkup(<SidebarSettings onOpen={() => undefined} />)).toContain(
      'aria-label="Configurações"',
    );
  });
});
