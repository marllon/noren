import { describe, expect, it } from "vitest";
import {
  BACKGROUND_VEIL,
  DEFAULT_BACKGROUND_OPACITY,
  GLASS_PANEL_OPACITY,
  GLASS_VEIL,
  NOREN_DUSK,
  NOREN_PAPER,
  PICTURE_PANEL_OPACITY,
} from "@noren/model";
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
      background: { image: null, opacity: DEFAULT_BACKGROUND_OPACITY, blur: 0 },
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

  it("lets the panels through while a picture is on screen, and only then", () => {
    const shown = windowAppearance({
      config: {},
      theme: NOREN_DUSK,
      applied: "none",
      pictureShown: true,
    });
    expect(shown.opacity).toBe(PICTURE_PANEL_OPACITY);
    // A picture that is only wanted (it could not be read) must not make the window see-through.
    const wanted = windowAppearance({
      config: { appearance: { background: { image: "backgrounds/sky.png" } } },
      theme: NOREN_DUSK,
      applied: "none",
      pictureShown: false,
    });
    expect(wanted.opacity).toBe(1);
    // The setting always counts.
    const set = windowAppearance({
      config: { appearance: { window: { opacity: 0.9 } } },
      theme: NOREN_DUSK,
      applied: "none",
      pictureShown: true,
    });
    expect(set.opacity).toBe(0.9);
  });

  it("has a picture that shows by default: more than the 0.15 of before", () => {
    const { background } = windowAppearance({
      config: { appearance: { background: { image: "backgrounds/sky.png" } } },
      theme: NOREN_DUSK,
      applied: "none",
      pictureShown: true,
    });
    expect(background.opacity).toBe(DEFAULT_BACKGROUND_OPACITY);
    expect(background.opacity).toBeGreaterThan(0.15);
  });

  it("lays the numbers of a preview over the settings and the space, and only those", () => {
    const config: Config = {
      appearance: {
        window: { opacity: 0.9 },
        background: { image: "backgrounds/sky.png", opacity: 0.4, blur: 3 },
      },
    };
    const none = windowAppearance({ config, theme: NOREN_DUSK, applied: "none" });
    expect(none).toMatchObject({ opacity: 0.9, background: { opacity: 0.4, blur: 3 } });
    const tried = windowAppearance({
      config,
      theme: NOREN_DUSK,
      applied: "none",
      preview: { windowOpacity: 0.5, backgroundOpacity: 1, backgroundBlur: 12 },
    });
    expect(tried).toMatchObject({
      opacity: 0.5,
      background: { image: "backgrounds/sky.png", opacity: 1, blur: 12 },
    });
    // A number the preview does not try out stays as the settings have it.
    const partial = windowAppearance({
      config,
      theme: NOREN_DUSK,
      applied: "none",
      preview: { backgroundBlur: 20 },
    });
    expect(partial).toMatchObject({ opacity: 0.9, background: { opacity: 0.4, blur: 20 } });
    // A box that was emptied (null) is "not set": the default of the window, not the file.
    const emptied = windowAppearance({
      config,
      theme: NOREN_DUSK,
      applied: "none",
      pictureShown: true,
      preview: { windowOpacity: null, backgroundOpacity: null },
    });
    expect(emptied).toMatchObject({
      opacity: PICTURE_PANEL_OPACITY,
      background: { opacity: DEFAULT_BACKGROUND_OPACITY },
    });
  });

  it("lays the preview of the dialog of a space over the picture of the space", () => {
    const space = { image: "/home/me/space.png", opacity: 0.9 };
    const tried = windowAppearance({
      config: { appearance: { background: { opacity: 0.4, blur: 3 } } },
      theme: NOREN_DUSK,
      applied: "none",
      spaceBackground: space,
      preview: { spaceOpacity: 0.2, spaceBlur: 7 },
    });
    expect(tried.background).toEqual({ image: space.image, opacity: 0.2, blur: 7 });
    // A space with no picture of its own still takes the numbers (the image says nothing).
    const none = windowAppearance({
      config: { appearance: { background: { image: "backgrounds/sky.png" } } },
      theme: NOREN_DUSK,
      applied: "none",
      preview: { spaceOpacity: 0.3 },
    });
    expect(none.background).toEqual({
      image: "backgrounds/sky.png",
      opacity: 0.3,
      blur: 0,
    });
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
      "--nr-terminal-glass": `rgb(20 22 27 / 0.8)`,
      "--nr-background-image": 'url("blob:abc")',
      "--nr-background-opacity": "0.4",
      "--nr-background-blur": "6px",
      "--nr-background-veil": String(BACKGROUND_VEIL),
      // Under Mica the picture is drawn on the glass of the window, so the effect shows through.
      "--nr-background-backing": `rgb(20 22 27 / 0.8)`,
      "--nr-panel-blur": `${NOREN_DUSK.ui.blur}px`,
    });
  });

  it("draws the picture on the solid background of the theme when the window has no effect", () => {
    const appearance = windowAppearance({
      config: {},
      theme: NOREN_DUSK,
      applied: "none",
      pictureShown: true,
    });
    const variables = windowVariables(appearance, NOREN_DUSK, "blob:abc");
    expect(variables["--nr-background-backing"]).toBe(NOREN_DUSK.ui.bg);
    // The panels are see-through, the pane of a terminal too, with the color of the terminal.
    expect(variables["--nr-opacity"]).toBe(String(PICTURE_PANEL_OPACITY));
    expect(variables["--nr-terminal-glass"]).toBe(`rgb(20 22 27 / ${PICTURE_PANEL_OPACITY})`);
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
    background: { image: null, opacity: DEFAULT_BACKGROUND_OPACITY, blur: 0 },
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

describe("under the glass style", () => {
  const glass = (
    config: Config = {},
    extra: { pictureShown?: boolean; applied?: "none" | "mica" } = {},
  ) => windowAppearance({ config, theme: NOREN_DUSK, applied: "none", glass: true, ...extra });

  it("is see-through by default, with or without a picture: the panels are glass", () => {
    expect(glass().opacity).toBe(GLASS_PANEL_OPACITY);
    expect(glass({}, { pictureShown: true }).opacity).toBe(GLASS_PANEL_OPACITY);
    // Over a system effect too: the glass of the style, and not the opacity of the theme.
    expect(glass({}, { applied: "mica" }).opacity).toBe(GLASS_PANEL_OPACITY);
  });

  it("takes the opacity of the settings over it, and the numbers of a picture are the same", () => {
    const config: Config = {
      appearance: { window: { opacity: 0.8 }, background: { opacity: 0.4, blur: 6 } },
    };
    expect(glass(config)).toMatchObject({
      opacity: 0.8,
      background: { opacity: 0.4, blur: 6 },
    });
  });

  it("is not the style of a window that says nothing about it: the opacity stays solid", () => {
    expect(windowAppearance({ config: {}, theme: NOREN_DUSK, applied: "none" }).opacity).toBe(1);
  });

  it("puts the glass veil over a picture, and keeps the window solid behind the backdrop", () => {
    const appearance = glass();
    const variables = windowVariables(appearance, NOREN_DUSK, "blob:abc", true);
    expect(variables["--nr-background-veil"]).toBe(String(GLASS_VEIL));
    expect(variables["--nr-opacity"]).toBe(String(GLASS_PANEL_OPACITY));
    // The backdrop covers the window, so the page behind the glass is solid: the glass is the panels.
    expect(variables["--nr-bg-glass"]).toBe(NOREN_DUSK.ui.bg);
    expect(variables["--nr-background-backing"]).toBe(NOREN_DUSK.ui.bg);
    // The rest is what the other style sets, under the same names.
    expect(Object.keys(variables).sort()).toEqual(
      Object.keys(windowVariables(appearance, NOREN_DUSK, "blob:abc")).sort(),
    );
  });

  it("keeps the window itself translucent under a system effect, where the effect is the backdrop", () => {
    const appearance = glass({}, { applied: "mica" });
    const variables = windowVariables(appearance, NOREN_DUSK, null, true);
    expect(variables["--nr-bg-glass"]).toBe(`rgb(20 22 27 / ${GLASS_PANEL_OPACITY})`);
  });

  it("leaves the veil of the other style as it was", () => {
    const variables = windowVariables(glass(), NOREN_DUSK, "blob:abc");
    expect(variables["--nr-background-veil"]).toBe(String(BACKGROUND_VEIL));
    expect(GLASS_VEIL).not.toBe(BACKGROUND_VEIL);
  });
});
