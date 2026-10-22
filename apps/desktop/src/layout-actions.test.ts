import { describe, expect, it } from "vitest";
import { ConfigManager, FakeBackend, parseConfigText } from "@noren/model";
import type { Config } from "@noren/model";
import { ACTIONS, DEFAULT_KEYBINDINGS, resolveBindings } from "./keybindings";
import type { ActionDef } from "./keybindings";
import { buildEntries } from "./palette";
import { shortcutRows } from "./shortcuts-screen";
import { layoutOf } from "./layout";
import {
  planLayoutCommand,
  planWidth,
  runLayoutCommand,
  widthInRange,
  type LayoutCommand,
} from "./layout-actions";

// The layout modes as actions: each flips only its own setting of `config.jsonc`, a width out of
// its range is refused, and a refusal, a file with a problem or a failed write comes back as the
// notice text. The file is the one a `FakeBackend` keeps in memory.

const layoutActions = ACTIONS.filter((action) => action.category === "Layout");
const byId = (id: string): ActionDef => {
  const found = ACTIONS.find((action) => action.id === id);
  if (!found) throw new Error(`no action ${id}`);
  return found;
};
const commandOf = (id: string): LayoutCommand => {
  const { command } = byId(id);
  if (command.kind !== "layout" && command.kind !== "layout-width") throw new Error("not layout");
  return command;
};

const COMMENTED = `// My settings, keep this line.
{
  "appearance": {
    "sidebar": { "position": "left", "width": 240 }, // mine
    "density": "comfortable",
  },
  // Quiet.
  "notifications": { "enabled": true },
}
`;

async function started(text: string | null) {
  const backend = new FakeBackend({ config: text });
  const manager = new ConfigManager();
  await manager.start(backend);
  return { backend, manager };
}

/** The whole settings tree of the text, to compare which keys moved. */
function settingsOfText(text: string | null): Config {
  const parsed = parseConfigText(text ?? "");
  if (!parsed.ok) throw new Error("the file has a problem");
  return parsed.config;
}

describe("the layout actions of the registry", () => {
  it("has every mode, none with a default chord", () => {
    expect(layoutActions.map((action) => action.id)).toEqual([
      "layout.sidebar-side",
      "layout.sidebar-widen",
      "layout.sidebar-narrow",
      "layout.density",
      "layout.compact-mode",
      "layout.keep-sidebar-open",
      "layout.top-tabs",
      "layout.favorites-bar",
      "layout.interface-style",
    ]);
    for (const action of layoutActions) {
      expect(action.chords).toEqual({ safe: undefined, browser: undefined });
    }
  });

  it("shows them in the palette as actions, and in the shortcuts screen as rows", () => {
    const entries = buildEntries({
      workspace: { spaces: [], activeSpaceId: "" },
      chords: resolveBindings(DEFAULT_KEYBINDINGS).chords,
    });
    const titles = entries.filter((entry) => entry.kind === "action").map((entry) => entry.title);
    for (const action of layoutActions) expect(titles).toContain(action.title);
    const rows = shortcutRows(DEFAULT_KEYBINDINGS);
    for (const action of layoutActions) {
      expect(rows.find((row) => row.id === action.id)).toMatchObject({
        category: "Layout",
        chord: undefined,
      });
    }
  });
});

describe("planLayoutCommand", () => {
  it("flips the side, the density and the tabs, each at the place of its own setting", () => {
    expect(planLayoutCommand({}, commandOf("layout.sidebar-side"))).toEqual({
      changes: [{ path: ["appearance", "sidebar", "position"], value: "right" }],
    });
    expect(
      planLayoutCommand(
        { appearance: { sidebar: { position: "right" } } },
        commandOf("layout.sidebar-side"),
      ),
    ).toEqual({ changes: [{ path: ["appearance", "sidebar", "position"], value: "left" }] });
    expect(planLayoutCommand({}, commandOf("layout.density"))).toEqual({
      changes: [{ path: ["appearance", "density"], value: "compact" }],
    });
    expect(
      planLayoutCommand({ appearance: { density: "compact" } }, commandOf("layout.density")),
    ).toEqual({ changes: [{ path: ["appearance", "density"], value: "comfortable" }] });
    expect(planLayoutCommand({}, commandOf("layout.top-tabs"))).toEqual({
      changes: [{ path: ["appearance", "tabs"], value: "top" }],
    });
    expect(
      planLayoutCommand({ appearance: { tabs: "top" } }, commandOf("layout.top-tabs")),
    ).toEqual({ changes: [{ path: ["appearance", "tabs"], value: "sidebar" }] });
  });

  it("flips the interface style between glass and dense, and only that setting", () => {
    expect(planLayoutCommand({}, commandOf("layout.interface-style"))).toEqual({
      changes: [{ path: ["appearance", "style"], value: "dense" }],
    });
    expect(
      planLayoutCommand({ appearance: { style: "dense" } }, commandOf("layout.interface-style")),
    ).toEqual({ changes: [{ path: ["appearance", "style"], value: "glass" }] });
    // Nothing the tabs or compact mode do stops it: the style has no place in the layout.
    for (const appearance of [
      { tabs: "top" as const },
      { sidebar: { compact: true } },
      { favorites: "top" as const },
    ]) {
      expect(planLayoutCommand({ appearance }, commandOf("layout.interface-style"))).toEqual({
        changes: [{ path: ["appearance", "style"], value: "dense" }],
      });
    }
  });

  it("flips the favorites bar between the sidebar and the top of the window, and only that setting", () => {
    expect(planLayoutCommand({}, commandOf("layout.favorites-bar"))).toEqual({
      changes: [{ path: ["appearance", "favorites"], value: "top" }],
    });
    expect(
      planLayoutCommand({ appearance: { favorites: "top" } }, commandOf("layout.favorites-bar")),
    ).toEqual({ changes: [{ path: ["appearance", "favorites"], value: "sidebar" }] });
    // Top tabs and compact mode do not stop it: the bar on top is a bar of its own.
    for (const appearance of [
      { tabs: "top" as const },
      { sidebar: { compact: true } },
      { tabs: "top" as const, sidebar: { compact: true } },
    ]) {
      expect(planLayoutCommand({ appearance }, commandOf("layout.favorites-bar"))).toEqual({
        changes: [{ path: ["appearance", "favorites"], value: "top" }],
      });
    }
  });

  it("flips compact mode, and keeping the sidebar open only while compact mode is on", () => {
    expect(planLayoutCommand({}, commandOf("layout.compact-mode"))).toEqual({
      changes: [{ path: ["appearance", "sidebar", "compact"], value: true }],
    });
    expect(
      planLayoutCommand(
        { appearance: { sidebar: { compact: true } } },
        commandOf("layout.compact-mode"),
      ),
    ).toEqual({ changes: [{ path: ["appearance", "sidebar", "compact"], value: false }] });
    expect(planLayoutCommand({}, commandOf("layout.keep-sidebar-open"))).toEqual({
      refusal: expect.stringContaining("compact mode"),
    });
    expect(
      planLayoutCommand(
        { appearance: { sidebar: { compact: true } } },
        commandOf("layout.keep-sidebar-open"),
      ),
    ).toEqual({ changes: [{ path: ["appearance", "sidebar", "keepOpen"], value: true }] });
  });

  it("refuses compact mode and keeping open with top tabs, like the screen disables them", () => {
    const top: Config = { appearance: { tabs: "top", sidebar: { compact: true } } };
    expect(planLayoutCommand(top, commandOf("layout.compact-mode"))).toEqual({
      refusal: expect.stringContaining("top tabs"),
    });
    expect(planLayoutCommand(top, commandOf("layout.keep-sidebar-open"))).toEqual({
      refusal: expect.stringContaining("top tabs"),
    });
  });

  it("steps the width by 48 px and stops at the ends of 180 to 480", () => {
    const widen = commandOf("layout.sidebar-widen");
    const narrow = commandOf("layout.sidebar-narrow");
    const at = (width: number): Config => ({ appearance: { sidebar: { width } } });
    expect(planLayoutCommand({}, widen)).toEqual({
      changes: [{ path: ["appearance", "sidebar", "width"], value: 248 }],
    });
    expect(planLayoutCommand(at(300), narrow)).toEqual({
      changes: [{ path: ["appearance", "sidebar", "width"], value: 252 }],
    });
    expect(planLayoutCommand(at(450), widen)).toEqual({
      changes: [{ path: ["appearance", "sidebar", "width"], value: 480 }],
    });
    expect(planLayoutCommand(at(200), narrow)).toEqual({
      changes: [{ path: ["appearance", "sidebar", "width"], value: 180 }],
    });
    expect(planLayoutCommand(at(480), widen)).toEqual({ refusal: expect.stringContaining("480") });
    expect(planLayoutCommand(at(180), narrow)).toEqual({ refusal: expect.stringContaining("180") });
  });

  it("refuses a width out of the range instead of bringing it into it", () => {
    for (const bad of [179, 481, 0, -200, 200.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(widthInRange(bad)).toBe(false);
      expect(planWidth(bad)).toEqual({ refusal: expect.stringContaining("180 to 480") });
    }
    for (const good of [180, 200, 333, 480]) {
      expect(planWidth(good)).toEqual({
        changes: [{ path: ["appearance", "sidebar", "width"], value: good }],
      });
    }
  });
});

describe("runLayoutCommand", () => {
  it("each action changes only its own key of the file and keeps the comments", async () => {
    const ids: readonly [string, (config: Config) => unknown][] = [
      ["layout.sidebar-side", (c) => c.appearance?.sidebar?.position],
      ["layout.sidebar-widen", (c) => c.appearance?.sidebar?.width],
      ["layout.sidebar-narrow", (c) => c.appearance?.sidebar?.width],
      ["layout.density", (c) => c.appearance?.density],
      ["layout.compact-mode", (c) => c.appearance?.sidebar?.compact],
      ["layout.top-tabs", (c) => c.appearance?.tabs],
      ["layout.favorites-bar", (c) => c.appearance?.favorites],
      ["layout.interface-style", (c) => c.appearance?.style],
    ];
    for (const [id, pick] of ids) {
      const { backend, manager } = await started(COMMENTED);
      const before = settingsOfText(backend.configContent);
      expect(await runLayoutCommand(manager, commandOf(id))).toBeUndefined();
      const text = backend.configContent ?? "";
      expect(text).toContain("// My settings, keep this line.");
      expect(text).toContain("// mine");
      expect(text).toContain("// Quiet.");
      const after = settingsOfText(text);
      expect(pick(after)).not.toEqual(pick(before));
      // Take the one setting away from both and the rest is the same.
      const strip = (config: Config): unknown =>
        JSON.parse(
          JSON.stringify(config, (key, value: unknown) =>
            key === "position" ||
            key === "width" ||
            key === "density" ||
            key === "compact" ||
            key === "tabs" ||
            key === "favorites" ||
            key === "style"
              ? undefined
              : value,
          ),
        );
      expect(strip(after)).toEqual(strip(before));
      // The interface follows the file.
      expect(layoutOf(manager.state.config)).toEqual(layoutOf(after));
    }
  });

  it("flips back and forth", async () => {
    const { manager } = await started(null);
    const flip = commandOf("layout.top-tabs");
    await runLayoutCommand(manager, flip);
    expect(layoutOf(manager.state.config).tabs).toBe("top");
    await runLayoutCommand(manager, flip);
    expect(layoutOf(manager.state.config).tabs).toBe("sidebar");
  });

  it("flips the favorites bar back and forth through the file, leaving the tabs alone", async () => {
    const { manager } = await started(null);
    const flip = commandOf("layout.favorites-bar");
    expect(await runLayoutCommand(manager, flip)).toBeUndefined();
    expect(layoutOf(manager.state.config)).toMatchObject({ favorites: "top", tabs: "sidebar" });
    expect(await runLayoutCommand(manager, flip)).toBeUndefined();
    expect(layoutOf(manager.state.config)).toMatchObject({ favorites: "sidebar", tabs: "sidebar" });
  });

  it("flips the interface style back and forth through the file, leaving the rest alone", async () => {
    const { manager } = await started(null);
    const flip = commandOf("layout.interface-style");
    expect(await runLayoutCommand(manager, flip)).toBeUndefined();
    expect(layoutOf(manager.state.config)).toMatchObject({ style: "dense", tabs: "sidebar" });
    expect(await runLayoutCommand(manager, flip)).toBeUndefined();
    expect(layoutOf(manager.state.config)).toMatchObject({ style: "glass", tabs: "sidebar" });
  });

  it("creates the file when there is none", async () => {
    const { backend, manager } = await started(null);
    expect(await runLayoutCommand(manager, commandOf("layout.density"))).toBeUndefined();
    expect(settingsOfText(backend.configContent)).toEqual({ appearance: { density: "compact" } });
  });

  it("answers a refusal as a notice and writes nothing", async () => {
    const { backend, manager } = await started(COMMENTED);
    const notice = await runLayoutCommand(manager, commandOf("layout.keep-sidebar-open"));
    expect(notice).toContain("compact mode");
    expect(backend.callsTo("saveConfig")).toHaveLength(0);
    expect(backend.configContent).toBe(COMMENTED);
  });

  it("answers a failed write as a notice, and the settings in force stay", async () => {
    const { backend, manager } = await started(COMMENTED);
    backend.setConfigSaveFailure(new Error("disk full"));
    const notice = await runLayoutCommand(manager, commandOf("layout.sidebar-side"));
    expect(notice).toContain("Could not write config.jsonc");
    expect(notice).toContain("disk full");
    expect(backend.configContent).toBe(COMMENTED);
    expect(layoutOf(manager.state.config).side).toBe("left");
  });

  it("answers a file with a problem as a notice and does not edit it", async () => {
    const broken = '{ "appearance": { "density": "huge" } }';
    const { backend, manager } = await started(broken);
    const notice = await runLayoutCommand(manager, commandOf("layout.sidebar-side"));
    expect(notice).toContain("The settings file has a problem");
    expect(backend.callsTo("saveConfig")).toHaveLength(0);
    expect(backend.configContent).toBe(broken);
  });

  it("answers with a notice when the settings are not available yet", async () => {
    const notice = await runLayoutCommand(new ConfigManager(), commandOf("layout.sidebar-side"));
    expect(notice).toBe("The settings are not available.");
  });
});
