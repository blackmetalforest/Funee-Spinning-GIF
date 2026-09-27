/**
 * A picture as a model: one flat, double-sided card carrying the image.
 *
 * JPEG, PNG, WebP, BMP and GIF all arrive here. The card is sized to the
 * picture's aspect ratio and lit like any other model, so the lighting presets
 * work on it; Retro's Flat preset shows the pixels at exactly their own
 * colours. Alpha is left to the loader's ordinary map-alpha pass
 * (useMapAlpha in loaders.js), which turns a PNG or WebP's transparency into a
 * cut-out or a blend exactly as it does for a game rip's textures.
 *
 * **Animation.** An animated GIF or WebP is decoded to all of its frames up
 * front, and the texture's picture is swapped for the right one at each
 * output frame's time (SpinScene.setTime). Decoding up front is what keeps a
 * render exact and repeatable: every frame is on hand the moment it is asked
 * for, in any order.
 *
 * Frames are kept as ImageBitmaps, which are decoded pixels, so a long
 * animation is expensive — the 1000-frame 500×500 test GIF is a gigabyte at
 * full size. The frames are therefore shrunk until the whole animation fits
 * FRAME_BUDGET. That rarely costs anything visible: the card fills only part
 * of an output that is usually 480 pixels square.
 *
 * Decoding an animation needs the browser's ImageDecoder (WebCodecs). Without
 * it the picture still loads, as its first frame, and the stats say so.
 */

import * as THREE from '../vendor/three/three.module.js';

export const PICTURE_MODEL_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif',
};

/** Largest side for a still. WebGL 2 guarantees more; every device we know of has 4096. */
const STILL_MAX_SIDE = 4096;
/** Largest side for an animation frame, whatever the budget allows. */
const FRAME_MAX_SIDE = 2048;
/**
 * Bytes of decoded pixels an animation may hold. Scaled to the device where
 * the browser says how much memory it has (Chromium only), and a middle value
 * where it does not.
 */
const FRAME_BUDGET = (() => {
  const gb = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
  const mb = gb ? Math.min(512, Math.max(128, gb * 64)) : 384;
  return mb * 1024 * 1024;
})();
/**
 * Browsers show a GIF frame delay of 10 ms or less as 100 ms, a rule from the
 * days of flashing banner ads. Followed to the letter it wrecks the common
 * "60 fps" GIF, whose delays run 20, 20, 10 because the format counts in
 * hundredths. So only a missing or zero delay becomes 100 ms, and 10 ms is
 * taken literally — unless every frame is that short, which is the case the
 * browser rule exists for.
 */
const TINY_DELAY_MS = 10;
const DEFAULT_DELAY_MS = 100;

export function playableDelays(raw) {
  const allTiny = raw.every((ms) => ms <= TINY_DELAY_MS);
  return raw.map((ms) => (allTiny || !(ms > 0) ? DEFAULT_DELAY_MS : ms));
}

const BITMAP_OPTIONS = {
  // three.js cannot flip or un-premultiply an ImageBitmap at upload, so both
  // are decided here, as ImageBitmapLoader does.
  imageOrientation: 'flipY',
  premultiplyAlpha: 'none',
};

/**
 * Decode `file` and build its card.
 * @param {(done:number,total:number)=>void} [onProgress] per decoded frame
 * @returns {Promise<{object: THREE.Object3D, image: object}>} `image` describes
 *   the picture for the stats line.
 */
export async function loadPictureModel(file, ext, { onProgress } = {}) {
  const decoded = await decodeFrames(file, ext, onProgress);
  const { frames, delays, width, height } = decoded;

  const texture = new THREE.Texture(frames[0]);
  texture.flipY = false;                  // already flipped by createImageBitmap
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  if (frames.length > 1) {
    const starts = [];
    let totalMs = 0;
    for (const delay of delays) { starts.push(totalMs); totalMs += delay; }
    texture.userData.animation = { frames, starts, totalMs, index: 0 };
  }
  // The bitmaps are ours to free, and nothing else will: the scene disposes
  // the texture when the model is replaced.
  texture.addEventListener('dispose', () => { for (const frame of frames) frame.close(); });

  // Height 1, width to the aspect ratio; the scene rescales the model anyway.
  const aspect = decoded.sourceWidth / decoded.sourceHeight;
  const geometry = new THREE.PlaneGeometry(aspect, 1);
  const name = file.name.replace(/\.[^.]+$/, '');
  const material = new THREE.MeshPhongMaterial({
    name, map: texture, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  const object = new THREE.Group();
  object.add(mesh);

  return {
    object,
    image: {
      width: decoded.sourceWidth,
      height: decoded.sourceHeight,
      frames: frames.length,
      durationMs: delays.reduce((a, b) => a + b, 0),
      frameWidth: width,
      frameHeight: height,
      animationLost: decoded.animationLost,
    },
  };
}

/**
 * Every frame of the picture, flipped for upload, with its delay in ms.
 * A still is one frame with no meaningful delay.
 */
async function decodeFrames(file, ext, onProgress) {
  const type = MIME[ext] ?? file.type;
  const mayAnimate = ext === 'gif' || ext === 'webp' || ext === 'png';

  if (mayAnimate && typeof ImageDecoder !== 'undefined') {
    let supported = false;
    try { supported = await ImageDecoder.isTypeSupported(type); } catch { /* no */ }
    if (supported) {
      // A file ImageDecoder chokes on may still open as a plain picture.
      let animated = null;
      try { animated = await decodeAnimation(file, type, onProgress); } catch (err) { console.warn(err); }
      if (animated) return animated;
    }
  }

  const still = await decodeStill(file);
  // A GIF or WebP that is animated but could not be played here still loads,
  // as its first frame; the stats line says what was lost.
  still.animationLost = mayAnimate && typeof ImageDecoder === 'undefined'
    && (ext === 'gif' || ext === 'webp') && await looksAnimated(file, ext);
  return still;
}

async function decodeStill(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, BITMAP_OPTIONS);
  } catch {
    throw new Error(`Could not read ${file.name} as a picture`);
  }
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const scale = Math.min(1, STILL_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
  if (scale < 1) {
    const big = bitmap;
    // Resizing an ImageBitmap keeps its orientation: flipped once is enough.
    bitmap = await createImageBitmap(big, {
      resizeWidth: Math.max(1, Math.round(sourceWidth * scale)),
      resizeHeight: Math.max(1, Math.round(sourceHeight * scale)),
      resizeQuality: 'high',
      premultiplyAlpha: 'none',
    });
    big.close();
  }
  return {
    frames: [bitmap], delays: [0],
    width: bitmap.width, height: bitmap.height, sourceWidth, sourceHeight,
  };
}

/** All frames through ImageDecoder, or null when the file is a still. */
async function decodeAnimation(file, type, onProgress) {
  const decoder = new ImageDecoder({
    data: await file.arrayBuffer(), type, preferAnimation: true,
  });
  const frames = [];
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const count = track?.frameCount ?? 1;
    if (!track?.animated || count < 2) return null;

    const delays = [];
    let size = null;
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
      try {
        if (!size) size = fitAnimation(image.displayWidth, image.displayHeight, count);
        frames.push(await createImageBitmap(image, {
          ...BITMAP_OPTIONS,
          resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high',
        }));
        delays.push((image.duration ?? 0) / 1000);
      } finally {
        image.close();
      }
      onProgress?.(i + 1, count);
    }
    return {
      frames, delays: playableDelays(delays),
      width: size.width, height: size.height,
      sourceWidth: size.sourceWidth, sourceHeight: size.sourceHeight,
    };
  } catch (err) {
    for (const frame of frames) frame.close();
    throw err;
  } finally {
    decoder.close();
  }
}

/** Frame size for an animation: full size if the whole run fits the budget. */
function fitAnimation(sourceWidth, sourceHeight, count) {
  const bytes = count * sourceWidth * sourceHeight * 4;
  const scale = Math.min(1,
    FRAME_MAX_SIDE / Math.max(sourceWidth, sourceHeight),
    Math.sqrt(FRAME_BUDGET / bytes));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    sourceWidth, sourceHeight,
  };
}

/**
 * Whether a GIF or WebP holds more than one frame, read from the bytes, for
 * the browsers that cannot decode one. Only used to word the stats line.
 */
async function looksAnimated(file, ext) {
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 1 << 20)).arrayBuffer());
  if (ext === 'webp') {
    // An animated WebP says so in its VP8X header and carries ANIM/ANMF chunks.
    for (let i = 12; i + 4 <= bytes.length; i++) {
      if (bytes[i] === 0x41 && bytes[i + 1] === 0x4e && bytes[i + 2] === 0x4d && bytes[i + 3] === 0x46) return true;
    }
    return false;
  }
  // GIF: more than one image descriptor (0x2C) straight after a graphic
  // control extension (0x21 0xF9 ... 0x00). A rough count, but only wording
  // depends on it.
  let images = 0;
  for (let i = 0; i + 9 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 7] === 0x00 && bytes[i + 8] === 0x2c) {
      if (++images > 1) return true;
    }
  }
  return false;
}
