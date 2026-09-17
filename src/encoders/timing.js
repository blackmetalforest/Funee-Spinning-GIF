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

/*
 * A stopped spin — zero speed, or zero frames per second — is a single still.
 * The delay no longer means anything, but it still has to be a number the
 * containers can hold: GIF stores hundredths of a second in 16 bits, so a
 * delay derived from 1/0 would wrap to something arbitrary rather than simply
 * being ignored.
 */
export const STILL_DELAY_MS = 1000;

/** Per-frame delays in ms, rounded onto the format's grid without drifting. */
export function frameDelaysMs(nFrames, rps, fmt = 'gif') {
  const grid = DELAY_GRID_MS[fmt] ?? 10;
  const n = Math.max(1, Math.floor(nFrames));
  if (!(rps > 0)) return new Array(n).fill(STILL_DELAY_MS);
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

/**
 * Cumulative start offset of each frame, plus the total. Feeds frameIndexAt().
 */
export function frameStarts(delays) {
  const starts = new Array(delays.length);
  let elapsed = 0;
  for (let i = 0; i < delays.length; i++) {
    starts[i] = elapsed;
    elapsed += delays[i];
  }
  return { starts, totalMs: elapsed };
}

/**
 * Which frame is on screen `t` ms into the loop.
 *
 * The live preview asks this once per animation frame rather than counting
 * frames as they pass, which is what keeps it honest when it cannot keep up: a
 * backgrounded tab (requestAnimationFrame stops entirely), a target rate above
 * the display's refresh, or a single frame overrunning its budget all land on
 * the pose that belongs to the current clock instead of drifting behind by
 * however much was missed. `t` is wrapped, so any elapsed time is valid.
 */
export function frameIndexAt(starts, totalMs, t) {
  if (!starts.length) return 0;
  if (!(totalMs > 0)) return 0;
  let time = t % totalMs;
  if (time < 0) time += totalMs;                 // negative elapsed, just in case
  // Binary search for the last frame starting at or before `time`.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Angles for exactly one seamless revolution (the last frame is not 360). */
export function frameAngles(nFrames, clockwise = true, start = 0) {
  const n = Math.max(1, Math.floor(nFrames));
  const step = 360 / n;
  const sign = clockwise ? -1 : 1;
  return Array.from({ length: n }, (_, i) => start + sign * step * i);
}
