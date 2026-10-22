import { describe, expect, it } from "vitest";
import { BACKGROUND_VEIL, DEFAULT_BACKGROUND_OPACITY, PICTURE_PANEL_OPACITY } from "./background";
import { pictureUnderPanel, worstPixel } from "./background-panel";
import type { PanelOverPicture } from "./background-panel";
import { THEMES } from "./builtin-themes";
import { contrastRatio } from "./theme";

// The text of the sidebar and of the terminal is read against what is behind it: the picture, the
// veil and the panel, added up as the stylesheet paints them. These tests measure that sum for the
// pixels a picture can have, with the defaults a picture shows with.

describe("pictureUnderPanel", () => {
  const layers = { bg: "#102030", panel: "#304050", imageOpacity: 1, panelOpacity: 0 };

  it("is the picture, seen through the veil, under a panel of clear glass", () => {
    // The picture at full opacity, then 40% of the background of the theme laid over it.
    expect(pictureUnderPanel("#ffffff", { ...layers, veil: 0 })).toBe("#ffffff");
    expect(pictureUnderPanel("#ffffff", { ...layers, veil: 1 })).toBe("#102030");
    expect(pictureUnderPanel("#ffffff", { ...layers, veil: 0.4 })).toBe("#9fa6ac");
  });

  it("is the color of the panel under a solid panel, whatever the picture is", () => {
    for (const pixel of ["#ffffff", "#000000", "#ff0000"]) {
      expect(pictureUnderPanel(pixel, { ...layers, panelOpacity: 1 })).toBe("#304050");
    }
  });

  it("is the background of the theme where the picture does not show", () => {
    const none = { ...layers, imageOpacity: 0, panelOpacity: 0 };
    expect(pictureUnderPanel("#ffffff", none)).toBe("#102030");
    expect(pictureUnderPanel("#000000", none)).toBe("#102030");
  });

  it("uses the veil of the window unless one is given", () => {
    expect(pictureUnderPanel("#ffffff", layers)).toBe(
      pictureUnderPanel("#ffffff", { ...layers, veil: BACKGROUND_VEIL }),
    );
  });
});

describe("the worst pixel", () => {
  it("is white under a dark theme and black under a light one", () => {
    expect(worstPixel("dark")).toBe("#ffffff");
    expect(worstPixel("light")).toBe("#000000");
  });
});

describe("text over a picture, with the defaults of a picture", () => {
  type Over = Pick<PanelOverPicture, "imageOpacity" | "panelOpacity" | "veil">;
  const defaults: Over = {
    imageOpacity: DEFAULT_BACKGROUND_OPACITY,
    panelOpacity: PICTURE_PANEL_OPACITY,
  };

  /** The contrast of the text of the sidebar and of the terminal over one pixel of the picture. */
  function contrasts(theme: (typeof THEMES)[number], pixel: string, over: Over = defaults) {
    const sidebar = pictureUnderPanel(pixel, { ...over, bg: theme.ui.bg, panel: theme.ui.surface });
    const terminal = pictureUnderPanel(pixel, {
      ...over,
      bg: theme.ui.bg,
      panel: theme.terminal.background,
    });
    return {
      sidebar: contrastRatio(theme.ui.text, sidebar),
      terminal: contrastRatio(theme.terminal.foreground, terminal),
    };
  }

  it("keeps 3:1, the level for large text, against the hardest pixel a picture can have", () => {
    for (const theme of THEMES) {
      const { sidebar, terminal } = contrasts(theme, worstPixel(theme.kind));
      expect(sidebar, `${theme.id} sidebar`).toBeGreaterThanOrEqual(3);
      expect(terminal, `${theme.id} terminal`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps 3.5:1 against a mid-tone pixel, the usual picture", () => {
    for (const theme of THEMES) {
      const { sidebar, terminal } = contrasts(theme, "#808080");
      expect(sidebar, `${theme.id} sidebar`).toBeGreaterThanOrEqual(3.5);
      expect(terminal, `${theme.id} terminal`).toBeGreaterThanOrEqual(3.5);
    }
  });

  it("keeps 4.5:1, the level for text, wherever the theme itself has room for it", () => {
    // A theme whose text is already close to 4.5:1 on its own background has no room for a picture.
    for (const theme of THEMES) {
      if (contrastRatio(theme.ui.text, theme.ui.bg) < 7.5) continue;
      const { sidebar, terminal } = contrasts(theme, worstPixel(theme.kind));
      expect(sidebar, `${theme.id} sidebar`).toBeGreaterThanOrEqual(4.5);
      expect(terminal, `${theme.id} terminal`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is better with the veil than without it, for a picture at full opacity", () => {
    for (const theme of THEMES) {
      const pixel = worstPixel(theme.kind);
      const full: Over = { imageOpacity: 1, panelOpacity: PICTURE_PANEL_OPACITY };
      const veiled = contrasts(theme, pixel, full).sidebar;
      const bare = contrasts(theme, pixel, { ...full, veil: 0 }).sidebar;
      expect(veiled, theme.id).toBeGreaterThan(bare);
    }
  });

  it("is lighter where the veil is light: a light theme gets a light veil, a dark one a dark veil", () => {
    for (const theme of THEMES) {
      const veil = pictureUnderPanel(worstPixel(theme.kind), {
        bg: theme.ui.bg,
        panel: theme.ui.surface,
        imageOpacity: 1,
        panelOpacity: 0,
        veil: 1,
      });
      // A full veil is the background of the theme itself.
      expect(veil, theme.id).toBe(theme.ui.bg);
    }
  });
});
