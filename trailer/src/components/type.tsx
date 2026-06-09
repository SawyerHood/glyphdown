import React from "react";
import { interpolate } from "remotion";
import { COLORS } from "../theme";

/**
 * Deterministic typewriter — count of characters revealed by `frame`.
 * Per the Remotion text-animations rule: slice the string, never per-char
 * opacity. `start` is the frame typing begins; `cps` = chars per second.
 */
export function typedCount(
  frame: number,
  start: number,
  length: number,
  fps: number,
  cps: number,
): number {
  if (frame < start) return 0;
  const chars = Math.floor(((frame - start) / fps) * cps);
  return Math.max(0, Math.min(length, chars));
}

/** A blinking text caret (no CSS animation — frame-driven opacity). */
export const Caret: React.FC<{
  frame: number;
  color?: string;
  height?: number;
  blink?: number; // frames per full blink cycle
}> = ({ frame, color = COLORS.ink, height = 34, blink = 18 }) => {
  const opacity = interpolate(
    frame % blink,
    [0, blink / 2, blink],
    [1, 0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (
    <span
      style={{
        display: "inline-block",
        width: 2,
        height,
        background: color,
        marginLeft: 1,
        transform: "translateY(0.14em)",
        opacity,
      }}
    />
  );
};
