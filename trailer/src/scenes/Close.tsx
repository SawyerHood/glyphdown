import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { COLORS, serif, inter, SPRING_POP } from "../theme";
import { Logo } from "../components/Logo";

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

/**
 * Scene 5 — close. The square-pen wordmark lockup, the tagline, and the URL,
 * all on the paper background. A clean, held end frame.
 */
export const Close: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoSpring = spring({
    frame: frame - 2,
    fps,
    config: SPRING_POP,
    durationInFrames: 24,
  });
  const draw = interpolate(frame, [4, 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });

  const word = interpolate(frame, [10, 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });

  const tagline = interpolate(frame, [24, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });

  const url = interpolate(frame, [40, 54], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });

  return (
    <AbsoluteFill
      style={{
        background: COLORS.paper,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 34,
        }}
      >
        {/* wordmark lockup: mark + serif word, side by side */}
        <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
          <div
            style={{
              transform: `scale(${interpolate(logoSpring, [0, 1], [0.7, 1])})`,
            }}
          >
            <Logo size={108} draw={draw} />
          </div>
          <div
            style={{
              fontFamily: serif,
              fontWeight: 700,
              fontSize: 104,
              color: COLORS.ink,
              letterSpacing: "-0.02em",
              opacity: word,
              transform: `translateX(${interpolate(word, [0, 1], [-16, 0])}px)`,
            }}
          >
            Glyphdown
          </div>
        </div>

        <div
          style={{
            fontFamily: inter,
            fontWeight: 600,
            fontSize: 44,
            color: COLORS.ink,
            letterSpacing: "-0.01em",
            opacity: tagline,
            transform: `translateY(${interpolate(tagline, [0, 1], [14, 0])}px)`,
            textAlign: "center",
          }}
        >
          Sync your notes.{" "}
          <span style={{ color: COLORS.accent }}>Send in your agents.</span>
        </div>

        <div
          style={{
            fontFamily: inter,
            fontWeight: 600,
            fontSize: 28,
            color: COLORS.inkFaint,
            letterSpacing: "0.04em",
            opacity: url,
            marginTop: 6,
          }}
        >
          glyphdown.com
        </div>
      </div>
    </AbsoluteFill>
  );
};
