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

describe("PaneBar name", () => {
  it("writes the name of the pane in bold before the folder, in both styles", () => {
    const info = { name: "Loop", folder: "~/site/api", cwd: "/home/ada/site/api" };
    for (const dense of [false, true]) {
      const html = bar(info, { dense });
      expect(html).toContain(
        '<b class="pane-bar-name" data-nr-part="pane-name" title="Loop">Loop</b>',
      );
      expect(html.indexOf("pane-bar-name")).toBeLessThan(
        html.indexOf('data-nr-part="pane-folder"'),
      );
    }
  });

  it("leaves it out for a pane that has no name", () => {
    expect(bar({ folder: "~/x" })).not.toContain("pane-bar-name");
    expect(bar({ folder: "~/x" }, { dense: true })).not.toContain("pane-bar-name");
  });

  it("shows the number of the pane before the name under the dense style", () => {
    const html = bar({ name: "Loop", folder: "~/x" }, { dense: true, number: 2 });
    expect(html.indexOf("pane-number")).toBeLessThan(html.indexOf("pane-bar-name"));
  });

  it("is a text field named for the pane while it is being renamed", () => {
    const renaming = { initial: "Loop", onCommit: nothing, onCancel: nothing };
    for (const dense of [false, true]) {
      const html = bar({ name: "Loop", folder: "~/x" }, { dense, renaming });
      expect(html).toContain('aria-label="Pane name"');
      expect(html).toContain('value="Loop"');
      expect(html).not.toContain("pane-bar-name");
    }
    setLanguage("pt-BR");
    expect(bar({ folder: "~/x" }, { renaming: { ...renaming, initial: "" } })).toContain(
      'aria-label="Nome do painel"',
    );
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

// The header of the dense style (NOR-F20-21a): the number of the pane, what runs, the folder, how it is,
// the badge and the buttons, with a close button for a tab of several panes.
describe("PaneBar under the dense style", () => {
  const dense = (info: PaneBarInfo, extra: Partial<Parameters<typeof PaneBar>[0]> = {}): string =>
    bar(info, { dense: true, number: 1, ...extra });

  it("is told apart from the glass header and has none of its parts", () => {
    const html = dense({ folder: "~/site/api", cwd: "/home/ada/site/api", branch: "main" });
    expect(html).toContain('data-nr-style="dense"');
    expect(html).not.toContain("pane-bar-chip");
    expect(html).not.toContain("pane-bar-head");
    expect(html).not.toContain("pane-branch");
    // The glass one is not told apart that way.
    expect(bar({ folder: "~/site/api" })).not.toContain('data-nr-style="dense"');
  });

  it("leads with the number of the pane, for the eyes, and writes the folder whole with the full path as the tooltip", () => {
    const html = dense({ folder: "~/site/api", cwd: "/home/ada/site/api" }, { number: 2 });
    expect(html).toContain(
      '<span class="pane-bar-num" data-nr-part="pane-number" aria-hidden="true">2</span>',
    );
    expect(html).toContain(
      '<span class="pane-bar-path" data-nr-part="pane-folder" title="/home/ada/site/api">~/site/api</span>',
    );
  });

  it("leaves the number out when the page gives none", () => {
    expect(bar({ folder: "~/x" }, { dense: true })).not.toContain("pane-number");
  });

  it("says Terminal while no command is known, and the command once the shell tells it, with the words for assistive technology", () => {
    expect(dense({ folder: "~/x" })).toContain('<span aria-hidden="true">Terminal</span>');
    const running = dense({ folder: "~/x", command: { state: "running", text: "pnpm dev" } });
    expect(running).toContain('data-nr-part="pane-command" data-nr-state="running"');
    expect(running).toContain('<span aria-hidden="true">pnpm dev</span>');
    expect(running).toContain('<span class="sr-only">Running pnpm dev</span>');
    const done = dense({
      folder: "~/x",
      command: { state: "done", text: "pnpm test", exitCode: 0, duration: "2.5s" },
    });
    expect(done).toContain('<span class="sr-only">Last command pnpm test, exit 0, 2.5s</span>');
  });

  it("shows the state only for a command that runs or that failed, with the code", () => {
    const running = dense({ folder: "~/x", command: { state: "running", text: "pnpm dev" } });
    expect(running).toContain(
      'data-nr-part="pane-state" data-nr-state="running" aria-hidden="true"',
    );
    expect(running).toContain("running</span>");
    const failed = dense({
      folder: "~/x",
      command: { state: "failed", text: "make", exitCode: 2 },
    });
    expect(failed).toContain('data-nr-state="failed"');
    expect(failed).toContain("exit 2</span>");
    expect(
      dense({ folder: "~/x", command: { state: "done", text: "ls", exitCode: 0 } }),
    ).not.toContain("pane-state");
    expect(dense({ folder: "~/x" })).not.toContain("pane-state");
  });

  it("says that an agent waits in the header, with a diamond, and in no other case", () => {
    expect(dense({ folder: "~/x" }, { waiting: true })).toContain(
      'data-nr-part="pane-agent-badge" aria-hidden="true">◆ Agent waiting for you<',
    );
    expect(dense({ folder: "~/x" })).not.toContain("pane-agent-badge");
  });

  it("has a close button only when the page gives a way to close the pane", () => {
    expect(dense({ folder: "~/x" })).not.toContain("pane-bar-close");
    const html = dense({ folder: "~/x" }, { onClose: nothing });
    expect(html).toContain('data-nr-part="pane-bar-close"');
    expect(html).toContain('aria-label="Close pane"');
  });

  it("has the buttons of the glass header, at 12 px", () => {
    const html = dense({ folder: "~/x" }, { zoomable: true, onClose: nothing });
    expect(html).toContain('data-nr-part="pane-bar-split-right"');
    expect(html).toContain('data-nr-part="pane-bar-split-down"');
    expect(html).toContain('data-nr-part="pane-bar-zoom"');
    expect(html).toContain('width="12" height="12"');
    expect(html).not.toContain('width="16"');
  });

  it("speaks Portuguese", () => {
    setLanguage("pt-BR");
    const html = dense(
      { folder: "~/x", command: { state: "running", text: "pnpm dev" } },
      { waiting: true, onClose: nothing },
    );
    expect(html).toContain("em execução</span>");
    expect(html).toContain("◆ Agente esperando você");
    expect(html).toContain('aria-label="Fechar painel"');
  });
});

describe("PaneBar program title", () => {
  it("writes the title the program set before the folder when the pane has no name", () => {
    const info = { title: "loop Noren", folder: "~/site/api", cwd: "/home/ada/site/api" };
    for (const dense of [false, true]) {
      const html = bar(info, { dense });
      expect(html).toContain(
        '<b class="pane-bar-program" data-nr-part="pane-program-title" title="loop Noren">loop Noren</b>',
      );
      expect(html.indexOf("pane-bar-program")).toBeLessThan(
        html.indexOf('data-nr-part="pane-folder"'),
      );
      expect(html).not.toContain("pane-bar-name");
    }
  });

  it("is left out of a header whose pane has no title", () => {
    expect(bar({ folder: "~/x" })).not.toContain("pane-bar-program");
    expect(bar({ folder: "~/x" }, { dense: true })).not.toContain("pane-bar-program");
  });

  it("gives way to the text field while the pane is being renamed", () => {
    const renaming = { initial: "", onCommit: nothing, onCancel: nothing };
    const html = bar({ title: "vim", folder: "~/x" }, { renaming });
    expect(html).toContain('aria-label="Pane name"');
    expect(html).not.toContain("pane-bar-program");
  });
});
