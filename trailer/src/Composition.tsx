import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { COLORS, inter } from "./theme";
import { ColdOpen } from "./scenes/ColdOpen";
import { TitleCard } from "./scenes/TitleCard";
import { Multiplayer } from "./scenes/Multiplayer";
import { AgentBeat } from "./scenes/AgentBeat";
import { Close } from "./scenes/Close";

/**
 * Glyphdown launch trailer — pure motion design (no screen capture).
 * 1920x1080 / 30fps. Beat sheet (frames at 30fps):
 *   1. Cold open       0–180   (6.0s)  doc writes itself, task checks off
 *   2. Title card    180–315   (4.5s)  "A realtime markdown editor"
 *   3. Multiplayer   315–510   (6.5s)  second cursor + presence
 *   4. Agent beat    510–810  (10.0s)  terminal + reviewable suggestion
 *   5. Close         810–960   (5.0s)  wordmark lockup + tagline + URL
 * Total: 960 frames = 32.0s.
 *
 * Each scene is an absolute-fill Sequence; scenes fade their own tails so the
 * cuts read as cross-dissolves on the paper. All animation is frame-driven
 * (useCurrentFrame / interpolate / spring) — deterministic, no CSS transitions.
 */

export const SCENES = {
  coldOpen: { from: 0, duration: 180 },
  title: { from: 180, duration: 135 },
  multiplayer: { from: 315, duration: 195 },
  agent: { from: 510, duration: 300 },
  close: { from: 810, duration: 150 },
} as const;

export const TRAILER_DURATION = 960;

export const Trailer: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.paper, fontFamily: inter }}>
      <Sequence
        from={SCENES.coldOpen.from}
        durationInFrames={SCENES.coldOpen.duration}
      >
        <ColdOpen />
      </Sequence>
      <Sequence from={SCENES.title.from} durationInFrames={SCENES.title.duration}>
        <TitleCard />
      </Sequence>
      <Sequence
        from={SCENES.multiplayer.from}
        durationInFrames={SCENES.multiplayer.duration}
      >
        <Multiplayer />
      </Sequence>
      <Sequence from={SCENES.agent.from} durationInFrames={SCENES.agent.duration}>
        <AgentBeat />
      </Sequence>
      <Sequence from={SCENES.close.from} durationInFrames={SCENES.close.duration}>
        <Close />
      </Sequence>
    </AbsoluteFill>
  );
};
