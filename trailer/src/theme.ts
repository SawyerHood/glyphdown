import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadSerif } from "@remotion/google-fonts/SourceSerif4";

// Load only the weights/subsets the trailer uses — keeps the render light and
// blocks until the glyphs are ready (Remotion google-fonts contract).
export const { fontFamily: inter } = loadInter("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

export const { fontFamily: serif } = loadSerif("normal", {
  weights: ["600", "700"],
  subsets: ["latin"],
});

// Mono stack for the terminal beat and inline `code` chips (matches the
// editor package's `mono` constant in packages/editor/src/theme.ts).
export const MONO =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

// Glyphdown's own palette (apps/web/src/styles.css). Paper / ink / one accent.
export const COLORS = {
  ink: "#1c2733",
  inkSoft: "#51606e",
  inkFaint: "#8b97a3",
  paper: "#ffffff",
  paperSoft: "#f4f5f7",
  bgBase: "#eef0f3",
  line: "rgba(28, 39, 51, 0.14)",
  accent: "#2563eb",
  accentDeep: "#1d4ed8",
  accentSoft: "rgba(37, 99, 235, 0.1)",
  // Suggestion / success green — the editor's `ins` diff highlight
  // (.ink-diff ins => rgba(34,197,94,.18)) and callout-success #08b94e.
  green: "#16a34a",
  greenSoft: "rgba(34, 197, 94, 0.18)",
  // Terminal surface (dark ink panel that slides over the paper).
  termBg: "#10151b",
  termBar: "#1c2530",
  termText: "#e6ebf0",
  termDim: "#7c8794",
} as const;

// One shared spring config so motion feels cohesive across scenes.
export const SPRING = { damping: 200, mass: 0.7, stiffness: 120 } as const;
export const SPRING_POP = { damping: 14, mass: 0.7, stiffness: 140 } as const;
