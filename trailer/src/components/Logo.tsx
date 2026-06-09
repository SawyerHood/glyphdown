import React from "react";
import { COLORS } from "../theme";

/**
 * The Glyphdown mark: lucide `square-pen` glyph on the accent tile.
 * Paths copied verbatim from public/logo.svg (lucide square-pen). Drawn inline
 * so it can be color-tuned and scaled per scene without a network/asset fetch.
 */
export const Logo: React.FC<{
  size?: number;
  radius?: number;
  /** 0..1 — fraction of the pen stroke that's drawn (for a "draw-on" reveal). */
  draw?: number;
}> = ({ size = 96, radius, draw = 1 }) => {
  const r = radius ?? size * 0.22;
  // Stroke dash length large enough to cover both pen paths at this scale.
  const dash = 64;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      style={{ display: "block" }}
    >
      <rect width={64} height={64} rx={(r / size) * 64} fill={COLORS.accent} />
      <g
        transform="translate(13.5 13.5) scale(1.54)"
        fill="none"
        stroke="#ffffff"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* The document/frame — always present. */}
        <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        {/* The pen nib — can draw on via stroke-dashoffset. */}
        <path
          d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"
          strokeDasharray={dash}
          strokeDashoffset={dash * (1 - draw)}
        />
      </g>
    </svg>
  );
};
