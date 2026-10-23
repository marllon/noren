import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEYBINDINGS } from "./keybindings";
import type { Keybindings } from "./keybindings";
import { setLanguage } from "./i18n";
import { PaneBar } from "./PaneBar";
import type { PaneBarInfo } from "./pane-info";

// The header of a glass pane, rendered to markup: what it says about the folder, the branch and the
// command (and what it leaves out), the badge of an agent that waits, the names of its buttons in both
// languages with the shortcut in their title, and which buttons it has. The look, the click and the
// keyboard are in e2e/glass-panes.spec.ts.

let keybindings: Keybindings = DEFAULT_KEYBINDINGS;
vi.mock("./keybindings-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./keybindings-store")>()),
  useKeybindings: () => keybindings,
}));

afterEach(() => {
  keybindings = DEFAULT_KEYBINDINGS;
  setLanguage("en");
});

const nothing = (): undefined => undefined;

function bar(info: PaneBarInfo, extra: Partial<Parameters<typeof PaneBar>[0]> = {}): string {
  return renderToStaticMarkup(
    <PaneBar
      info={info}
      waiting={false}
      zoomable={false}
      zoomed={false}
      canSplit={true}
      onSplit={nothing}
      onZoom={nothing}
      {...extra}
    />,
  );
}

describe("PaneBar folder", () => {
  it("writes the path muted and its last segment heavy, with the whole folder as the tooltip", () => {
    const html = bar({ folder: "~/site/api", cwd: "/home/ada/site/api" });
    expect(html).toContain('<span class="pane-bar-head">~/site/</span>');
    expect(html).toContain('<b class="pane-bar-tail">api</b>');
    expect(html).toContain('title="/home/ada/site/api"');
    expect(html).toContain('data-nr-part="pane-folder"');
  });

  it("is all tail for a folder with no segment to cut", () => {
    const html = bar({ folder: "~", cwd: "/home/ada" });
    expect(html).not.toContain("pane-bar-head");
    expect(html).toContain('<b class="pane-bar-tail">~</b>');
  });

  it("says Terminal while no folder is known, in the language of the interface", () => {
    expect(bar({ folder: "" })).toContain('<b class="pane-bar-tail">Terminal</b>');
    setLanguage("pt-BR");
    expect(bar({ folder: "" })).toContain('<b class="pane-bar-tail">Terminal</b>');
  });
});

describe("PaneBar branch", () => {
  it("shows the branch for the eyes and says it in words for assistive technology", () => {
    const html = bar({ folder: "~/x", branch: "feat/login" });
    expect(html).toContain('data-nr-part="pane-branch"');
    expect(html).toContain('<span class="pane-bar-chip-text" aria-hidden="true">feat/login</span>');
    expect(html).toContain('<span class="sr-only">Branch feat/login</span>');
  });

  it("is left out without a branch", () => {
    expect(bar({ folder: "~/x" })).not.toContain("pane-branch");
  });
});

describe("PaneBar command", () => {
  it("shows the command that runs, in words for assistive technology too", () => {
    const html = bar({ folder: "~/x", command: { state: "running", text: "pnpm dev" } });
    expect(html).toContain('data-nr-part="pane-command"');
    expect(html).toContain('data-nr-state="running"');
    expect(html).toContain('aria-hidden="true">pnpm dev</span>');
    expect(html).toContain('<span class="sr-only">Running pnpm dev</span>');
  });

  it("says a command is running when the shell did not tell its line", () => {
    const html = bar({ folder: "~/x", command: { state: "running" } });
    expect(html).toContain('aria-hidden="true">Running a command</span>');
  });

  it("shows the last command that ended, and a failure with its exit code", () => {
    const done = bar({
      folder: "~/x",
      command: { state: "done", text: "ls", exitCode: 0, duration: "1.0s" },
    });
    expect(done).toContain('data-nr-state="done"');
    expect(done).not.toContain("pane-bar-code");
    const failed = bar({
      folder: "~/x",
      command: { state: "failed", text: "make", exitCode: 2, duration: "3s" },
    });
    expect(failed).toContain('data-nr-state="failed"');
    expect(failed).toContain('<span class="pane-bar-code" aria-hidden="true">exit 2</span>');
    expect(failed).toContain("Last command make, exit 2, 3s");
  });

  it("has no chip for a command that ended and whose line is not known", () => {
    expect(bar({ folder: "~/x", command: { state: "done", exitCode: 0 } })).not.toContain(
      "pane-command",
    );
  });
});

describe("PaneBar agent badge", () => {
  it("shows the badge of an agent that waits, for the eyes (the status says it to assistive technology)", () => {
    const html = bar({ folder: "~/x" }, { waiting: true });
    expect(html).toContain('data-nr-part="pane-agent-badge"');
    expect(html).toContain("Agent waiting for you");
    expect(html).toMatch(/pane-bar-agent" data-nr-part="pane-agent-badge" aria-hidden="true"/);
  });

  it("is left out when nothing waits", () => {
    expect(bar({ folder: "~/x" })).not.toContain("pane-agent-badge");
  });

  it("speaks Portuguese", () => {
    setLanguage("pt-BR");
    expect(bar({ folder: "~/x" }, { waiting: true })).toContain("Agente esperando você");
  });
});

describe("PaneBar buttons", () => {
  it("has the two split buttons, named and titled with their shortcut", () => {
    const html = bar({ folder: "~/x" });
    expect(html).toContain('aria-label="Split right"');
    expect(html).toContain('title="Split right (Ctrl+Shift+D)"');
    expect(html).toContain('aria-keyshortcuts="Control+Shift+D"');
    expect(html).toContain('aria-label="Split down"');
    expect(html).toContain('title="Split down (Ctrl+Shift+E)"');
    expect(html).toContain('aria-keyshortcuts="Control+Shift+E"');
  });

  it("has no zoom button for a tab of one pane, and has one for a split tab", () => {
    expect(bar({ folder: "~/x" })).not.toContain("pane-bar-zoom");
    const html = bar({ folder: "~/x" }, { zoomable: true });
    expect(html).toContain('aria-label="Zoom pane"');
    expect(html).toContain('data-nr-part="pane-bar-zoom"');
  });

  it("turns the zoom button into the one that restores", () => {
    const html = bar({ folder: "~/x" }, { zoomable: true, zoomed: true });
    expect(html).toContain('aria-label="Restore pane"');
    expect(html).not.toContain('aria-label="Zoom pane"');
  });

  it("turns the split buttons off at the limit of panes", () => {
    const html = bar({ folder: "~/x" }, { canSplit: false });
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it("has no buttons at all where the page cannot split or zoom", () => {
    const html = renderToStaticMarkup(
      <PaneBar
        info={{ folder: "~/x" }}
        waiting={false}
        zoomable={false}
        zoomed={false}
        canSplit={true}
        onZoom={nothing}
      />,
    );
    expect(html).not.toContain("pane-bar-actions");
    expect(html).not.toContain("<button");
  });

  it("leaves a shortcut out of the title when the person took the key away", () => {
    keybindings = { preset: "safe", overrides: { "pane.split-right": null } };
    const html = bar({ folder: "~/x" });
    expect(html).toContain('title="Split right"');
    expect(html).not.toContain("Split right (");
  });

  it("speaks Portuguese", () => {
    setLanguage("pt-BR");
    const html = bar({ folder: "~/x" }, { zoomable: true });
    expect(html).toContain('aria-label="Dividir à direita"');
    expect(html).toContain('aria-label="Dividir abaixo"');
    expect(html).toContain('aria-label="Ampliar painel"');
  });
});
