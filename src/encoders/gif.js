/**
 * GIF export — mirrors write_gif() in spin3d/encoder.py.
 *
 * The important part is the *single shared palette*. Quantising each frame on
 * its own makes flat surfaces shimmer between frames — the colours crawl as the
 * palette is re-derived. Deriving one palette from a sample of all frames and
 * applying it to every frame keeps flat areas flat.
 *
 * gifenc is used precisely because it separates quantize() from applyPalette(),
 * which is exactly that model. Most JS GIF encoders quantise per frame.
 */

import { GIFEncoder, quantize, applyPalette } from '../../vendor/gifenc.esm.js';
import { loopSummary } from './timing.js';

// Alpha at or above this counts as opaque; below it becomes the clear colour.
const ALPHA_THRESHOLD = 128;

// How many frames to sample when building the shared palette. The Python
// version samples every len/16'th frame; 16 is plenty to capture the range.
const PALETTE_SAMPLES = 16;

/**
 * Flatten transparent pixels onto the matte colour before quantising.
 *
 * Without this, semi-transparent edge pixels drag odd colours into the palette
 * and the cut-out edges end up fringed.
 */
function flatten(imageData, transparent, matte) {
  const src = imageData.data;
  const rgba = new Uint8ClampedArray(src);          // copy: never mutate the store
  if (!transparent) return rgba;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < ALPHA_THRESHOLD) {
      rgba[i] = matte[0];
      rgba[i + 1] = matte[1];
      rgba[i + 2] = matte[2];
      rgba[i + 3] = 0;
    } else {
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/** Build one palette from a sample of frames, as the Python version does. */
function buildPalette(frames, colours, transparent, matte) {
  const step = Math.max(1, Math.floor(frames.length / PALETTE_SAMPLES));
  const sampled = [];
  for (let i = 0; i < frames.length; i += step) sampled.push(frames[i]);

  // Concatenate the samples into one buffer and quantise that in one pass.
  const total = sampled.reduce((n, f) => n + f.data.length, 0);
  const merged = new Uint8ClampedArray(total);
  let at = 0;
  for (const frame of sampled) {
    merged.set(flatten(frame, transparent, matte), at);
    at += frame.data.length;
  }
  return quantize(merged, colours, { format: 'rgb565' });
}

/**
 * Encode frames as a looping GIF.
 *
 * @param {ImageData[]} frames
 * @param {object} opts { rps, transparent, background:[r,g,b] }
 * @returns {{blob: Blob, info: object}}
 */
export function encodeGif(frames, opts = {}) {
  if (!frames.length) throw new Error('No frames to encode');
  const {
    rps = 0.25,
    transparent = false,
    background = [0, 0, 0],
    onProgress = null,
  } = opts;

  const info = loopSummary(frames.length, rps, 'gif');
  // One palette slot is reserved for the transparent index.
  const colours = transparent ? 255 : 256;
  const palette = buildPalette(frames, colours, transparent, background);

  const gif = GIFEncoder();
  const { width, height } = frames[0];

  frames.forEach((frame, i) => {
    const rgba = flatten(frame, transparent, background);
    const index = applyPalette(rgba, palette, 'rgb565');

    if (transparent) {
      // Point every cut-out pixel at the reserved index.
      const alpha = frame.data;
      for (let p = 0, a = 3; p < index.length; p++, a += 4) {
        if (alpha[a] < ALPHA_THRESHOLD) index[p] = colours;
      }
    }

    gif.writeFrame(index, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: info.delays[i],
      transparent,
      transparentIndex: colours,
      dispose: transparent ? 2 : 1,
      repeat: 0,                       // loop forever
      first: i === 0,
    });
    if (onProgress) onProgress(i + 1, frames.length);
  });

  gif.finish();
  return { blob: new Blob([gif.bytes()], { type: 'image/gif' }), info };
}
