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
import { typedCount, Caret } from "../components/type";

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const LINE = "A realtime markdown editor";

/**
 * Scene 2 — title card. The wordmark mark draws in, "Glyphdown" sets in the
 * serif display face, and the tagline line types on. Paper background.
 */
export const TitleCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const logoSpring = spring({
    frame: frame - 2,
    fps,
    config: SPRING_POP,
    durationInFrames: 26,
  });
  const draw = interpolate(frame, [4, 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });

  const wordOpacity = interpolate(frame, [14, 28], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });
  const wordY = interpolate(frame, [14, 30], [18, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });

  // Tagline types on.
  const typeStart = 30;
  const n = typedCount(frame, typeStart, LINE.length, fps, 26);
  const typing = frame >= typeStart && n < LINE.length;

  const exit = interpolate(
    frame,
    [durationInFrames - 10, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp" },
  );

  return (
    <AbsoluteFill
      style={{
        background: COLORS.paper,
        alignItems: "center",
        justifyContent: "center",
        opacity: exit,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 30,
        }}
      >
        <div style={{ transform: `scale(${interpolate(logoSpring, [0, 1], [0.7, 1])})` }}>
          <Logo size={130} draw={draw} />
        </div>
        <div
          style={{
            fontFamily: serif,
            fontWeight: 700,
            fontSize: 96,
            color: COLORS.ink,
            letterSpacing: "-0.02em",
            opacity: wordOpacity,
            transform: `translateY(${wordY}px)`,
          }}
        >
          Glyphdown
        </div>
        {frame >= typeStart && (
          <div
            style={{
              fontFamily: inter,
              fontWeight: 500,
              fontSize: 38,
              color: COLORS.inkSoft,
              letterSpacing: "0.01em",
            }}
          >
            {LINE.slice(0, n)}
            {typing && (
              <Caret frame={frame} color={COLORS.inkSoft} height={36} />
            )}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
