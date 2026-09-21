/**
 * The frame store — mirrors spin3d/spinner.py.
 *
 * Frames are rendered once and kept as encoded PNG blobs rather than raw
 * pixels. That choice drives a lot of good behaviour:
 *
 *  - 48 frames at 1000x1000 is ~192 MB as raw RGBA and would OOM a phone; as
 *    PNG it is single-digit MB.
 *  - Export format becomes a save-time decision, so one render can produce a
 *    GIF *and* a WebP *and* an APNG with no re-rendering.
 *  - PNG specifically (not WebP) because it is lossless, so GIF quantisation
 *    later sees exact pixels and APNG export needs no re-encoding at all.
 *
 * The PNG is written by our own encoder rather than canvas.toBlob: Chrome's
 * built-in PNG encoder measured ~1020 ms for a single 160x160 frame here,
 * against ~8 ms for the fflate path. See src/encoders/png.js.
 */

import { frameAngles } from './encoders/timing.js';
import { encodePng } from './encoders/png.js';
import { drawText } from './overlay-text.js';

/**
 * Build the composer that turns one rendered frame into one output image.
 *
 * Bottom to top: the background, the downsampled render, the caption.
 *
 * The background is painted here rather than by the renderer. The GL clear is
 * always transparent now (see SpinScene.render), so an opaque background is a
 * fillRect underneath everything — which is what will let a caption be drawn
 * *under* the model later, and what stops an opaque background being the one
 * thing nothing can ever sit behind.
 *
 * The canvas and its context are reused across frames; allocating a fresh one
 * per frame is measurably slower.
 */
function makeResolver(width, height, caption, background) {
  const out = new OffscreenCanvas(width, height);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return (source) => {
    ctx.clearRect(0, 0, width, height);
    // Only when the user asked for one: left clear otherwise, so the alpha
    // channel still tells the exporters the truth about what is see-through.
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(source, 0, 0, width, height);
    // The caption goes on *after* the downsample, at the true output size, so
    // its edges stay sharp instead of being softened along with the render.
    // Here rather than at save time because it belongs to the frame: one
    // render then feeds a GIF, a WebP and an APNG that all agree.
    if (caption) drawText(ctx, caption.text, { ...caption, width, height });
    return ctx.getImageData(0, 0, width, height);
  };
}

/**
 * Render one full revolution into a frame store.
 *
 * @param {SpinScene} scene
 * @param {{frames:number, clockwise:boolean}} spin
 * @param {(done:number,total:number)=>boolean} onProgress return false to cancel
 * @param {{text:object, family:string, weight:number, scale:number}} [caption]
 * @returns {Promise<{blobs: Blob[], width: number, height: number} | null>}
 */
export async function captureFrames(scene, spin, onProgress, caption = null) {
  const { width, height } = scene.settings;
  const angles = frameAngles(spin.frames, spin.clockwise);
  // The renderer no longer paints the background, so the composer does.
  const background = scene.settings.transparent ? null : scene.settings.background;
  const resolve = makeResolver(width, height, caption, background);
  const blobs = [];

  // The centre-axis guide is a preview aid and must never reach the output.
  // try/finally so it comes back even if the render is cancelled or throws.
  const axisWasVisible = scene.axisArrow?.visible ?? false;
  if (axisWasVisible) scene.setAxisVisible(false);

  try {
    for (let i = 0; i < angles.length; i++) {
      scene.setAngle(angles[i]);
      scene.render();

      // PNG keeps the frame store lossless; see the note at the top of the file.
      const png = encodePng(resolve(scene.canvas));
      blobs.push(new Blob([png], { type: 'image/png' }));

      if (onProgress && onProgress(i + 1, angles.length) === false) return null;
      // Yield so the progress bar can actually paint between frames.
      if ((i & 3) === 3) await new Promise((r) => setTimeout(r, 0));
    }
    return { blobs, width, height };
  } finally {
    if (axisWasVisible) scene.setAxisVisible(true);
  }
}

/** Decode stored frames back to ImageData for the encoders that need pixels. */
export async function decodeFrames(store, onProgress) {
  const { blobs, width, height } = store;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const out = [];

  for (let i = 0; i < blobs.length; i++) {
    const bitmap = await createImageBitmap(blobs[i]);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    out.push(ctx.getImageData(0, 0, width, height));
    if (onProgress) onProgress(i + 1, blobs.length);
  }
  return out;
}

/** Total bytes held by the store — shown in the UI so the cost is visible. */
export function storeSize(store) {
  return store ? store.blobs.reduce((n, b) => n + b.size, 0) : 0;
}
