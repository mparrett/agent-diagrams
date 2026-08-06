/**
 * themes.js — color schemes for the diagram.
 *
 * Each scheme is just the raw terminal palette: background, foreground, and the
 * 16 ANSI colors (normal 0-7 + bright 8-15), sourced from iTerm2-Color-Schemes.
 * `deriveTheme()` in diagram-core.js maps these onto diagram entities (node
 * bg/border, edge colors, text, grid). To add a scheme, paste its 18 values.
 */
export const SCHEMES = {
  afterglow: {
    label: "Afterglow",
    bg: "#212121",
    fg: "#d0d0d0",
    black: "#151515",
    red: "#ac4142",
    green: "#7e8e50",
    yellow: "#e5b567",
    blue: "#6c99bb",
    magenta: "#9f4e85",
    cyan: "#7dd6cf",
    white: "#d0d0d0",
    brBlack: "#505050",
    brRed: "#ac4142",
    brGreen: "#7e8e50",
    brYellow: "#e5b567",
    brBlue: "#6c99bb",
    brMagenta: "#9f4e85",
    brCyan: "#7dd6cf",
    brWhite: "#f5f5f5",
  },
  dawnfox: {
    label: "Dawnfox",
    bg: "#faf4ed",
    fg: "#575279",
    black: "#575279",
    red: "#b4637a",
    green: "#618774",
    yellow: "#ea9d34",
    blue: "#286983",
    magenta: "#907aa9",
    cyan: "#56949f",
    white: "#e5e9f0",
    brBlack: "#5f5695",
    brRed: "#c26d85",
    brGreen: "#629f81",
    brYellow: "#eea846",
    brBlue: "#2d81a3",
    brMagenta: "#9a80b9",
    brCyan: "#5ca7b4",
    brWhite: "#e6ebf3",
  },
  // Grayscale light theme — every "color" is a distinct shade of gray, so node
  // categories stay distinguishable (by border darkness) while the diagram reads
  // as monochrome / print-friendly. Edge styles still differ by dash pattern.
  monolight: {
    label: "Mono Light",
    bg: "#f5f5f4",
    fg: "#222222",
    nodeBg: "#fdfdfd", // near-white "card" fill; borders (the grays below) carry category

    black: "#222222",
    red: "#2b2b2b",
    green: "#555555",
    yellow: "#707070",
    blue: "#3a3a3a",
    magenta: "#4a4a4a",
    cyan: "#606060",
    white: "#e8e8e8",
    brBlack: "#8a8a8a",
    brRed: "#2b2b2b",
    brGreen: "#555555",
    brYellow: "#707070",
    brBlue: "#333333",
    brMagenta: "#5a5a5a",
    brCyan: "#606060",
    brWhite: "#f0f0f0",
  },
};

export const DEFAULT_SCHEME = "afterglow";
