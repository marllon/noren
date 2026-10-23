import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRow } from "@noren/model";
import {
  BrandMark,
  SidebarAgents,
  SidebarSettingsRow,
  StatusBar,
  TitleCrumbs,
  TitlePalette,
} from "./DenseChrome";
import { DEFAULT_KEYBINDINGS } from "./keybindings";
import type { Keybindings } from "./keybindings";
import { setLanguage } from "./i18n";
import { resetWindowChrome, setPaletteOpener, setWindowCrumbs } from "./window-chrome";

// The parts of the dense window that the glass one does not have, rendered to markup: the brand, the
// breadcrumb and the button of the palette in the title bar, the settings row and the agents at the foot
// of the sidebar, and the status bar. What each says and leaves out, the names in both languages. The look
// and the click are in e2e/dense-window.spec.ts.

let keybindings: Keybindings = DEFAULT_KEYBINDINGS;
vi.mock("./keybindings-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./keybindings-store")>()),
  useKeybindings: () => keybindings,
}));

let agents: AgentRow[] = [];
vi.mock("./agent-state-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-state-store")>()),
  useAgentRows: () => agents,
}));

afterEach(() => {
  keybindings = DEFAULT_KEYBINDINGS;
  agents = [];
  resetWindowChrome();
  setLanguage("en");
});

function row(over: Partial<AgentRow>): AgentRow {
  return {
    paneId: "p1",
    itemId: "i1",
    spaceId: "s1",
    spaceName: "Site",
    spaceColor: "#2ee6d6",
    itemTitle: "claude",
    agentId: "claude",
    state: "waiting",
    since: 0,
    elapsedMs: 120_000,
    elapsed: "2m 00s",
    lastLine: "",
    ...over,
  };
}

const workspace = { spaces: [] };

describe("BrandMark", () => {
  it("is the prompt glyph, for the eyes only", () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('class="brand-mark"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('<path d="m5 8 4 4-4 4"></path>');
  });
});

describe("TitleCrumbs", () => {
  it("draws nothing until the shell says where the person is", () => {
    expect(renderToStaticMarkup(<TitleCrumbs />)).toBe("");
  });

  it("writes the space, the group and the tab, a slash before each but the first, and marks the last", () => {
    setWindowCrumbs({ space: "Site", group: "api", tab: "pnpm dev" });
    const html = renderToStaticMarkup(<TitleCrumbs />);
    expect(html).toContain('aria-label="Where you are"');
    expect(html).toContain('data-nr-crumb="space"');
    expect(html).toContain('data-nr-crumb="group"');
    expect(html).toContain('data-nr-crumb="tab" aria-current="location"');
    expect(html.match(/titlebar-sep/g)).toHaveLength(2);
    // The slashes are for the eyes: they are not read.
    expect(html).toContain('<span class="titlebar-sep" aria-hidden="true">/</span>');
    expect(html).toContain('title="pnpm dev"');
  });

  it("leaves the group out for a tab that is in none", () => {
    setWindowCrumbs({ space: "Site", tab: "git" });
    const html = renderToStaticMarkup(<TitleCrumbs />);
    expect(html).not.toContain('data-nr-crumb="group"');
    expect(html.match(/titlebar-sep/g)).toHaveLength(1);
  });

  it("names the nav in the language of the interface", () => {
    setLanguage("pt-BR");
    setWindowCrumbs({ space: "Site", tab: "git" });
    expect(renderToStaticMarkup(<TitleCrumbs />)).toContain('aria-label="Onde você está"');
  });
});

describe("TitlePalette", () => {
  it("is off until the shell hands over the way to open the palette, then on", () => {
    expect(renderToStaticMarkup(<TitlePalette />)).toContain("disabled");
    setPaletteOpener(() => undefined);
    expect(renderToStaticMarkup(<TitlePalette />)).not.toContain("disabled");
  });

  it("says its shortcut in the plain form of the dense style and for assistive technology", () => {
    setPaletteOpener(() => undefined);
    const html = renderToStaticMarkup(<TitlePalette />);
    expect(html).toContain("commands");
    expect(html).toContain(">ctrl+⇧+p<");
    expect(html).toContain('aria-keyshortcuts="Control+Shift+P"');
    expect(html).toContain('title="Search or run a command"');
  });

  it("follows the shortcut the person set, and says none when they took the key away", () => {
    setPaletteOpener(() => undefined);
    keybindings = { preset: "safe", overrides: { "palette.open": "Ctrl+Alt+KeyK" } };
    expect(renderToStaticMarkup(<TitlePalette />)).toContain(">ctrl+alt+k<");
    keybindings = { preset: "safe", overrides: { "palette.open": null } };
    const html = renderToStaticMarkup(<TitlePalette />);
    expect(html).not.toContain("titlebar-keys");
    expect(html).not.toContain("aria-keyshortcuts");
  });

  it("speaks Portuguese", () => {
    setLanguage("pt-BR");
    setPaletteOpener(() => undefined);
    expect(renderToStaticMarkup(<TitlePalette />)).toContain("comandos");
  });
});

describe("SidebarSettingsRow", () => {
  it("is one button named Settings, whose word is for the eyes, and has no shortcut to say", () => {
    const html = renderToStaticMarkup(<SidebarSettingsRow onOpen={() => undefined} />);
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('data-nr-part="sidebar-settings"');
    expect(html).toContain(
      '<span class="sidebar-settings-text" aria-hidden="true">settings</span>',
    );
    // `settings.open` has no key in the presets.
    expect(html).not.toContain("sidebar-settings-keys");
  });

  it("says the shortcut the person gave it", () => {
    keybindings = { preset: "safe", overrides: { "settings.open": "Ctrl+Comma" } };
    expect(renderToStaticMarkup(<SidebarSettingsRow onOpen={() => undefined} />)).toContain(
      ">ctrl+,<",
    );
  });

  it("speaks Portuguese", () => {
    setLanguage("pt-BR");
    const html = renderToStaticMarkup(<SidebarSettingsRow onOpen={() => undefined} />);
    expect(html).toContain('aria-label="Configurações"');
    expect(html).toContain(">configurações<");
  });
});

describe("SidebarAgents", () => {
  it("draws nothing while no agent runs", () => {
    expect(
      renderToStaticMarkup(<SidebarAgents workspace={workspace} onPick={() => undefined} />),
    ).toBe("");
  });

  it("lists each agent with its name, how it is and for how long, named by what the eyes read", () => {
    agents = [
      row({ paneId: "p1", state: "waiting" }),
      row({ paneId: "p2", agentId: "codex", state: "working", elapsed: "45s", itemTitle: "api" }),
      row({ paneId: "p3", agentId: "helper", state: "idle", elapsed: "3m 05s" }),
    ];
    const html = renderToStaticMarkup(
      <SidebarAgents workspace={workspace} onPick={() => undefined} />,
    );
    expect(html).toContain('aria-label="Agents"');
    expect(html.match(/data-nr-part="sidebar-agent"/g)).toHaveLength(3);
    // The name of the button begins with the words on it: "claude waiting 2m 00s".
    expect(html).toContain('aria-label="claude waiting 2m 00s, claude in Site. Go to it."');
    expect(html).toContain('aria-label="codex working 45s, api in Site. Go to it."');
    expect(html).toContain('aria-label="helper idle 3m 05s, claude in Site. Go to it."');
    expect(html).toContain('data-nr-agent-state="waiting"');
    expect(html).toContain('data-nr-agent-state="working"');
    // The parts are apart in the text a tool reads, though flex items draw no space.
    expect(html).toContain("claude</span> <span");
  });

  it("speaks Portuguese", () => {
    setLanguage("pt-BR");
    agents = [row({})];
    const html = renderToStaticMarkup(
      <SidebarAgents workspace={workspace} onPick={() => undefined} />,
    );
    expect(html).toContain('aria-label="claude esperando 2m 00s, claude em Site. Ir até ele."');
    expect(html).toContain('aria-label="Agentes"');
  });
});

describe("StatusBar", () => {
  const space = { name: "Site", color: "#2ee6d6" };

  it("leads with the space in its color and ends with the number of panes", () => {
    const html = renderToStaticMarkup(
      <StatusBar space={space} focused={undefined} panes={3} workspace={workspace} />,
    );
    expect(html).toContain('aria-label="Status bar"');
    expect(html).toContain("--nr-space-color:#2ee6d6");
    expect(html).toContain('<span class="status-space" data-nr-part="status-space">Site</span>');
    expect(html).toContain(">3 panes<");
    // Nothing the app does not know: no load, no clock, no version of a runtime.
    for (const word of ["CPU", "MEM", "node"]) expect(html).not.toContain(word);
  });

  it("says one pane in the singular", () => {
    const html = renderToStaticMarkup(
      <StatusBar space={space} focused={undefined} panes={1} workspace={workspace} />,
    );
    expect(html).toContain(">1 pane<");
  });

  it("says the folder and the branch of the pane in focus, with the folder in full as the tooltip", () => {
    const html = renderToStaticMarkup(
      <StatusBar
        space={space}
        focused={{ folder: "~/site/api", cwd: "/home/ada/site/api", branch: "feat/login" }}
        panes={2}
        workspace={workspace}
      />,
    );
    expect(html).toContain('data-nr-part="status-folder" title="/home/ada/site/api">~/site/api<');
    expect(html).toContain('data-nr-part="status-branch" title="Branch feat/login"');
    expect(html).toContain('<span class="status-text">feat/login</span>');
  });

  it("leaves the folder and the branch out for a pane that tells none", () => {
    const html = renderToStaticMarkup(
      <StatusBar space={space} focused={{ folder: "" }} panes={1} workspace={workspace} />,
    );
    expect(html).not.toContain("status-folder");
    expect(html).not.toContain("status-branch");
  });

  it("counts the agents that wait for the person, in the singular and the plural, and says nothing for none", () => {
    expect(
      renderToStaticMarkup(
        <StatusBar space={space} focused={undefined} panes={1} workspace={workspace} />,
      ),
    ).not.toContain("status-agents");
    agents = [row({ paneId: "p1" }), row({ paneId: "p2", state: "working" })];
    expect(
      renderToStaticMarkup(
        <StatusBar space={space} focused={undefined} panes={1} workspace={workspace} />,
      ),
    ).toContain("1 agent waiting");
    agents = [row({ paneId: "p1" }), row({ paneId: "p2" }), row({ paneId: "p3", state: "idle" })];
    expect(
      renderToStaticMarkup(
        <StatusBar space={space} focused={undefined} panes={1} workspace={workspace} />,
      ),
    ).toContain("2 agents waiting");
  });

  it("speaks Portuguese", () => {
    setLanguage("pt-BR");
    agents = [row({})];
    const html = renderToStaticMarkup(
      <StatusBar space={space} focused={undefined} panes={2} workspace={workspace} />,
    );
    expect(html).toContain('aria-label="Barra de status"');
    expect(html).toContain("1 agente esperando");
    expect(html).toContain(">2 painéis<");
  });
});
