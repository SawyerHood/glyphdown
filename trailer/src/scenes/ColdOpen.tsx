import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { COLORS, SPRING, SPRING_POP } from "../theme";
import { EditorChrome } from "../components/EditorChrome";
import {
  Heading,
  Para,
  Bold,
  Code,
  Task,
  Bullet,
  BODY,
} from "../components/markdown";
import { typedCount, Caret } from "../components/type";

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

// The cold-open sentence — rendered with inline **bold** and `code`.
const PART_A = "Plain ";
const PART_BOLD = ".md files";
const PART_B = ", an Obsidian-style ";
const CODE = "live preview";
const PART_C = ", real-time multiplayer.";
const FULL_LEN =
  PART_A.length + PART_BOLD.length + PART_B.length + CODE.length + PART_C.length;

/**
 * Scene 1 — the hook. A markdown doc writes itself: the H1 springs in, a
 * sentence types on with inline bold/code rendering live, then a task list
 * checkbox ticks off. Pure motion + type so it reads with sound muted.
 */
export const ColdOpen: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Whole stage rises in on a calm spring.
  const stage = spring({ frame, fps, config: SPRING, durationInFrames: 28 });
  const stageY = interpolate(stage, [0, 1], [50, 0]);

  // H1 pops in slightly after the stage settles.
  const h1 = spring({
    frame: frame - 10,
    fps,
    config: SPRING_POP,
    durationInFrames: 26,
  });
  const h1Y = interpolate(h1, [0, 1], [22, 0]);

  // Typing the sentence (starts ~frame 26).
  const typeStart = 26;
  const n = typedCount(frame, typeStart, FULL_LEN, fps, 30);
  const typing = frame >= typeStart && n < FULL_LEN;

  // Build the partially-typed rich sentence.
  const sentence = renderTyped(n);

  // After typing, the task block reveals, then the box checks off.
  const sentenceDone = typeStart + Math.ceil((FULL_LEN / 30) * fps);
  const taskReveal = spring({
    frame: frame - (sentenceDone + 4),
    fps,
    config: SPRING,
    durationInFrames: 22,
  });
  const checkAt = sentenceDone + 30;
  const checked = interpolate(frame, [checkAt, checkAt + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });

  return (
    <AbsoluteFill
      style={{
        background: COLORS.bgBase,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ transform: `translateY(${stageY}px)`, opacity: stage }}>
        <EditorChrome
          title="roadmap"
          avatars={[{ initials: "K", color: COLORS.accent }]}
        >
          <div style={{ opacity: h1, transform: `translateY(${h1Y}px)` }}>
            <Heading level={1}>Glyphdown</Heading>
          </div>

          {frame >= typeStart && (
            <Para>
              {sentence}
              {typing && <Caret frame={frame} height={BODY} />}
            </Para>
          )}

          <div
            style={{
              opacity: taskReveal,
              transform: `translateY(${interpolate(taskReveal, [0, 1], [16, 0])}px)`,
              marginTop: 18,
            }}
          >
            <Bullet>Notes that live as files, not lock-in.</Bullet>
            <Task checked={checked}>Make notes agent-readable</Task>
          </div>
        </EditorChrome>
      </div>
    </AbsoluteFill>
  );
};

/** Reconstruct the rich sentence showing only the first `n` characters. */
function renderTyped(n: number): React.ReactNode {
  let i = n;
  const take = (s: string) => {
    const part = s.slice(0, Math.max(0, i));
    i -= s.length;
    return part;
  };
  const a = take(PART_A);
  const b = take(PART_BOLD);
  const c = take(PART_B);
  const d = take(CODE);
  const e = take(PART_C);
  return (
    <>
      {a}
      {b && <Bold>{b}</Bold>}
      {c}
      {d && <Code>{d}</Code>}
      {e}
    </>
  );
}
