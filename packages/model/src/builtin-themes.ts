import { DEFAULT_BACKGROUND_OPACITY } from "./background";
import { ThemeSchema } from "./theme";
import type { Theme } from "./theme";

// The eight themes that ship with Noren. Noren Dusk and Noren Paper are Noren's own. The other six
// are ports of popular color schemes under permissive licenses; the names here are Noren's own
// and the origin of each (repository, license, holder) is only in `THIRD_PARTY_NOTICES.md`. A
// port keeps the colors of its source; the tokens of the interface (surface, border, muted) come
// from the palette of the source, and where it has none the comment says what was derived. Where a
// source color failed the contrast test (text on background, 4.5:1) it was changed, and the
// comment says which.
//
// Every theme goes through `ThemeSchema` when this module loads, so a typo in a color is an error
// at start, not a blank terminal; the tests check the contrast of all of them.

/** The font every theme starts with; an imported color scheme has no font and takes this one. */
export const FONT = {
  family: "Cascadia Code, JetBrains Mono, monospace",
  size: 13,
  lineHeight: 1.2,
  ligatures: true,
} as const;

/** The background every theme starts with (no image). */
export const BACKGROUND = { image: null, opacity: DEFAULT_BACKGROUND_OPACITY } as const;

const NOREN_DUSK_DATA = {
  id: "noren-dusk",
  name: "Noren Dusk",
  kind: "dark",
  ui: {
    bg: "#14161b",
    surface: "#1b1e25",
    text: "#e6e6e6",
    muted: "#9aa0aa",
    accent: "#e07a5f",
    border: "#2a2e37",
    radius: 10,
    blur: 18,
    opacity: 0.92,
  },
  terminal: {
    foreground: "#e6e6e6",
    background: "#14161b",
    cursor: "#e07a5f",
    selection: "#e07a5f55",
    ansi: [
      "#1b1e25",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#dcdfe4",
      "#5c6370",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#ffffff",
    ],
  },
  font: FONT,
  background: BACKGROUND,
};

const NOREN_PAPER_DATA = {
  id: "noren-paper",
  name: "Noren Paper",
  kind: "light",
  ui: {
    bg: "#f6f3ec",
    surface: "#ece8dd",
    text: "#23262d",
    muted: "#5d6470",
    accent: "#b8472c",
    border: "#d4cfc1",
    radius: 10,
    blur: 18,
    opacity: 0.92,
  },
  terminal: {
    foreground: "#23262d",
    background: "#f6f3ec",
    cursor: "#b8472c",
    selection: "#b8472c33",
    ansi: [
      "#23262d",
      "#c62828",
      "#2e7d32",
      "#8a5a00",
      "#1565c0",
      "#8e24aa",
      "#00796b",
      "#6b717b",
      "#4a505a",
      "#d32f2f",
      "#388e3c",
      "#9a6700",
      "#1976d2",
      "#9c27b0",
      "#00897b",
      "#14161b",
    ],
  },
  font: FONT,
  background: BACKGROUND,
};

// Port of a dark scheme with a purple accent. Colors as the source gives them.
const NOREN_NIGHTSHADE_DATA = {
  id: "noren-nightshade",
  name: "Noren Nightshade",
  kind: "dark",
  ui: {
    bg: "#282a36",
    surface: "#21222c",
    text: "#f8f8f2",
    muted: "#6272a4",
    accent: "#bd93f9",
    border: "#44475a",
    radius: 10,
    blur: 18,
    opacity: 0.92,
  },
  terminal: {
    foreground: "#f8f8f2",
    background: "#282a36",
    cursor: "#f8f8f2",
    selection: "#44475a",
    ansi: [
      "#21222c",
      "#ff5555",
      "#50fa7b",
      "#f1fa8c",
      "#bd93f9",
      "#ff79c6",
      "#8be9fd",
      "#f8f8f2",
      "#6272a4",
      "#ff6e6e",
      "#69ff94",
      "#ffffa5",
      "#d6acff",
      "#ff92df",
      "#a4ffff",
      "#ffffff",
    ],
  },
  font: FONT,
  background: BACKGROUND,
};

// Port of a cool dark scheme of blue-grays. Colors as the source gives them, except the muted
// text of the interface: the source's comment gray (#616e88) is 2.4:1 on the background, so the
// muted color is the source's blue-gray #81a1c1 (4.6:1).
const NOREN_FJORD_DATA = {
  id: "noren-fjord",
  name: "Noren Fjord",
  kind: "dark",
  ui: {
    bg: "#2e3440",
    surface: "#3b4252",
    text: "#d8dee9",
    muted: "#81a1c1",
    accent: "#88c0d0",
    border: "#434c5e",
    radius: 10,
    blur: 18,
    opacity: 0.92,
  },
  terminal: {
    foreground: "#d8dee9",
    background: "#2e3440",
    cursor: "#d8dee9",
    selection: "#434c5e",
    ansi: [
      "#3b4252",
      "#bf616a",
      "#a3be8c",
      "#ebcb8b",
      "#81a1c1",
      "#b48ead",
      "#88c0d0",
      "#e5e9f0",
      "#4c566a",
      "#bf616a",
      "#a3be8c",
      "#ebcb8b",
      "#81a1c1",
      "#b48ead",
      "#8fbcbb",
      "#eceff4",
    ],
  },
  font: FONT,
  background: BACKGROUND,
};

// Port of a dark blue scheme of the night. Colors as the source gives them (the editor's
// background and text for the terminal as well, and the terminal ANSI colors of the source).
const NOREN_MIDNIGHT_DATA = {
  id: "noren-midnight",
  name: "Noren Midnight",
  kind: "dark",
  ui: {
    bg: "#1a1b26",
    surface: "#16161e",
    text: "#a9b1d6",
    muted: "#787c99",
    accent: "#7aa2f7",
    border: "#292e42",
    radius: 10,
    blur: 18,
    opacity: 0.92,
  },
  terminal: {
    foreground: "#a9b1d6",
    background: "#1a1b26",
    cursor: "#c0caf5",
    selection: "#515c7e4d",
    ansi: [
      "#363b54",
      "#f7768e",
      "#73daca",
      "#e0af68",
      "#7aa2f7",
      "#bb9af7",
      "#7dcfff",
      "#787c99",
      "#363b54",
      "#f7768e",
      "#73daca",
      "#e0af68",
      "#7aa2f7",
      "#bb9af7",
      "#7dcfff",
      "#acb0d0",
    ],
  },
  font: FONT,
  background: BACKGROUND,
};

// Port of a dark green scheme (the medium contrast variant). Colors as the source gives them; the
// ANSI brights repeat the normal colors, as the source's terminal ports do.
const NOREN_MEADOW_DATA = {
  id: "noren-meadow",
  name: "Noren Meadow",
  kind: "dark",
  ui: {
    bg: "#2d353b",
    surface: "#343f44",
    text: "#d3c6aa",
    muted: "#859289",
    accent: "#a7c080",
    border: "#475258",
    radius: 10,
    blur: 18,
    opacity: 0.92,
  },
  terminal: {
    foreground: "#d3c6aa",
    background: "#2d353b",
    cursor: "#d3c6aa",
    selection: "#543a48",
    ansi: [
      "#343f44",
      "#e67e80",
      "#a7c080",
      "#dbbc7f",
      "#7fbbb3",
      "#d699b6",
      "#83c092",
      "#d3c6aa",
      "#859289",
      "#e67e80",
      "#a7c080",
      "#dbbc7f",
      "#7fbbb3",
      "#d699b6",
      "#83c092",
      "#d3c6aa",
    ],
  },
  font: FONT,
  background: BACKGROUND,
};

// Port of a light, warm scheme. Colors as the source gives them, except the text: the source's
// body text (#657b83) is 4.1:1 on the background, so the text of the interface and the
// foreground of the terminal use the source's emphasized text color #586e75 (5.0:1). The
// selection is the source's #93a1a1 with an alpha of 0.3, and the border a tint between the
// source's #eee8d5 and #93a1a1, because the source defines neither.
const NOREN_DUNE_DATA = {
  id: "noren-dune",
  name: "Noren Dune",
  kind: "light",
  ui: {
    bg: "#fdf6e3",
    surface: "#eee8d5",
    text: "#586e75",
    muted: "#657b83",
    accent: "#268bd2",
    border: "#d9d2bd",
    radius: 10,
    blur: 18,
    opacity: 0.92,
  },
  terminal: {
    foreground: "#586e75",
    background: "#fdf6e3",
    cursor: "#586e75",
    selection: "#93a1a14d",
    ansi: [
      "#073642",
      "#dc322f",
      "#859900",
      "#b58900",
      "#268bd2",
      "#d33682",
      "#2aa198",
      "#eee8d5",
      "#002b36",
      "#cb4b16",
      "#586e75",
      "#657b83",
      "#839496",
      "#6c71c4",
      "#93a1a1",
      "#fdf6e3",
    ],
  },
  font: FONT,
  background: BACKGROUND,
};

// Port of a light, soft scheme of pastel colors. Colors as the source gives them. The selection is
// the source's overlay gray #7c7f93 with an alpha of 0.2, as the source uses it in its editors.
const NOREN_OAT_DATA = {
  id: "noren-oat",
  name: "Noren Oat",
  kind: "light",
  ui: {
    bg: "#eff1f5",
    surface: "#e6e9ef",
    text: "#4c4f69",
    muted: "#6c6f85",
    accent: "#1e66f5",
    border: "#ccd0da",
    radius: 10,
    blur: 18,
    opacity: 0.92,
  },
  terminal: {
    foreground: "#4c4f69",
    background: "#eff1f5",
    cursor: "#dc8a78",
    selection: "#7c7f9333",
    ansi: [
      "#5c5f77",
      "#d20f39",
      "#40a02b",
      "#df8e1d",
      "#1e66f5",
      "#ea76cb",
      "#179299",
      "#acb0be",
      "#6c6f85",
      "#d20f39",
      "#40a02b",
      "#df8e1d",
      "#1e66f5",
      "#ea76cb",
      "#179299",
      "#bcc0cc",
    ],
  },
  font: FONT,
  background: BACKGROUND,
};

function checked(data: unknown): Theme {
  return ThemeSchema.parse(data);
}

export const NOREN_DUSK = checked(NOREN_DUSK_DATA);
export const NOREN_PAPER = checked(NOREN_PAPER_DATA);

/** Every built-in theme, in the order the palette lists them. */
export const THEMES: readonly Theme[] = [
  NOREN_DUSK,
  NOREN_PAPER,
  checked(NOREN_NIGHTSHADE_DATA),
  checked(NOREN_FJORD_DATA),
  checked(NOREN_MIDNIGHT_DATA),
  checked(NOREN_MEADOW_DATA),
  checked(NOREN_DUNE_DATA),
  checked(NOREN_OAT_DATA),
];

/** The theme with this id among the built-in ones, if there is one. */
export function findTheme(id: string): Theme | undefined {
  return THEMES.find((theme) => theme.id === id);
}
