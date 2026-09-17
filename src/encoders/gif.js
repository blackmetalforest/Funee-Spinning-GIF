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

/**
 * Map pixels onto the palette with Floyd–Steinberg error diffusion.
 *
 * gifenc has no dithering of its own — applyPalette() picks the nearest colour
 * per pixel and nothing more — so this is hand-rolled. It mirrors gifenc's own
 * performance trick: cache nearest-colour lookups in an rgb565-keyed table,
 * because the linear scan over 256 palette entries is by far the hot path.
 *
 * Error is carried on two row buffers rather than a full-image float buffer,
 * which keeps memory flat regardless of output size.
 *
 * Transparent pixels are skipped entirely: they get the transparent index and
 * neither absorb nor emit error. Diffusing across the cut-out edge would
 * scatter speckles into the transparent region and fringe the silhouette.
 */
function applyPaletteDithered(rgba, palette, width, height, transparent,
                              alphaThreshold, transparentIndex) {
  const out = new Uint8Array(width * height);
  const cache = new Array(65536);
  // Note: the palette may come back shorter than requested, so the transparent
  // index is passed in rather than derived from palette.length — otherwise it
  // could collide with a real colour slot.
  const size = palette.length;

  const nearest = (r, g, b) => {
    // Same rgb565 key gifenc uses for its cache.
    const key = ((r << 8) & 0xf800) | ((g << 2) & 0x03e0) | (b >> 3);
    const hit = cache[key];
    if (hit !== undefined) return hit;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < size; i++) {
      const p = palette[i];
      const dr = p[0] - r;
      let dist = dr * dr;
      if (dist >= bestDist) continue;
      const dg = p[1] - g;
      dist += dg * dg;
      if (dist >= bestDist) continue;
      const db = p[2] - b;
      dist += db * db;
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    cache[key] = best;
    return best;
  };

  let curr = new Float32Array(width * 3);
  let next = new Float32Array(width * 3);
  const seed = (row, target) => {
    for (let x = 0; x < width; x++) {
      const s = (row * width + x) * 4;
      target[x * 3] = rgba[s];
      target[x * 3 + 1] = rgba[s + 1];
      target[x * 3 + 2] = rgba[s + 2];
    }
  };
  seed(0, curr);

  for (let y = 0; y < height; y++) {
    if (y + 1 < height) seed(y + 1, next);
    for (let x = 0; x < width; x++) {
      const at = x * 3;
      const pixel = (y * width + x) * 4;

      if (transparent && rgba[pixel + 3] < alphaThreshold) {
        out[y * width + x] = transparentIndex;
        continue;
      }

      const r = curr[at] < 0 ? 0 : curr[at] > 255 ? 255 : curr[at];
      const g = curr[at + 1] < 0 ? 0 : curr[at + 1] > 255 ? 255 : curr[at + 1];
      const b = curr[at + 2] < 0 ? 0 : curr[at + 2] > 255 ? 255 : curr[at + 2];

      const index = nearest(r | 0, g | 0, b | 0);
      out[y * width + x] = index;

      const chosen = palette[index];
      const er = r - chosen[0];
      const eg = g - chosen[1];
      const eb = b - chosen[2];

      // Floyd–Steinberg: 7/16 right, 3/16 below-left, 5/16 below, 1/16 below-right.
      if (x + 1 < width) {
        curr[at + 3] += (er * 7) / 16;
        curr[at + 4] += (eg * 7) / 16;
        curr[at + 5] += (eb * 7) / 16;
      }
      if (y + 1 < height) {
        if (x > 0) {
          next[at - 3] += (er * 3) / 16;
          next[at - 2] += (eg * 3) / 16;
          next[at - 1] += (eb * 3) / 16;
        }
        next[at] += (er * 5) / 16;
        next[at + 1] += (eg * 5) / 16;
        next[at + 2] += (eb * 5) / 16;
        if (x + 1 < width) {
          next[at + 3] += er / 16;
          next[at + 4] += eg / 16;
          next[at + 5] += eb / 16;
        }
      }
    }
    const swap = curr; curr = next; next = swap;
  }
  return out;
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
    dither = false,
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
    let index;

    if (dither) {
      // Handles the transparent index itself, so cut-out pixels never take
      // part in error diffusion.
      index = applyPaletteDithered(rgba, palette, width, height,
                                   transparent, ALPHA_THRESHOLD, colours);
    } else {
      index = applyPalette(rgba, palette, 'rgb565');
      if (transparent) {
        // Point every cut-out pixel at the reserved index.
        const alpha = frame.data;
        for (let p = 0, a = 3; p < index.length; p++, a += 4) {
          if (alpha[a] < ALPHA_THRESHOLD) index[p] = colours;
        }
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
