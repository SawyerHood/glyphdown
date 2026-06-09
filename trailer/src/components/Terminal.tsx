import React from "react";
import { COLORS, MONO } from "../theme";

/**
 * A dark terminal panel that slides over the paper for the agent beat.
 * Lines are revealed by the parent (each line carries a `show` flag); typed
 * commands carry a `typed` substring. All authentic Glyphdown CLI output
 * (command names + result strings lifted from packages/cli/src/program.ts).
 */
export type TermLine =
  | { kind: "cmd"; text: string }
  | { kind: "out"; text: string; color?: string }
  | { kind: "dim"; text: string }
  | { kind: "blank" };

export const Terminal: React.FC<{
  title?: string;
  lines: TermLine[];
  /** index of the last visible line; the last cmd line shows `chars` chars. */
  visible: number;
  cmdChars?: number;
  caretBlink?: number;
  style?: React.CSSProperties;
}> = ({ title = "agent — zsh", lines, visible, cmdChars, caretBlink = 1, style }) => {
  return (
    <div
      style={{
        background: COLORS.termBg,
        borderRadius: 14,
        border: `1px solid rgba(230,235,240,0.08)`,
        boxShadow: "0 40px 90px -28px rgba(0,0,0,0.6)",
        overflow: "hidden",
        fontFamily: MONO,
        ...style,
      }}
    >
      <div
        style={{
          height: 44,
          background: COLORS.termBar,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 8,
        }}
      >
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span
            key={c}
            style={{ width: 12, height: 12, borderRadius: "50%", background: c }}
          />
        ))}
        <span
          style={{
            marginLeft: 10,
            color: COLORS.termDim,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {title}
        </span>
      </div>
      <div style={{ padding: "20px 24px", fontSize: 21, lineHeight: 1.55 }}>
        {lines.map((line, i) => {
          if (i > visible) return null;
          const isLast = i === visible;
          if (line.kind === "blank") return <div key={i} style={{ height: "0.8em" }} />;
          if (line.kind === "cmd") {
            const text =
              isLast && cmdChars !== undefined ? line.text.slice(0, cmdChars) : line.text;
            const stillTyping = isLast && cmdChars !== undefined && cmdChars < line.text.length;
            return (
              <div key={i} style={{ color: COLORS.termText }}>
                <span style={{ color: COLORS.green }}>$ </span>
                {text}
                {stillTyping && (
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: "1.1em",
                      background: COLORS.termText,
                      transform: "translateY(0.18em)",
                      marginLeft: 1,
                      opacity: caretBlink,
                    }}
                  />
                )}
              </div>
            );
          }
          const color =
            line.kind === "dim" ? COLORS.termDim : line.color ?? COLORS.termText;
          return (
            <div key={i} style={{ color }}>
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
};
