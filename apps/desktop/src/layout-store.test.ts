import { beforeEach, describe, expect, it } from "vitest";
import { FakeBackend } from "@noren/model";
import { configManager } from "./config-store";
import { DEFAULT_LAYOUT } from "./layout";
import { getLayout, previewSidebarWidth, resetLayoutStore, saveSidebarWidth } from "./layout-store";

// The layout the interface shows is the settings file over the defaults, plus the width while the
// sidebar handle is dragged. The file is the one a `FakeBackend` keeps in memory.

const RIGHT = '{ "appearance": { "sidebar": { "position": "right" } } }';

async function started(config: string | null = null): Promise<FakeBackend> {
  const backend = new FakeBackend({ config });
  await configManager.start(backend);
  return backend;
}

beforeEach(() => {
  resetLayoutStore();
  configManager.stop();
  configManager.apply(null);
});

describe("layout store", () => {
  it("is the default layout with no file", () => {
    expect(getLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("is the file over the defaults, and follows the file", async () => {
    const backend = await started(RIGHT);
    expect(getLayout()).toEqual({ ...DEFAULT_LAYOUT, side: "right" });
    backend.setConfig('{ "appearance": { "sidebar": { "position": "left", "width": 260 } } }');
    expect(getLayout()).toEqual({ ...DEFAULT_LAYOUT, width: 260 });
    backend.setConfig(null);
    expect(getLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("keeps the layout when the file turns invalid", async () => {
    const backend = await started(RIGHT);
    const before = getLayout();
    backend.setConfig('{ "appearance": { "sidebar": { "position": "middle" } } }');
    expect(getLayout()).toBe(before);
  });

  it("moves every layout preference the file can set", async () => {
    await started(`{
      "appearance": {
        "sidebar": { "position": "right", "width": 333, "compact": true, "keepOpen": true },
        "density": "compact",
        "tabs": "top",
        "paneHeaders": true,
      },
    }`);
    expect(getLayout()).toEqual({
      side: "right",
      width: 333,
      compact: true,
      keepOpen: true,
      density: "compact",
      tabs: "top",
      paneHeaders: true,
    });
  });
});

describe("the width of the sidebar handle", () => {
  it("shows a preview without writing the file, and keeps it in range", async () => {
    const backend = await started(RIGHT);
    previewSidebarWidth(300);
    expect(getLayout().width).toBe(300);
    previewSidebarWidth(9999);
    expect(getLayout().width).toBe(480);
    previewSidebarWidth(1);
    expect(getLayout().width).toBe(180);
    expect(backend.callsTo("saveConfig")).toHaveLength(0);
    expect(backend.configContent).toBe(RIGHT);
  });

  it("writes the width into the file, keeping the rest of it, and the file is the source after", async () => {
    const backend = await started("// mine\n" + RIGHT + "\n");
    await saveSidebarWidth(310);
    expect(backend.configContent).toContain("// mine");
    expect(backend.configContent).toContain('"position": "right"');
    expect(backend.configContent).toContain('"width": 310');
    expect(getLayout()).toEqual({ ...DEFAULT_LAYOUT, side: "right", width: 310 });
    // The preview is gone: another program's edit shows through.
    backend.setConfig('{ "appearance": { "sidebar": { "width": 250 } } }');
    expect(getLayout().width).toBe(250);
  });

  it("creates the file when there is none", async () => {
    const backend = await started(null);
    await saveSidebarWidth(222);
    expect(backend.configContent).toBe(
      '{\n  "appearance": {\n    "sidebar": {\n      "width": 222\n    }\n  }\n}\n',
    );
    expect(getLayout().width).toBe(222);
  });

  it("goes back to the width of the file when it cannot be written", async () => {
    const backend = await started(RIGHT);
    backend.setConfigSaveFailure(new Error("disk full"));
    const saving = saveSidebarWidth(400);
    expect(getLayout().width).toBe(400);
    await saving;
    expect(getLayout().width).toBe(DEFAULT_LAYOUT.width);
    expect(backend.configContent).toBe(RIGHT);
  });

  it("goes back to the width of the file when the file has a problem of its own", async () => {
    const broken = '{ "appearance": { "sidebar": { "position": "middle" } } }';
    const backend = await started(broken);
    await saveSidebarWidth(400);
    expect(getLayout().width).toBe(DEFAULT_LAYOUT.width);
    expect(backend.configContent).toBe(broken);
  });

  it("ends on the last width of a quick run of moves", async () => {
    const backend = await started(null);
    const runs = [saveSidebarWidth(216), saveSidebarWidth(232), saveSidebarWidth(248)];
    expect(getLayout().width).toBe(248);
    await Promise.all(runs);
    expect(getLayout().width).toBe(248);
    expect(backend.configContent).toContain('"width": 248');
  });
});
