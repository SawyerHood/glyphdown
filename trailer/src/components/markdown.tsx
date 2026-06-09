import React from "react";
import { interpolate, Easing } from "remotion";
import { COLORS, MONO } from "../theme";

/**
 * Rendered-markdown primitives. These recreate Glyphdown's live-preview LOOK
 * (the editor's typography pass) — NOT raw markdown. Sizes/weights/rhythm are
 * lifted from packages/editor/src/theme.ts:
 *   body 17px / line-height 1.65, h1 1.9em/700 (anchor rule), h2 1.5em/700,
 *   h3 1.25em/600, bullet •, accent-colored callout title.
 * Scaled up 2x for 1080p legibility (BODY = 34px).
 */
export const BODY = 34;
export const docFont =
  "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

/** A heading line with the editor's per-level scale + h1/h2 anchor rule. */
export const Heading: React.FC<{
  level: 1 | 2 | 3;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ level, children, style }) => {
  const scale = { 1: 1.9, 2: 1.5, 3: 1.25 }[level];
  const weight = level === 3 ? 600 : 700;
  const tracking = { 1: "-0.02em", 2: "-0.015em", 3: "-0.01em" }[level];
  const rule = level !== 3;
  return (
    <div
      style={{
        fontSize: BODY * scale,
        fontWeight: weight,
        lineHeight: 1.22,
        letterSpacing: tracking,
        color: COLORS.ink,
        paddingBottom: rule ? "0.2em" : 0,
        borderBottom: rule ? `1px solid ${COLORS.line}` : "none",
        margin: level === 1 ? "0 0 0.35em" : "0.7em 0 0.25em",
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** Inline markdown spans: **bold** and `code` rendered, not raw. */
export const Bold: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <strong style={{ fontWeight: 700, color: COLORS.ink }}>{children}</strong>
);

export const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <code
    style={{
      fontFamily: MONO,
      fontSize: "0.88em",
      background: "rgba(81, 96, 110, 0.14)",
      borderRadius: 5,
      padding: "1px 6px",
      color: COLORS.ink,
    }}
  >
    {children}
  </code>
);

/** A body paragraph. */
export const Para: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <p
    style={{
      fontSize: BODY,
      lineHeight: 1.65,
      color: COLORS.ink,
      margin: "0.55em 0",
      ...style,
    }}
  >
    {children}
  </p>
);

/** A bullet list item with the editor's • marker + hanging indent. */
export const Bullet: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div
    style={{
      display: "flex",
      gap: 14,
      fontSize: BODY,
      lineHeight: 1.55,
      color: COLORS.ink,
      margin: "0.18em 0",
      ...style,
    }}
  >
    <span style={{ color: COLORS.inkFaint, lineHeight: 1.55 }}>•</span>
    <span style={{ flex: 1 }}>{children}</span>
  </div>
);

/**
 * A task list item with a checkbox. `checked` 0..1 drives the tick draw + the
 * label's strike/fade as it toggles. Deterministic — driven by the caller.
 */
export const Task: React.FC<{
  checked: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ checked, children, style }) => {
  const box = 26;
  const fill = interpolate(checked, [0, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const dash = 22;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        fontSize: BODY,
        lineHeight: 1.55,
        margin: "0.2em 0",
        ...style,
      }}
    >
      <span
        style={{
          width: box,
          height: box,
          flex: "none",
          borderRadius: 7,
          border: `2px solid ${fill > 0.02 ? COLORS.accent : COLORS.inkFaint}`,
          background: `rgba(37, 99, 235, ${0.12 * fill})`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width={box - 8} height={box - 8} viewBox="0 0 18 18" fill="none">
          <path
            d="M3 9.5 L7.2 13.5 L15 5"
            stroke={COLORS.accent}
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={dash}
            strokeDashoffset={dash * (1 - fill)}
          />
        </svg>
      </span>
      <span
        style={{
          color: fill > 0.5 ? COLORS.inkFaint : COLORS.ink,
          textDecoration: fill > 0.5 ? "line-through" : "none",
          textDecorationColor: COLORS.inkFaint,
        }}
      >
        {children}
      </span>
    </div>
  );
};

/** An Obsidian-style callout box (accent-colored title, tinted body). */
export const Callout: React.FC<{
  title: string;
  children: React.ReactNode;
  enter?: number; // 0..1 reveal
  color?: string;
  icon?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ title, children, enter = 1, color = "#086ddd", icon, style }) => {
  const y = interpolate(enter, [0, 1], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });
  return (
    <div
      style={{
        borderLeft: `4px solid ${color}`,
        background: `color-mix(in srgb, ${color} 7%, ${COLORS.paper})`,
        borderRadius: "0 10px 10px 0",
        padding: "18px 22px",
        margin: "0.7em 0",
        opacity: enter,
        transform: `translateY(${y}px)`,
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          color,
          fontWeight: 700,
          fontSize: BODY * 0.94,
          marginBottom: 6,
        }}
      >
        {icon ?? <InfoGlyph color={color} />}
        {title}
      </div>
      <div style={{ fontSize: BODY * 0.95, lineHeight: 1.55, color: COLORS.ink }}>
        {children}
      </div>
    </div>
  );
};

const InfoGlyph: React.FC<{ color: string }> = ({ color }) => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" />
    <path d="M12 11v5" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
    <circle cx="12" cy="7.6" r="1.3" fill={color} />
  </svg>
);

/** A small rendered table (header row + body) matching the editor's look. */
export const Table: React.FC<{
  head: string[];
  rows: string[][];
  style?: React.CSSProperties;
}> = ({ head, rows, style }) => (
  <div
    style={{
      border: `1px solid ${COLORS.line}`,
      borderRadius: 10,
      overflow: "hidden",
      margin: "0.6em 0",
      fontSize: BODY * 0.86,
      ...style,
    }}
  >
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${head.length}, 1fr)`,
        background: COLORS.paperSoft,
        fontWeight: 700,
        color: COLORS.ink,
      }}
    >
      {head.map((h, i) => (
        <div key={i} style={{ padding: "10px 16px" }}>
          {h}
        </div>
      ))}
    </div>
    {rows.map((row, ri) => (
      <div
        key={ri}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${head.length}, 1fr)`,
          borderTop: `1px solid ${COLORS.line}`,
          color: COLORS.inkSoft,
        }}
      >
        {row.map((c, ci) => (
          <div key={ci} style={{ padding: "10px 16px" }}>
            {c}
          </div>
        ))}
      </div>
    ))}
  </div>
);
