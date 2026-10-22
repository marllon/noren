import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  LAYOUT_KEY,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampWidth,
  layoutFromConfig,
  layoutOf,
  parseLayout,
  sidebarMode,
  widthAfterDrag,
  widthAfterKey,
} from "./layout";
import type { Layout } from "./layout";

describe("layoutFromConfig", () => {
  it("sets nothing for a file that says nothing about the layout", () => {
    expect(layoutFromConfig({})).toEqual({});
    expect(layoutFromConfig({ appearance: {} })).toEqual({});
    expect(
      layoutFromConfig({ appearance: { sidebar: {} }, notifications: { enabled: false } }),
    ).toEqual({});
  });

  it("maps each setting to its preference, and only the ones the file mentions", () => {
    expect(layoutFromConfig({ appearance: { sidebar: { position: "right" } } })).toEqual({
      side: "right",
    });
    expect(layoutFromConfig({ appearance: { sidebar: { width: 300 } } })).toEqual({ width: 300 });
    expect(
      layoutFromConfig({ appearance: { sidebar: { compact: false, keepOpen: true } } }),
    ).toEqual({ compact: false, keepOpen: true });
    expect(layoutFromConfig({ appearance: { density: "compact" } })).toEqual({
      density: "compact",
    });
    expect(layoutFromConfig({ appearance: { tabs: "top", paneHeaders: true } })).toEqual({
      tabs: "top",
      paneHeaders: true,
    });
  });

  it("maps the place of the favorites bar, and says nothing when the file does not", () => {
    expect(layoutFromConfig({ appearance: { favorites: "top" } })).toEqual({ favorites: "top" });
    expect(layoutFromConfig({ appearance: { favorites: "sidebar" } })).toEqual({
      favorites: "sidebar",
    });
    expect(layoutFromConfig({ appearance: { tabs: "top" } })).toEqual({ tabs: "top" });
  });

  it("maps the interface style, and says nothing when the file does not", () => {
    expect(layoutFromConfig({ appearance: { style: "dense" } })).toEqual({ style: "dense" });
    expect(layoutFromConfig({ appearance: { style: "glass" } })).toEqual({ style: "glass" });
    expect(layoutFromConfig({ appearance: { favorites: "top" } })).toEqual({ favorites: "top" });
  });
});

describe("layoutOf", () => {
  it("draws the glass style unless the file says dense, whatever else it says", () => {
    expect(DEFAULT_LAYOUT.style).toBe("glass");
    expect(layoutOf({}).style).toBe("glass");
    expect(layoutOf({ appearance: { tabs: "top", favorites: "top" } }).style).toBe("glass");
    expect(layoutOf({ appearance: { style: "dense" } })).toEqual({
      ...DEFAULT_LAYOUT,
      style: "dense",
    });
  });

  it("is the default layout for a file that says nothing", () => {
    expect(layoutOf({})).toEqual(DEFAULT_LAYOUT);
    expect(layoutOf({})).not.toBe(DEFAULT_LAYOUT);
  });

  it("puts what the file says over the default, a preference at a time", () => {
    expect(
      layoutOf({
        appearance: { sidebar: { position: "right", width: 260 }, tabs: "top" },
        notifications: { enabled: false },
      }),
    ).toEqual({ ...DEFAULT_LAYOUT, side: "right", width: 260, tabs: "top" });
  });

  it("keeps the favorites bar in the sidebar unless the file puts it on top, whatever the tabs do", () => {
    expect(DEFAULT_LAYOUT.favorites).toBe("sidebar");
    expect(layoutOf({}).favorites).toBe("sidebar");
    expect(layoutOf({ appearance: { tabs: "top" } }).favorites).toBe("sidebar");
    expect(layoutOf({ appearance: { favorites: "top" } })).toEqual({
      ...DEFAULT_LAYOUT,
      favorites: "top",
    });
    expect(layoutOf({ appearance: { favorites: "top", tabs: "top" } })).toEqual({
      ...DEFAULT_LAYOUT,
      favorites: "top",
      tabs: "top",
    });
  });

  it("keeps a preference that is off: false is a choice, not a gap", () => {
    expect(layoutOf({ appearance: { sidebar: { compact: false }, paneHeaders: false } })).toEqual(
      DEFAULT_LAYOUT,
    );
  });
});

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

  it("reads every field of a layout as earlier builds saved it", () => {
    const layout: Layout = {
      side: "right",
      width: 333,
      density: "compact",
      compact: true,
      keepOpen: true,
      tabs: "top",
      favorites: "sidebar",
      style: "glass",
      paneHeaders: true,
    };
    expect(parseLayout(JSON.stringify(layout))).toEqual(layout);
  });

  it("never reads the interface style from the old storage: only the file sets it", () => {
    for (const style of ["dense", "glass", "technical", 3, null, true]) {
      expect(parseLayout(JSON.stringify({ style })).style).toBe("glass");
    }
  });

  it("never reads the place of the favorites bar from the old storage: only the file sets it", () => {
    for (const favorites of ["top", "sidebar", 3, null, true]) {
      expect(parseLayout(JSON.stringify({ favorites })).favorites).toBe("sidebar");
    }
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
      favorites: "sidebar",
      style: "glass",
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

describe("the old browser-storage key", () => {
  it("is still named, for the move into the file", () => {
    expect(LAYOUT_KEY).toBe("noren.ui.layout");
    expect(parseLayout("garbage")).toEqual(DEFAULT_LAYOUT);
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

  it("does not depend on where the favorites bar is: the bar on top leaves the sidebar's mode alone", () => {
    expect(sidebarMode({ ...DEFAULT_LAYOUT, favorites: "top" })).toBe("docked");
    expect(sidebarMode({ ...DEFAULT_LAYOUT, favorites: "top", compact: true })).toBe("auto-hide");
    expect(sidebarMode({ ...DEFAULT_LAYOUT, favorites: "top", tabs: "top" })).toBe("auto-hide");
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
