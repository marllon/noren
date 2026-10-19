import { describe, expect, it } from "vitest";
import { NOREN_DUSK, NOREN_PAPER } from "@noren/model";
import type { Config, Theme } from "@noren/model";
import { isTranslucent, terminalTheme } from "./theme";
import {
  applyWindowVariables,
  terminalOpacity,
  windowAppearance,
  windowVariables,
  withOpacity,
} from "./window-appearance";

const dusk = (background: Partial<Theme["background"]> = {}): Theme => ({
  ...NOREN_DUSK,
  background: { ...NOREN_DUSK.background, ...background },
});

describe("windowAppearance", () => {
  it("is solid, with no effect and no picture, for a theme and a file that say nothing", () => {
    expect(windowAppearance({ config: {}, theme: NOREN_DUSK, applied: "none" })).toEqual({
      opacity: 1,
      effect: "none",
      background: { image: null, opacity: 0.15, blur: 0 },
    });
  });

  it("takes the opacity of the theme while the window has an effect", () => {
    const appearance = windowAppearance({ config: {}, theme: NOREN_DUSK, applied: "mica" });
    expect(appearance).toMatchObject({ opacity: NOREN_DUSK.ui.opacity, effect: "mica" });
  });

  it("takes the opacity of the settings over the theme's, with and without an effect", () => {
    const config: Config = { appearance: { window: { opacity: 0.7 } } };
    expect(windowAppearance({ config, theme: NOREN_DUSK, applied: "none" }).opacity).toBe(0.7);
    expect(windowAppearance({ config, theme: NOREN_DUSK, applied: "acrylic" }).opacity).toBe(0.7);
  });

  it("stays solid when the effect that was asked for is not the one the window has", () => {
    // The settings ask for Mica; the system could not paint it, so the window has none.
    const config: Config = { appearance: { window: { effect: "mica" } } };
    expect(windowAppearance({ config, theme: NOREN_DUSK, applied: "none" }).opacity).toBe(1);
  });

  it("merges the background of the theme, the settings and the space, the last one winning", () => {
    const theme = dusk({ image: "themes/sky.png", opacity: 0.2, blur: 3 });
    const config: Config = { appearance: { background: { opacity: 0.5 } } };
    expect(windowAppearance({ config, theme, applied: "none" }).background).toEqual({
      image: "themes/sky.png",
      opacity: 0.5,
      blur: 3,
    });
    expect(
      windowAppearance({
        config,
        theme,
        applied: "none",
        spaceBackground: { image: "C:\\Pictures\\space.png", blur: 9 },
      }).background,
    ).toEqual({ image: "C:\\Pictures\\space.png", opacity: 0.5, blur: 9 });
    // null in the settings: no picture, even the one of the theme.
    expect(
      windowAppearance({
        config: { appearance: { background: { image: null } } },
        theme,
        applied: "none",
      }).background.image,
    ).toBeNull();
  });
});

describe("withOpacity", () => {
  it("is the color itself when solid, so a window at full opacity is painted as it always was", () => {
    expect(withOpacity("#14161b", 1)).toBe("#14161b");
  });

  it("is the color with an alpha otherwise", () => {
    expect(withOpacity("#14161b", 0.92)).toBe("rgb(20 22 27 / 0.92)");
    expect(withOpacity("#ffffff", 0.5)).toBe("rgb(255 255 255 / 0.5)");
    expect(withOpacity("#000000", 0.3333333)).toBe("rgb(0 0 0 / 0.333)");
  });
});

describe("windowVariables", () => {
  it("sets the opacity, the glass colors and the picture", () => {
    const appearance = windowAppearance({
      config: { appearance: { window: { opacity: 0.8 }, background: { opacity: 0.4, blur: 6 } } },
      theme: NOREN_DUSK,
      applied: "mica",
    });
    expect(windowVariables(appearance, NOREN_DUSK, "blob:abc")).toEqual({
      "--nr-opacity": "0.8",
      "--nr-bg-glass": `rgb(20 22 27 / 0.8)`,
      "--nr-surface-glass": `rgb(27 30 37 / 0.8)`,
      "--nr-background-image": 'url("blob:abc")',
      "--nr-background-opacity": "0.4",
      "--nr-background-blur": "6px",
    });
  });

  it("is solid and has no picture for a plain window", () => {
    const appearance = windowAppearance({ config: {}, theme: NOREN_PAPER, applied: "none" });
    const variables = windowVariables(appearance, NOREN_PAPER, null);
    expect(variables["--nr-opacity"]).toBe("1");
    expect(variables["--nr-bg-glass"]).toBe(NOREN_PAPER.ui.bg);
    expect(variables["--nr-surface-glass"]).toBe(NOREN_PAPER.ui.surface);
    expect(variables["--nr-background-image"]).toBe("none");
    expect(variables["--nr-background-blur"]).toBe("0px");
  });

  it("is set on the root element one property at a time", () => {
    const set: [string, string][] = [];
    applyWindowVariables(
      { style: { setProperty: (name, value) => set.push([name, value]) } },
      {
        "--nr-opacity": "0.5",
        "--nr-background-image": "none",
      },
    );
    expect(set).toEqual([
      ["--nr-opacity", "0.5"],
      ["--nr-background-image", "none"],
    ]);
  });
});

describe("the terminal over a translucent window or a picture", () => {
  const appearance = (opacity: number) => ({
    opacity,
    effect: "none" as const,
    background: { image: null, opacity: 0.15, blur: 0 },
  });

  it("is as opaque as the interface, and not at all while a picture shows behind it", () => {
    expect(terminalOpacity(appearance(0.8), false)).toBe(0.8);
    expect(terminalOpacity(appearance(0.8), true)).toBe(0);
    expect(terminalOpacity(appearance(1), true)).toBe(0);
    expect(terminalOpacity(appearance(1), false)).toBe(1);
  });

  it("paints the background of the terminal with that alpha and never fades the text", () => {
    expect(terminalTheme(NOREN_DUSK).background).toBe(NOREN_DUSK.terminal.background);
    expect(terminalTheme(NOREN_DUSK, 1).background).toBe(NOREN_DUSK.terminal.background);
    expect(terminalTheme(NOREN_DUSK, 0).background).toBe(`${NOREN_DUSK.terminal.background}00`);
    expect(terminalTheme(NOREN_DUSK, 0.5).background).toBe(`${NOREN_DUSK.terminal.background}80`);
    const faded = terminalTheme(NOREN_DUSK, 0.3);
    expect(faded.foreground).toBe(NOREN_DUSK.terminal.foreground);
    expect(faded.cursor).toBe(NOREN_DUSK.terminal.cursor);
    expect(faded.red).toBe(NOREN_DUSK.terminal.ansi[1]);
  });

  it("tells a see-through background from a solid one", () => {
    expect(isTranslucent(terminalTheme(NOREN_DUSK, 0.5).background)).toBe(true);
    expect(isTranslucent(terminalTheme(NOREN_DUSK, 0).background)).toBe(true);
    expect(isTranslucent(terminalTheme(NOREN_DUSK, 1).background)).toBe(false);
    expect(isTranslucent("#14161bff")).toBe(false);
    expect(isTranslucent("#14161bFE")).toBe(true);
    expect(isTranslucent(undefined)).toBe(false);
    expect(isTranslucent("rgba(0,0,0,0.5)")).toBe(false);
  });
});
