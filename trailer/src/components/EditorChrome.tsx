import React from "react";
import { COLORS } from "../theme";
import { Logo } from "./Logo";

/** Stacked presence avatars (right of the title bar). */
export const Avatars: React.FC<{
  people: { initials: string; color: string }[];
  reveal?: number; // 0..1 — how many avatars are shown (for the multiplayer beat)
}> = ({ people, reveal = 1 }) => {
  const shown = Math.round(reveal * people.length);
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {people.slice(0, shown).map((p, i) => (
        <div
          key={i}
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: p.color,
            border: `2.5px solid ${COLORS.paper}`,
            marginLeft: i === 0 ? 0 : -12,
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: people.length - i,
            boxShadow: "0 1px 3px rgba(28,39,51,0.18)",
          }}
        >
          {p.initials}
        </div>
      ))}
    </div>
  );
};

/**
 * The paper editor window: rounded card, top bar (traffic dots + Glyphdown
 * mark + doc title + live-preview chip + presence avatars), and a body slot.
 * This is the recurring "stage" the document scenes play inside.
 */
export const EditorChrome: React.FC<{
  title: string;
  children: React.ReactNode;
  avatars?: { initials: string; color: string }[];
  avatarReveal?: number;
  width?: number;
  height?: number;
  style?: React.CSSProperties;
}> = ({
  title,
  children,
  avatars = [],
  avatarReveal = 1,
  width = 1180,
  height = 760,
  style,
}) => {
  return (
    <div
      style={{
        width,
        height,
        background: COLORS.paper,
        borderRadius: 18,
        border: `1px solid ${COLORS.line}`,
        boxShadow:
          "0 40px 90px -30px rgba(28,39,51,0.35), 0 8px 24px -12px rgba(28,39,51,0.18)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        ...style,
      }}
    >
      {/* title bar */}
      <div
        style={{
          height: 64,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "0 22px",
          borderBottom: `1px solid ${COLORS.line}`,
          background: "rgba(255,255,255,0.9)",
        }}
      >
        <div style={{ display: "flex", gap: 9 }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <span
              key={c}
              style={{ width: 13, height: 13, borderRadius: "50%", background: c }}
            />
          ))}
        </div>
        <div style={{ marginLeft: 6 }}>
          <Logo size={28} />
        </div>
        <div
          style={{
            fontWeight: 600,
            fontSize: 19,
            color: COLORS.ink,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {title}
          <span style={{ color: COLORS.inkFaint, fontWeight: 400, fontSize: 16 }}>
            .md
          </span>
        </div>
        <div
          style={{
            marginLeft: 4,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: COLORS.accent,
            background: COLORS.accentSoft,
            padding: "4px 10px",
            borderRadius: 999,
          }}
        >
          Live preview
        </div>
        <div style={{ flex: 1 }} />
        <Avatars people={avatars} reveal={avatarReveal} />
      </div>
      {/* body — the prose column */}
      <div
        style={{
          flex: 1,
          padding: "44px 90px",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div style={{ maxWidth: 720, margin: "0 auto", height: "100%" }}>
          {children}
        </div>
      </div>
    </div>
  );
};
