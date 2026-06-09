import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { COLORS, SPRING, MONO } from "../theme";
import { EditorChrome } from "../components/EditorChrome";
import { Heading, Para, Bullet } from "../components/markdown";
import { Terminal, TermLine } from "../components/Terminal";
import { typedCount } from "../components/type";

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

// Authentic Glyphdown CLI output — strings taken verbatim from
// packages/cli/src/program.ts (clone result line, sync labels, push --suggest).
const CLONE = "glyphdown clone";
const SUGGEST = 'glyphdown push roadmap.md --suggest -m "tighten roadmap"';
const LINES: TermLine[] = [
  { kind: "cmd", text: CLONE },
  { kind: "out", text: "cloned 3 folder(s), 12 doc(s) → ./glyphdown", color: COLORS.termText },
  { kind: "dim", text: "workspace recorded in .glyphdown/workspace.json" },
  { kind: "blank" },
  { kind: "cmd", text: SUGGEST },
  { kind: "out", text: "suggestion 7c2f created (version a91e)", color: COLORS.green },
  { kind: "dim", text: "base unchanged — re-pull after the suggestion is reviewed" },
];

// Frame plan (scene-local). Terminal slides in, types two commands, prints out.
const TERM_IN = 6;
const CLONE_TYPE = 18; // start typing `glyphdown clone`
const CLONE_OUT = CLONE_TYPE + Math.ceil((CLONE.length / 26) * 30) + 6; // ~ frame 41
const SUGGEST_TYPE = CLONE_OUT + 22; // ~63
const SUGGEST_OUT = SUGGEST_TYPE + Math.ceil((SUGGEST.length / 40) * 30) + 6;

// Doc suggestion appears after the push lands, then Accept is clicked.
const SUGG_IN = SUGGEST_OUT + 8; // green ins + card appear
const CLICK_AT = SUGG_IN + 40; // cursor clicks Accept
const ACCEPTED = CLICK_AT + 6;

const INS_TEXT = " — clone, sync, and push edits from your terminal.";

/**
 * Scene 4 — the differentiator. A terminal slides in beside the doc, runs the
 * real `glyphdown clone` + `glyphdown push --suggest`, and a reviewable
 * SUGGESTION lands in the doc (green inserted text + a "Claude · run by you"
 * card). A cursor clicks Accept and the insert turns to normal ink.
 */
export const AgentBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const stage = spring({ frame, fps, config: SPRING, durationInFrames: 18 });

  // Terminal slides in from the right.
  const termP = spring({
    frame: frame - TERM_IN,
    fps,
    config: { damping: 20, mass: 0.8, stiffness: 120 },
    durationInFrames: 24,
  });
  const termX = interpolate(termP, [0, 1], [620, 0]);

  // Which terminal lines are visible + typing progress on the active command.
  let visible = -1;
  let cmdChars: number | undefined;
  if (frame >= CLONE_TYPE) {
    visible = 0;
    cmdChars = typedCount(frame, CLONE_TYPE, CLONE.length, fps, 26);
  }
  if (frame >= CLONE_OUT) visible = 2; // out + dim
  if (frame >= CLONE_OUT + 6) visible = 3; // blank
  if (frame >= SUGGEST_TYPE) {
    visible = 4;
    cmdChars = typedCount(frame, SUGGEST_TYPE, SUGGEST.length, fps, 40);
  }
  if (frame >= SUGGEST_OUT) {
    visible = 6;
    cmdChars = undefined;
  }
  const caretBlink = interpolate(frame % 18, [0, 9, 18], [1, 0.1, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Doc-side suggestion reveal + accept.
  const suggIn = interpolate(frame, [SUGG_IN, SUGG_IN + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });
  const accepted = frame >= ACCEPTED;
  // Card collapses on accept.
  const cardOut = interpolate(frame, [CLICK_AT, ACCEPTED + 8], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });

  // Cursor travels to the Accept button and "presses" it.
  const cursorP = interpolate(frame, [SUGG_IN + 14, CLICK_AT], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });
  const press = interpolate(frame, [CLICK_AT - 3, CLICK_AT, CLICK_AT + 4], [1, 0.86, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const exit = interpolate(
    frame,
    [durationInFrames - 12, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp" },
  );

  // Inserted text color: green while pending, ink once accepted.
  const insColor = accepted ? COLORS.ink : COLORS.green;
  const insBg = accepted ? "transparent" : COLORS.greenSoft;

  return (
    <AbsoluteFill
      style={{
        background: COLORS.bgBase,
        alignItems: "center",
        justifyContent: "center",
        opacity: exit,
      }}
    >
      <div
        style={{
          position: "relative",
          opacity: stage,
          transform: `translateY(${interpolate(stage, [0, 1], [24, 0])}px)`,
        }}
      >
        <EditorChrome
          title="roadmap"
          width={1180}
          height={760}
          avatars={[
            { initials: "K", color: COLORS.accent },
            { initials: "C", color: "#d97757" },
          ]}
        >
          <Heading level={1}>Glyphdown</Heading>
          <Para>
            A realtime markdown note editor you share with your agents.
            <span
              style={{
                background: insBg,
                color: insColor,
                borderRadius: 3,
                padding: insColor === COLORS.green ? "0 2px" : 0,
              }}
            >
              {INS_TEXT.slice(
                0,
                Math.round(
                  interpolate(suggIn, [0, 1], [0, INS_TEXT.length], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  }),
                ),
              )}
            </span>
          </Para>
          <Bullet style={{ opacity: 0.9 }}>Agents clone the workspace.</Bullet>
          <Bullet style={{ opacity: 0.9 }}>
            They push edits as reviewable suggestions.
          </Bullet>

          {/* Suggestion card — anchored bottom-left of the doc body so it
              stays clear of the terminal panel (lower-right). */}
          {suggIn > 0.01 && (
            <div
              style={{
                position: "absolute",
                left: 0,
                bottom: 4,
                width: 440,
              }}
            >
              <SuggestionCard
                reveal={suggIn}
                collapse={cardOut}
                cursorP={cursorP}
                press={press}
                accepted={accepted}
              />
            </div>
          )}
        </EditorChrome>

        {/* Terminal slides in over the lower-right, clear of the card */}
        <div
          style={{
            position: "absolute",
            right: -64,
            bottom: -54,
            width: 620,
            transform: `translateX(${termX}px)`,
            opacity: termP,
          }}
        >
          <Terminal
            lines={LINES}
            visible={visible}
            cmdChars={cmdChars}
            caretBlink={caretBlink}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

const SuggestionCard: React.FC<{
  reveal: number;
  collapse: number;
  cursorP: number;
  press: number;
  accepted: boolean;
}> = ({ reveal, collapse, cursorP, press, accepted }) => {
  const y = interpolate(reveal, [0, 1], [14, 0]);
  // Cursor path from upper-left of the card to the Accept button (right edge
  // of the 440px card, vertically centered).
  const cx = interpolate(cursorP, [0, 1], [40, 372]);
  const cy = interpolate(cursorP, [0, 1], [-54, 40]);
  return (
    <div
      style={{
        position: "relative",
        opacity: reveal * collapse,
        transform: `translateY(${y}px)`,
        width: 440,
      }}
    >
      <div
        style={{
          border: `1px solid ${COLORS.line}`,
          borderLeft: `4px solid ${COLORS.green}`,
          background: COLORS.paper,
          borderRadius: "0 12px 12px 0",
          padding: "16px 18px",
          boxShadow: "0 18px 40px -20px rgba(28,39,51,0.3)",
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 9,
            background: "#d97757",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            fontSize: 17,
            flex: "none",
          }}
        >
          C
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.ink }}>
            Claude
            <span style={{ color: COLORS.inkFaint, fontWeight: 500 }}>
              {" · run by you"}
            </span>
          </div>
          <div style={{ fontSize: 16, color: COLORS.inkSoft }}>
            suggested an edit
          </div>
        </div>
        <button
          style={{
            border: "none",
            background: COLORS.green,
            color: "#fff",
            fontFamily: MONO,
            fontSize: 16,
            fontWeight: 600,
            padding: "9px 18px",
            borderRadius: 8,
            transform: `scale(${press})`,
          }}
        >
          {accepted ? "Accepted ✓" : "Accept"}
        </button>
      </div>

      {/* the click cursor */}
      <div
        style={{
          position: "absolute",
          left: cx,
          top: cy,
          transform: `scale(${press < 1 ? 0.9 : 1})`,
          pointerEvents: "none",
        }}
      >
        <Cursor />
      </div>
    </div>
  );
};

const Cursor: React.FC = () => (
  <svg width={26} height={26} viewBox="0 0 24 24" fill="none">
    <path
      d="M5 3l14 7-6 1.5L9.5 18 5 3z"
      fill="#fff"
      stroke={COLORS.ink}
      strokeWidth={1.6}
      strokeLinejoin="round"
    />
  </svg>
);
