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

import { framePoses, frameTimesMs, frameIndexAt } from './encoders/timing.js';
import { encodePng } from './encoders/png.js';
import { drawText, drawBand, layoutBand } from './overlay-text.js';
import { drawBackdrop } from './backdrop.js';

/**
 * Build the composer that turns one rendered frame into one output image.
 *
 * This is the only place that decides how a frame is stacked, which is what
 * keeps the four caption modes from each inventing their own arrangement.
 * Bottom to top it is always: background, then the render with the
 * foreground picture over it, and the caption over or under those two as the
 * mode asks.
 *
 * The background is painted here rather than by the renderer. The GL clear is
 * always transparent now (see SpinScene.render), so an opaque background is a
 * fillRect underneath everything — which is what lets "Behind" put text on it.
 * A background picture is drawn the same way, by drawBackdrop().
 *
 * The canvas and its context are reused across frames; allocating a fresh one
 * per frame is measurably slower.
 *
 * `height` is the height of the *render*. The returned images may be taller:
 * "On Top" grows a band above the image, and the band's height falls out of
 * its own wrapped text rather than being configured. The requested width and
 * height keep describing the render, and nothing upstream of here learns that
 * the band exists.
 */
function makeResolver(width, height, caption, backdrop, foreground = null) {
  const mode = caption?.mode ?? null;
  const out = new OffscreenCanvas(width, height);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Measured once, on this very context, so every frame agrees — and so the
  // store's dimensions are known before the first frame is drawn.
  const band = mode === 'ontop'
    ? layoutBand(ctx, caption.band, { ...caption, width, height }).bandHeight
    : 0;
  const total = height + band;
  if (band) out.height = total;

  // An animated picture shows the frame for this moment of its own clock.
  const pictureAt = (layer, ms) => {
    const animation = layer?.animation;
    if (!animation) return layer;
    const index = frameIndexAt(animation.starts, animation.totalMs, ms);
    return { ...layer, image: animation.frames[index] };
  };

  const resolve = (source, backdropMs = 0, foregroundMs = 0) => {
    ctx.clearRect(0, 0, width, total);
    // Only when the user asked for one: left clear otherwise, so the alpha
    // channel still tells the exporters the truth about what is see-through.
    drawBackdrop(ctx, pictureAt(backdrop, backdropMs), { width, height, top: band, total });
    // The caption goes on *after* the downsample, at the true output size, so
    // its edges stay sharp instead of being softened along with the render.
    // Here rather than at save time because it belongs to the frame: one
    // render then feeds a GIF, a WebP and an APNG that all agree.
    // Bottom to top: background, render, foreground picture, caption — or,
    // in Behind, the caption under the render and the foreground with it.
    // The foreground belongs to the render, like the background: it sits over
    // the render's rows and never over On Top's band.
    const place = { width, height, top: band, total };
    if (mode === 'behind') {
      drawText(ctx, caption.text, { ...caption, width, height });
      ctx.drawImage(source, 0, 0, width, height);
      if (foreground) drawBackdrop(ctx, pictureAt(foreground, foregroundMs), place);
    } else {
      ctx.drawImage(source, 0, band, width, height);
      if (foreground) drawBackdrop(ctx, pictureAt(foreground, foregroundMs), place);
      if (mode === 'ontop') drawBand(ctx, caption.band, { ...caption, width, height, y: 0 });
      else if (mode === 'front') drawText(ctx, caption.text, { ...caption, width, height });
    }
    return ctx.getImageData(0, 0, width, total);
  };
  // The composed height travels with the composer: it is the store's height,
  // and the caller has no other way to know it.
  return { resolve, height: total };
}

/**
 * Render one full revolution into a frame store.
 *
 * @param {SpinScene} scene
 * @param {{frames:number, clockwise:boolean}} spin
 * @param {(done:number,total:number)=>boolean} onProgress return false to cancel
 * @param {{mode:string, text:object, band:string, family:string,
 *          weight:number, scale:number}} [caption]
 * @param {null | {colour:string} | {image:CanvasImageSource, size:number,
 *          x:number, y:number, animation?:{frames, starts, totalMs}}} [backdrop]
 *   the background layer; see drawBackdrop(). Null leaves the frame clear.
 *   With `animation`, each frame draws the picture showing at that moment.
 * @param {null | {image, size, x, y, animation?}} [foreground] the Image
 *   section's Foreground: the same shape as a picture backdrop, drawn over
 *   the render and under any caption.
 * @returns {Promise<{blobs: Blob[], width: number, height: number} | null>}
 *   `height` is the height of the finished image, which "On Top" makes taller
 *   than the render. Every exporter reads it from here rather than from the
 *   settings, so the band needs no special case downstream.
 */
export async function captureFrames(scene, spin, onProgress, caption = null,
  backdrop = null, foreground = null) {
  const { width, height } = scene.settings;
  // [spin, tumble, roll] per frame; see framePoses().
  const poses = framePoses(spin.frames, spin);
  // Where the loop is at each frame. An animated model and an animated
  // background each play against it at their own Sync's speed.
  const times = frameTimesMs(spin.frames, spin.rps);
  const modelScale = spin.animScale ?? 1;
  const backdropScale = spin.backdropScale ?? 1;
  const foregroundScale = spin.foregroundScale ?? 1;
  // The renderer no longer paints the background, so the composer does.
  const { resolve, height: outHeight } = makeResolver(width, height, caption, backdrop, foreground);
  const blobs = [];

  // The centre-axis guide is a preview aid and must never reach the output.
  // try/finally so it comes back even if the render is cancelled or throws.
  const axisWasVisible = scene.axisArrow?.visible ?? false;
  if (axisWasVisible) scene.setAxisVisible(false);

  try {
    for (let i = 0; i < poses.length; i++) {
      scene.setAngle(...poses[i]);
      scene.setTime(times[i] * modelScale);
      scene.render();

      // PNG keeps the frame store lossless; see the note at the top of the file.
      const png = encodePng(resolve(scene.canvas, times[i] * backdropScale, times[i] * foregroundScale));
      blobs.push(new Blob([png], { type: 'image/png' }));

      if (onProgress && onProgress(i + 1, poses.length) === false) return null;
      // Yield so the progress bar can actually paint between frames.
      if ((i & 3) === 3) await new Promise((r) => setTimeout(r, 0));
    }
    return { blobs, width, height: outHeight };
  } finally {
    if (axisWasVisible) scene.setAxisVisible(true);
    scene.setTime(0);
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
