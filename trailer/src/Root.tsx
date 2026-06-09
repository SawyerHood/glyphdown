import "./index.css";
import React from "react";
import { AbsoluteFill, Composition } from "remotion";
import { Trailer, TRAILER_DURATION } from "./Composition";
import { COLORS } from "./theme";

/**
 * The 1:1 social cut. The trailer is composed at 1920x1080; for the square we
 * scale the frame UP so the content fills the square's width comfortably, then
 * crop the overflow with overflow:hidden. This only ever crops the empty top/
 * bottom margins of the 16:9 frame — every scene centers its card/lockup with
 * generous vertical margin, so no beat, caption, or callout is clipped (the
 * full-doc beat is the tallest and stays inside the safe band). The background
 * matches the scenes' bgBase so there is no seam.
 */
const SquareTrailer: React.FC = () => {
  // Fill the square width (1080/1920 ≈ 0.5625) and then push past it so the
  // landscape card occupies most of the square; 0.72 keeps the editor chrome's
  // top bar and the tallest callout inside the 1080 height.
  const scale = 0.72;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bgBase,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: 1920,
          height: 1080,
          transform: `scale(${scale})`,
          transformOrigin: "center center",
        }}
      >
        <Trailer />
      </div>
    </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Trailer"
        component={Trailer}
        durationInFrames={TRAILER_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="TrailerSquare"
        component={SquareTrailer}
        durationInFrames={TRAILER_DURATION}
        fps={30}
        width={1080}
        height={1080}
      />
    </>
  );
};
