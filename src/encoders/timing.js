/**
 * Loop timing — a direct port of spin3d/encoder.py and frame_angles().
 *
 * This is what makes a spin loop seamless, and it is deliberately a
 * line-for-line port rather than a re-derivation:
 *
 *  - Frame i sits at exactly i * 360/N degrees, so the last frame steps into
 *    the first with no repeated pose and no stutter.
 *  - Frame delays are rounded onto the container's own grid with the rounding
 *    error carried forward, so 48 frames at 0.25 rounds/s totals exactly
 *    4.000 s instead of drifting.
 */

// GIF stores delays in hundredths of a second; WebP and APNG do milliseconds.
export const DELAY_GRID_MS = { gif: 10, webp: 1, apng: 1 };

// Past this, browsers and viewers stop honouring the requested delays.
export const FPS_LIMIT = 50.0;

/**
 * Round half to even, the way Python's round() does.
 *
 * This matters more than it looks: 8 frames at 1 round/s puts a target exactly
 * on 12.5 grid units. Math.round gives 13 (130 ms), Python gives 12 (120 ms).
 * Matching Python keeps web output identical in timing to the desktop app's,
 * which is what lets the two be compared frame for frame.
 */
export function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Per-frame delays in ms, rounded onto the format's grid without drifting. */
export function frameDelaysMs(nFrames, rps, fmt = 'gif') {
  const grid = DELAY_GRID_MS[fmt] ?? 10;
  const n = Math.max(1, Math.floor(nFrames));
  const total = 1000.0 / Math.max(1e-6, rps);
  const delays = [];
  let elapsed = 0;
  for (let i = 0; i < n; i++) {
    const target = (total * (i + 1)) / n;
    const step = Math.max(grid, roundHalfToEven((target - elapsed) / grid) * grid);
    delays.push(step);
    elapsed += step;
  }
  return delays;
}

/** What the animation will actually do once delays are quantised. */
export function loopSummary(nFrames, rps, fmt = 'gif') {
  const delays = frameDelaysMs(nFrames, rps, fmt);
  const totalMs = delays.reduce((a, b) => a + b, 0);
  return {
    delays,
    totalMs,
    actualRps: totalMs ? 1000 / totalMs : 0,
    fps: totalMs ? (1000 * delays.length) / totalMs : 0,
    tooFast: totalMs ? (1000 * delays.length) / totalMs > FPS_LIMIT : false,
  };
}

/** Angles for exactly one seamless revolution (the last frame is not 360). */
export function frameAngles(nFrames, clockwise = true, start = 0) {
  const n = Math.max(1, Math.floor(nFrames));
  const step = 360 / n;
  const sign = clockwise ? -1 : 1;
  return Array.from({ length: n }, (_, i) => start + sign * step * i);
}
