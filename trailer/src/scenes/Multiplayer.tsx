import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { COLORS, SPRING } from "../theme";
import { EditorChrome } from "../components/EditorChrome";
import { Heading, Para, Callout, BODY } from "../components/markdown";
import { typedCount } from "../components/type";

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

// Maya's collaborator color (a warm contrast to the blue accent).
const MAYA = "#e0556a";
const MAYA_LINE = "Let's ship the share links this week.";

/**
 * Scene 3 — multiplayer (pure motion design, no capture). A second
 * collaborator's caret + name flag joins the doc, types a line live, and the
 * presence avatars stack in. Conveys realtime — two people, one doc.
 */
export const Multiplayer: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const stage = spring({ frame, fps, config: SPRING, durationInFrames: 20 });
  const stageY = interpolate(stage, [0, 1], [30, 0]);

  // Avatar K is present from the start; Maya stacks in at ~frame 14.
  const avatarReveal = interpolate(frame, [12, 24], [0.5, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Maya's caret flies in, then types her line.
  const caretIn = spring({
    frame: frame - 16,
    fps,
    config: { damping: 16, mass: 0.7, stiffness: 150 },
    durationInFrames: 18,
  });
  const typeStart = 34;
  const n = typedCount(frame, typeStart, MAYA_LINE.length, fps, 24);
  const typed = MAYA_LINE.slice(0, n);

  // Maya caret blink (frame-driven).
  const caretBlink = interpolate(frame % 18, [0, 9, 18], [1, 0.15, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const exit = interpolate(
    frame,
    [durationInFrames - 12, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp" },
  );

  return (
    <AbsoluteFill
      style={{
        background: COLORS.bgBase,
        alignItems: "center",
        justifyContent: "center",
        opacity: exit,
      }}
    >
      <div style={{ transform: `translateY(${stageY}px)`, opacity: stage }}>
        <EditorChrome
          title="roadmap"
          avatars={[
            { initials: "K", color: COLORS.accent },
            { initials: "M", color: MAYA },
          ]}
          avatarReveal={avatarReveal}
        >
          <Heading level={1}>Glyphdown</Heading>
          <Para>
            A realtime markdown note editor you share with your team —
            everyone edits the same paper, live.
          </Para>

          <Heading level={3} style={{ marginTop: 18 }}>
            This week
          </Heading>

          {/* Maya's caret + name flag + her live-typed line */}
          <Para style={{ position: "relative" }}>
            <span>{typed}</span>
            <span
              style={{
                position: "relative",
                display: "inline-block",
                width: 2.5,
                height: BODY,
                background: MAYA,
                marginLeft: 2,
                transform: "translateY(0.16em)",
                opacity:
                  frame >= 16 ? (n < MAYA_LINE.length ? 1 : caretBlink) : 0,
              }}
            >
              {/* name flag */}
              <span
                style={{
                  position: "absolute",
                  top: -26,
                  left: -2,
                  background: MAYA,
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: "5px 5px 5px 0",
                  whiteSpace: "nowrap",
                  opacity: caretIn,
                  transform: `translateY(${interpolate(caretIn, [0, 1], [8, 0])}px)`,
                }}
              >
                Maya
              </span>
            </span>
          </Para>

          <Callout
            title="Realtime"
            color={COLORS.accent}
            enter={interpolate(frame, [40, 56], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: easeOut,
            })}
          >
            Cursors, selections, and presence — no save button, no merge
            conflicts.
          </Callout>
        </EditorChrome>
      </div>
    </AbsoluteFill>
  );
};
