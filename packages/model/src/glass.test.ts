import { describe, expect, it } from "vitest";
import { BACKGROUND_VEIL, DEFAULT_BACKGROUND_OPACITY } from "./background";
import { pictureUnderPanel, worstPixel } from "./background-panel";
import { THEMES } from "./builtin-themes";
import {
  GLASS_PANEL_OPACITY,
  GLASS_SIDE_MIN_OPACITY,
  GLASS_SIDE_OPACITY_STEP,
  GLASS_SIDE_SOLID_RAMP,
  GLASS_VEIL,
  glassSideOpacity,
} from "./glass";
import { contrastRatio } from "./theme";
import { MIN_WINDOW_OPACITY } from "./window-effect";

// The numbers of the glass interface style that are not a color or a size of the stylesheet. The
// stylesheet (`style-tokens.css`) works the fills out from `--nr-opacity` the same way; the test of
// the app that reads it (`interface-style.test.ts`) holds the two together.

describe("the glass opacities", () => {
  it("are the ones of the design: panels at 0.62, the sidebar 0.2 less (0.42)", () => {
    expect(GLASS_PANEL_OPACITY).toBe(0.62);
    expect(GLASS_SIDE_OPACITY_STEP).toBe(0.2);
    expect(glassSideOpacity(GLASS_PANEL_OPACITY)).toBeCloseTo(0.42, 10);
  });

  it("keep the sidebar a surface when the panels are nearly clear: never under 0.2", () => {
    expect(GLASS_SIDE_MIN_OPACITY).toBe(0.2);
    expect(glassSideOpacity(MIN_WINDOW_OPACITY)).toBe(0.2);
    expect(glassSideOpacity(0.2)).toBe(0.2);
    expect(glassSideOpacity(0)).toBe(0.2);
  });

  it("make the sidebar solid when the panels are: the end of the slider is a plain opaque window", () => {
    expect(glassSideOpacity(1)).toBe(1);
    // The step fades out over the last 0.05, so there is no jump just under 1.
    expect(glassSideOpacity(1 - GLASS_SIDE_SOLID_RAMP)).toBeCloseTo(0.75, 10);
    expect(glassSideOpacity(0.99)).toBeGreaterThan(glassSideOpacity(0.95));
  });

  it("never let the sidebar be more opaque than the panels, and follow them upward", () => {
    let last = 0;
    for (let panel = MIN_WINDOW_OPACITY; panel <= 1.0001; panel += 0.01) {
      const side = glassSideOpacity(panel);
      expect(side, `panels at ${panel}`).toBeLessThanOrEqual(
        Math.max(panel, GLASS_SIDE_MIN_OPACITY),
      );
      expect(side, `panels at ${panel}`).toBeGreaterThanOrEqual(last - 1e-9);
      last = side;
    }
  });
});

describe("the veil of the glass", () => {
  it("is stronger than the one of the dense style, and never covers the picture", () => {
    expect(GLASS_VEIL).toBeGreaterThan(BACKGROUND_VEIL);
    expect(GLASS_VEIL).toBeLessThan(1);
  });

  // The text of the sidebar and of the panes is read against what is behind it: the picture at the
  // opacity a picture shows with, the veil, and the glass of the card on top, added up as the stylesheet
  // paints them (`pictureUnderPanel`).
  function contrasts(theme: (typeof THEMES)[number], pixel: string, panel = GLASS_PANEL_OPACITY) {
    const layers = { bg: theme.ui.bg, imageOpacity: DEFAULT_BACKGROUND_OPACITY, veil: GLASS_VEIL };
    const sidebar = pictureUnderPanel(pixel, {
      ...layers,
      panel: theme.ui.surface,
      panelOpacity: glassSideOpacity(panel),
    });
    const pane = pictureUnderPanel(pixel, { ...layers, panel: theme.ui.bg, panelOpacity: panel });
    return {
      sidebar: contrastRatio(theme.ui.text, sidebar),
      pane: contrastRatio(theme.terminal.foreground, pane),
    };
  }

  it("keeps the text at 4.5:1 over the hardest pixel a picture can have, for every theme that has room for it", () => {
    let measured = 0;
    for (const theme of THEMES) {
      // A theme whose text is already close to 4.5:1 on its own background has no room for a picture.
      if (contrastRatio(theme.ui.text, theme.ui.bg) < 7.5) continue;
      measured++;
      const { sidebar, pane } = contrasts(theme, worstPixel(theme.kind));
      expect(sidebar, `${theme.id} sidebar`).toBeGreaterThanOrEqual(4.5);
      expect(pane, `${theme.id} pane`).toBeGreaterThanOrEqual(4.5);
    }
    // A dark and a light theme, at least: the check is not empty.
    expect(measured).toBeGreaterThanOrEqual(4);
    expect(THEMES.filter((theme) => theme.kind === "light").length).toBeGreaterThan(0);
  });

  it("does it better than the veil of the dense style would under the same glass", () => {
    for (const theme of THEMES) {
      if (contrastRatio(theme.ui.text, theme.ui.bg) < 7.5) continue;
      const pixel = worstPixel(theme.kind);
      const layers = {
        bg: theme.ui.bg,
        panel: theme.ui.surface,
        imageOpacity: DEFAULT_BACKGROUND_OPACITY,
        panelOpacity: glassSideOpacity(GLASS_PANEL_OPACITY),
      };
      const glass = contrastRatio(
        theme.ui.text,
        pictureUnderPanel(pixel, { ...layers, veil: GLASS_VEIL }),
      );
      const dense = contrastRatio(
        theme.ui.text,
        pictureUnderPanel(pixel, { ...layers, veil: BACKGROUND_VEIL }),
      );
      expect(glass, theme.id).toBeGreaterThan(dense);
    }
  });

  it("holds the text at 3:1 for any theme over the hardest pixel, as the dense style does", () => {
    for (const theme of THEMES) {
      const { sidebar, pane } = contrasts(theme, worstPixel(theme.kind));
      expect(sidebar, `${theme.id} sidebar`).toBeGreaterThanOrEqual(3);
      expect(pane, `${theme.id} pane`).toBeGreaterThanOrEqual(3);
    }
  });

  it("is light under a light theme and dark under a dark one, so the picture is always dimmed toward the theme", () => {
    for (const theme of THEMES) {
      const full = pictureUnderPanel(worstPixel(theme.kind), {
        bg: theme.ui.bg,
        panel: theme.ui.surface,
        imageOpacity: 1,
        panelOpacity: 0,
        veil: 1,
      });
      expect(full, theme.id).toBe(theme.ui.bg);
    }
  });
});
