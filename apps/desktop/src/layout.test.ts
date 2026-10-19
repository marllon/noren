import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  LAYOUT_KEY,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampWidth,
  loadLayout,
  parseLayout,
  saveLayout,
  serializeLayout,
  sidebarMode,
  widthAfterDrag,
  widthAfterKey,
} from "./layout";
import type { Layout, LayoutStorage } from "./layout";

function memoryStorage(initial: Record<string, string> = {}): LayoutStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("clampWidth", () => {
  it("keeps a width in range and rounds it", () => {
    expect(clampWidth(300)).toBe(300);
    expect(clampWidth(300.6)).toBe(301);
  });

  it("brings a width into 180 to 480", () => {
    expect(clampWidth(10)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampWidth(-500)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampWidth(9999)).toBe(MAX_SIDEBAR_WIDTH);
    expect(clampWidth(MIN_SIDEBAR_WIDTH)).toBe(180);
    expect(clampWidth(MAX_SIDEBAR_WIDTH)).toBe(480);
  });
});

describe("parseLayout", () => {
  it("gives the default when nothing is saved", () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
  });

  it("gives the default for text that is not an object", () => {
    for (const raw of ["", "{", "null", "7", '"right"', "[1,2]", "true"]) {
      expect(parseLayout(raw)).toEqual(DEFAULT_LAYOUT);
    }
  });

  it("returns a new object, never the shared default", () => {
    expect(parseLayout(null)).not.toBe(DEFAULT_LAYOUT);
  });

  it("falls back per field when one is invalid", () => {
    const raw = JSON.stringify({
      side: "top",
      width: "wide",
      density: 3,
      compact: "yes",
      keepOpen: null,
      tabs: "bottom",
      paneHeaders: "yes",
    });
    expect(parseLayout(raw)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify({ side: "right", width: "x" }))).toEqual({
      ...DEFAULT_LAYOUT,
      side: "right",
    });
  });

  it("clamps a saved width that is out of range and rejects one that is not a finite number", () => {
    expect(parseLayout(JSON.stringify({ width: 50 })).width).toBe(MIN_SIDEBAR_WIDTH);
    expect(parseLayout(JSON.stringify({ width: 5000 })).width).toBe(MAX_SIDEBAR_WIDTH);
    expect(parseLayout('{"width":1e999}').width).toBe(DEFAULT_LAYOUT.width);
  });

  it("round-trips a layout", () => {
    const layout: Layout = {
      side: "right",
      width: 333,
      density: "compact",
      compact: true,
      keepOpen: true,
      tabs: "top",
      paneHeaders: true,
    };
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  it("keeps the tabs in the sidebar by default and when the saved value is invalid", () => {
    expect(DEFAULT_LAYOUT.tabs).toBe("sidebar");
    for (const tabs of [3, null, true, "", "Top", "bottom", ["top"]]) {
      expect(parseLayout(JSON.stringify({ tabs })).tabs).toBe("sidebar");
    }
  });

  it("reads top tabs, and a layout saved before the field existed stays valid", () => {
    expect(parseLayout(JSON.stringify({ tabs: "top" })).tabs).toBe("top");
    expect(parseLayout(JSON.stringify({ tabs: "sidebar" })).tabs).toBe("sidebar");
    const old = JSON.stringify({
      side: "right",
      width: 300,
      density: "compact",
      compact: true,
      keepOpen: false,
    });
    expect(parseLayout(old)).toEqual({
      side: "right",
      width: 300,
      density: "compact",
      compact: true,
      keepOpen: false,
      tabs: "sidebar",
      paneHeaders: false,
    });
  });

  it("keeps the pane headers off by default and when the saved value is invalid", () => {
    expect(DEFAULT_LAYOUT.paneHeaders).toBe(false);
    for (const paneHeaders of [1, 0, null, "true", "", ["on"], {}]) {
      expect(parseLayout(JSON.stringify({ paneHeaders })).paneHeaders).toBe(false);
    }
  });

  it("reads the pane headers preference, and a layout saved before the field existed has them off", () => {
    expect(parseLayout(JSON.stringify({ paneHeaders: true })).paneHeaders).toBe(true);
    expect(parseLayout(JSON.stringify({ paneHeaders: false })).paneHeaders).toBe(false);
    expect(parseLayout(JSON.stringify({ side: "right", tabs: "top" })).paneHeaders).toBe(false);
  });
});

describe("loadLayout and saveLayout", () => {
  it("saves under noren.ui.layout and reads it back", () => {
    const storage = memoryStorage();
    const layout: Layout = { ...DEFAULT_LAYOUT, side: "right", width: 260 };
    saveLayout(storage, layout);
    expect(Object.keys(storage.data)).toEqual([LAYOUT_KEY]);
    expect(loadLayout(storage)).toEqual(layout);
  });

  it("falls back to the default without storage or when it throws", () => {
    expect(loadLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    const broken: LayoutStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadLayout(broken)).toEqual(DEFAULT_LAYOUT);
    expect(() => saveLayout(broken, DEFAULT_LAYOUT)).not.toThrow();
    expect(() => saveLayout(undefined, DEFAULT_LAYOUT)).not.toThrow();
  });

  it("falls back to the default for a saved value that is invalid", () => {
    expect(loadLayout(memoryStorage({ [LAYOUT_KEY]: "garbage" }))).toEqual(DEFAULT_LAYOUT);
  });
});

describe("sidebarMode", () => {
  it("auto-hides only in compact mode that is not kept open", () => {
    expect(sidebarMode(DEFAULT_LAYOUT)).toBe("docked");
    expect(sidebarMode({ ...DEFAULT_LAYOUT, compact: true })).toBe("auto-hide");
    expect(sidebarMode({ ...DEFAULT_LAYOUT, compact: true, keepOpen: true })).toBe("docked");
    expect(sidebarMode({ ...DEFAULT_LAYOUT, keepOpen: true })).toBe("docked");
  });

  it("always leaves the flow with top tabs, even when kept open", () => {
    expect(sidebarMode({ ...DEFAULT_LAYOUT, tabs: "top" })).toBe("auto-hide");
    expect(sidebarMode({ ...DEFAULT_LAYOUT, tabs: "top", compact: true, keepOpen: true })).toBe(
      "auto-hide",
    );
  });
});

describe("widthAfterDrag", () => {
  it("widens a left sidebar when the pointer moves right", () => {
    expect(widthAfterDrag(200, 200, 260, "left")).toBe(260);
    expect(widthAfterDrag(200, 200, 150, "left")).toBe(180);
  });

  it("widens a right sidebar when the pointer moves left", () => {
    expect(widthAfterDrag(200, 800, 740, "right")).toBe(260);
    expect(widthAfterDrag(200, 800, 900, "right")).toBe(180);
  });

  it("stops at the limits", () => {
    expect(widthAfterDrag(200, 200, 2000, "left")).toBe(MAX_SIDEBAR_WIDTH);
    expect(widthAfterDrag(400, 400, -2000, "left")).toBe(MIN_SIDEBAR_WIDTH);
  });
});

describe("widthAfterKey", () => {
  it("moves by 16, or 48 with Shift, toward the content to widen", () => {
    expect(widthAfterKey(300, "ArrowRight", "left", false)).toBe(316);
    expect(widthAfterKey(300, "ArrowLeft", "left", false)).toBe(284);
    expect(widthAfterKey(300, "ArrowRight", "left", true)).toBe(348);
    expect(widthAfterKey(300, "ArrowLeft", "right", false)).toBe(316);
    expect(widthAfterKey(300, "ArrowRight", "right", false)).toBe(284);
  });

  it("stops at the limits and jumps with Home and End", () => {
    expect(widthAfterKey(472, "ArrowRight", "left", false)).toBe(MAX_SIDEBAR_WIDTH);
    expect(widthAfterKey(190, "ArrowLeft", "left", false)).toBe(MIN_SIDEBAR_WIDTH);
    expect(widthAfterKey(300, "Home", "left", false)).toBe(MIN_SIDEBAR_WIDTH);
    expect(widthAfterKey(300, "End", "right", false)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("ignores other keys", () => {
    expect(widthAfterKey(300, "ArrowUp", "left", false)).toBeUndefined();
    expect(widthAfterKey(300, "a", "left", false)).toBeUndefined();
  });
});
