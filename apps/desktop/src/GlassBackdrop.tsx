import type { CSSProperties } from "react";
import { BACKDROP_PALETTES } from "./interface-style";

/**
 * The window behind the glass: the illustrated backdrop of the glass style (the night landscape of the
 * approved design), drawn under everything else while no picture of the person's own shows and no
 * system effect (Mica, Acrylic) is behind the window. The sidebar and the panels are glass over it, and
 * the same blur control of the settings that softens a picture softens it. It is a picture of colors
 * made of boxes and clip paths (nothing is fetched), it takes no click and a screen reader skips it; the
 * stylesheet paints it (`.glass-backdrop` in styles.css), a dark landscape for a dark theme and a light
 * one for a light theme.
 */

/** The stars of the sky: where each is (left and top, in percent of the window), how big and how bright. */
const STARS: readonly { left: number; top: number; size: number; opacity: number }[] = [
  { left: 12, top: 14, size: 3, opacity: 1 },
  { left: 31, top: 7, size: 2, opacity: 1 },
  { left: 47, top: 19, size: 3, opacity: 0.8 },
  { left: 63, top: 5, size: 2, opacity: 1 },
  { left: 72, top: 26, size: 2, opacity: 0.7 },
  { left: 89, top: 33, size: 3, opacity: 1 },
];

export function GlassBackdrop({ kind }: { kind: "dark" | "light" }) {
  const palette = BACKDROP_PALETTES[kind];
  const colors = {
    "--glass-base": palette.base,
    "--glass-sky": palette.sky,
    "--glass-moon": palette.moon,
    "--glass-star": palette.star,
    "--glass-far": palette.far,
    "--glass-middle": palette.middle,
    "--glass-near": palette.near,
  } as CSSProperties;
  return (
    <div className="glass-backdrop" data-nr-part="glass-backdrop" style={colors} aria-hidden="true">
      <div className="glass-backdrop-sky" />
      <div className="glass-backdrop-moon" />
      {STARS.map((star) => (
        <span
          key={`${star.left}-${star.top}`}
          className="glass-backdrop-star"
          style={{
            left: `${star.left}%`,
            top: `${star.top}%`,
            width: star.size,
            height: star.size,
            opacity: star.opacity,
          }}
        />
      ))}
      <div className="glass-backdrop-ridge" data-nr-ridge="far" />
      <div className="glass-backdrop-ridge" data-nr-ridge="middle" />
      <div className="glass-backdrop-ridge" data-nr-ridge="near" />
    </div>
  );
}
