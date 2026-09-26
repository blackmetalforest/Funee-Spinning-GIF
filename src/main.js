/**
 * App wiring: controls -> scene -> frame store -> exports.
 *
 * The flow deliberately separates rendering from saving. "Render frames" fills
 * the store once; each Save button then assembles that store into a format
 * without re-rendering, so you can export a GIF and a WebP and an APNG from a
 * single render.
 */

import { SpinScene, DEFAULT_SETTINGS } from './scene.js';
import { LAYERS } from './materials.js';
import { loadModel, FILE_ACCEPT, SELF_CONTAINED, AUTO, NONE } from './loaders.js';
import { baseName, stemOf, extOf, IMAGE_EXTENSIONS } from './archive.js';
import { labelMeshes, toggleLabel, meshSummary } from './mesh-list.js';
import { drawText, drawBand, layoutBand, isBlank } from './overlay-text.js';
import { placeBackdrop } from './backdrop.js';
import { PRESETS, PRESET_KEYS, presetValues, matchingPreset } from './presets.js';
import { captureFrames, decodeFrames, storeSize } from './capture.js';
import { loopSummary, FPS_LIMIT, frameDelaysMs, frameStarts, frameIndexAt,
         SPIN_RATIOS, loopTurns, framePoses } from './encoders/timing.js';
import { encodeGif } from './encoders/gif.js';
import { muxAnimation, encodeStill } from './encoders/webp.js';
import { muxApng } from './encoders/apng.js';
import { encodeZip } from './encoders/frames.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const canvas = $('canvas');
const scene = new SpinScene(canvas);

let store = null;          // { blobs, width, height }
let modelName = 'spin';
let cancelRequested = false;
let rendering = false;

/* ------------------------------------------------------------ settings */

const RANGE_IDS = ['elevation', 'start', 'fov', 'zoom', 'speed', 'fps',
  'ambient', 'key', 'fill', 'rim', 'specular', 'shininess',
  'env-intensity', 'env-rotation', 'exposure', 'brightness',
  'key-azimuth', 'key-height', 'fill-azimuth', 'fill-height', 'shadow-darkness',
  'normal-strength', 'emission-strength',
  'pos-x', 'pos-y', 'pos-z', 'pitch', 'yaw', 'roll',
  'text-stroke', 'text-size',
  'background-size', 'background-x', 'background-y'];

// The Rendering section's choices. Like the Image section's, each one changes
// what a render produces, so each drops the frame store. Lighting ('shading')
// has a listener of its own, since switching it can also switch the preset.
const RENDER_CHOICE_IDS = ['environment', 'tone-mapping', 'key-color',
  'fill-color', 'ambient-color', 'shadows', 'debug-view', 'texture-filter',
  'double-sided'];

/*
 * Which material layers are switched on. Kept here rather than read back from
 * the checkboxes, because the checkboxes are rebuilt for every model and a
 * layer switched off for debugging should stay off across a reload.
 */
const layerState = Object.fromEntries(LAYERS.map((l) => [l.key, true]));

// Position sliders change the render, so they must also drop the frame store.
const POSITION_IDS = ['pos-x', 'pos-y', 'pos-z', 'pitch', 'yaw', 'roll'];

// So do the background picture's, which are baked into every frame.
const PICTURE_IDS = ['background-size', 'background-x', 'background-y'];

const FORMAT_LABELS = { gif: 'GIF', webp: 'WebP', apng: 'APNG', zip: 'ZIP' };

function readSettings() {
  return {
    width: clampInt($('width').value, 32, 2000, 480),
    height: clampInt($('height').value, 32, 2000, 480),
    supersample: parseInt($('quality').value, 10),
    elevation: +$('elevation').value,
    startAngle: +$('start').value,
    upAxis: $('up-axis').value,
    posX: +$('pos-x').value,
    posY: +$('pos-y').value,
    posZ: +$('pos-z').value,
    pitch: +$('pitch').value,
    yaw: +$('yaw').value,
    roll: +$('roll').value,
    tumbling: readExtraAxes().length > 0,
    fov: +$('fov').value,
    zoom: +$('zoom').value,
    background: $('background').value,
    // Whether anything may be see-through. A picture can leave parts of the
    // image uncovered, so only a solid colour promises an opaque frame.
    transparent: $('background-mode').value !== 'solid',
    ambient: +$('ambient').value,
    keyLight: +$('key').value,
    fillLight: +$('fill').value,
    rimLight: +$('rim').value,
    specular: +$('specular').value,
    shininess: +$('shininess').value,
    shading: $('shading').value,
    environment: $('environment').value,
    envIntensity: +$('env-intensity').value,
    envRotation: +$('env-rotation').value,
    toneMapping: $('tone-mapping').value,
    exposure: +$('exposure').value,
    brightness: +$('brightness').value / 100,
    keyAzimuth: +$('key-azimuth').value,
    keyHeight: +$('key-height').value,
    keyColor: $('key-color').value,
    fillAzimuth: +$('fill-azimuth').value,
    fillHeight: +$('fill-height').value,
    fillColor: $('fill-color').value,
    ambientColor: $('ambient-color').value,
    shadows: $('shadows').value,
    shadowDarkness: +$('shadow-darkness').value,
    view: $('debug-view').value,
    layers: { ...layerState },
    normalStrength: +$('normal-strength').value,
    emissionStrength: +$('emission-strength').value,
    textureFilter: $('texture-filter').value,
    doubleSided: $('double-sided').checked,
  };
}

/*
 * Frame count is derived, not chosen: frames = frame rate x seconds per turn.
 * Spin speed and frame rate are what anyone actually has an opinion about; the
 * frame count is the bill that arrives for them.
 *
 * Neither GIF nor animated WebP caps the number of frames in the format — GIF
 * does not store a count at all, and WebP's limit is the 4 GiB RIFF container.
 * What actually bites here is this app: every frame is held in memory as a PNG
 * and re-encoded on save, so the thresholds below are about render time, memory
 * and a file anyone would tolerate, not about a format rule.
 */
const FRAMES_HEAVY = 300;      // slow to render, and a GIF well past 10 MB
const FRAMES_MAX = 1000;       // hard ceiling: beyond this a phone runs out of memory

/*
 * Below this the spin reads as stopped rather than slow, so the slider's bottom
 * end snaps to zero instead of offering speeds nobody wants: 0.01 rounds/s is
 * a hundred seconds a turn, which is a still with extra steps.
 */
const MIN_RPS = 0.05;

function snapSpeed(value) {
  return value < MIN_RPS ? 0 : value;
}

/*
 * Frames are derived: frame rate x seconds per turn. Either input at zero means
 * nothing moves, which is one still frame — not a division by zero, and not the
 * thousand frames that 1/0 would otherwise clamp to.
 */
function framesFor(fps, rps) {
  if (!(fps > 0) || !(rps > 0)) return { frames: 1, ideal: 1, stopped: true };
  const ideal = Math.round(fps / rps);
  return {
    frames: Math.max(1, Math.min(FRAMES_MAX, ideal)),
    ideal,
    stopped: false,
  };
}

/** The Spin section's extra axes, as their direction and speed controls say. */
const EXTRA_AXES = [
  { axis: 'x', dir: 'tumble-dir', ratio: 'tumble-ratio' },
  { axis: 'z', dir: 'roll-dir', ratio: 'roll-ratio' },
];

function readExtraAxes() {
  return EXTRA_AXES
    .filter(({ dir }) => $(dir).value !== 'off')
    .map(({ axis, dir, ratio }) => {
      const { main, spins } = SPIN_RATIOS[clampInt($(ratio).value, 0, SPIN_RATIOS.length - 1, 4)];
      return { axis, main, spins, clockwise: $(dir).value === 'cw' };
    });
}

/*
 * One loop is `turns` turns of the main spin — one, unless an extra axis is
 * slower than the spin and has to be waited for — and every figure that
 * times the file is per loop: the frame count covers all of it, and `rps` is
 * loops per second, which is what the delay tables divide up.
 */
function readSpin() {
  const turnRps = +$('speed').value;
  const axes = readExtraAxes();
  const turns = loopTurns(axes);
  const { frames, ideal, stopped } = framesFor(+$('fps').value, turnRps / turns);
  return {
    frames, ideal, stopped, turns, axes,
    rps: turnRps / turns,
    clockwise: $('direction').value === 'cw',
  };
}

function clampInt(value, lo, hi, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/* ---------------------------------------------------------------- text */

/**
 * The caption as the controls currently describe it, or null for none.
 *
 * Null means "compose the frame with no caption at all", which covers both
 * Disabled and every mode with nothing typed into it — the compositor and the
 * preview then take the same short path they always did.
 *
 * `mode` rides along because where the caption goes is not something the
 * drawing code can work out from the text: In Front and Behind read
 * identically here and differ only in what is drawn over what.
 */
function readCaption() {
  const mode = $('text-mode').value;
  if (mode === 'off') return null;

  const style = {
    mode,
    family: $('text-font').value,
    // On Top is black on white; an outline would only ever spoil it, so the
    // control is hidden there and the value it holds is ignored.
    weight: mode === 'ontop' ? 0 : +$('text-stroke').value,
    scale: +$('text-size').value / 100,
  };

  if (mode === 'ontop') {
    const band = $('text-band-copy').value;
    return band.trim() ? { ...style, band } : null;
  }

  const text = {
    top: $('text-top').value,
    middle: $('text-middle').value,
    bottom: $('text-bottom').value,
  };
  return isBlank(text) ? null : { ...style, text };
}

/**
 * The picture chosen for an Image background, decoded once and kept:
 * `{ bitmap, url, name }`. The bitmap is what the export draws; the object URL
 * feeds the preview's <img>. Null until something is chosen.
 */
let backdropPicture = null;

/**
 * The background layer to paint under the render, or null to leave it clear.
 *
 * The renderer no longer paints its own background (see SpinScene.render), so
 * this is the single answer to "what is down there", asked by the preview and
 * by the capture alike. Image with no picture chosen yet is simply clear.
 */
function readBackdrop() {
  switch ($('background-mode').value) {
    case 'solid':
      return { colour: $('background').value };
    case 'image':
      return backdropPicture && {
        image: backdropPicture.bitmap,
        size: +$('background-size').value,
        x: +$('background-x').value,
        y: +$('background-y').value,
      };
    default:
      return null;
  }
}

/**
 * Place the preview's background picture from the same placeBackdrop() the
 * export draws with. Percentages of the render's row, so the picture scales
 * with the preview however the stage is sized.
 */
function placePreviewPicture(backdrop, w, h) {
  const art = $('backdrop-art');
  art.hidden = !backdrop?.image;
  if (art.hidden) return;
  const { image } = backdrop;
  const place = placeBackdrop(image.width, image.height, w, h, backdrop);
  const style = $('backdrop-image').style;
  style.left = `${(place.x / w) * 100}%`;
  style.top = `${(place.y / h) * 100}%`;
  style.width = `${(place.width / w) * 100}%`;
  style.height = `${(place.height / h) * 100}%`;
}

/**
 * The bundled families, as CSS needs to hear them.
 *
 * Kept in step with the @font-face rules in style.css and the "Included"
 * options in index.html — a test asserts all three agree, because a typo
 * here is invisible: the browser would quietly fall back and the caption
 * would change size with nothing to show for it.
 */
const BUNDLED_FONTS = ['Anton', 'Oswald', 'Comic Neue', 'Arimo', 'Tinos'];

/**
 * Make sure a family is actually loaded before anything measures it.
 *
 * This is the whole reason bundling fonts is more than dropping files in a
 * folder. measureText and fillText fall back to a default face, silently, if
 * the font has not arrived — and because fontPx() *measures* the M to size
 * the caption, a fallback does not merely look wrong, it picks a different
 * size and wraps in different places. Without this the first render after a
 * reload can disagree with every render after it.
 */
async function waitForFont(family) {
  if (!document.fonts?.load) return;
  try {
    await document.fonts.load(`100px ${family}`);
  } catch {
    // An unloadable family is not worth failing a render over: the stack
    // falls back, the caption is measured from whatever answered, and the
    // layout is still self-consistent.
  }
}

/**
 * Lay out and paint the preview's three layers.
 *
 * The overlay is a separate 2D canvas because you cannot draw text into a
 * WebGL context; the backdrop is a div because a flat colour needs nothing
 * more. What this function really owns is the *arrangement*: it is the
 * preview's half of the same decision makeResolver() makes for the export,
 * and the two have to agree or what you see is not what you save.
 */
/**
 * How much taller the band makes the exported image, in output pixels.
 * Written by drawPreviewCaption(), read by updateViewSize().
 */
let bandOutPx = 0;

/**
 * A scratch context for measuring the band at output scale.
 *
 * Its own, rather than the overlay's: measuring sets ctx.font, and the
 * overlay is about to be resized — which resets its context anyway — so
 * borrowing it would only make the ordering matter.
 */
let probeCtx = null;
function bandProbe() {
  if (!probeCtx) probeCtx = document.createElement('canvas').getContext('2d');
  return probeCtx;
}

function drawPreviewCaption() {
  const overlay = $('overlay');
  const frame = $('frame');
  /*
   * Sized from the render canvas, deliberately — not from the settings.
   *
   * The renderer is not resized until the next animation frame. Sizing the
   * overlay from the settings instead made it jump to the new size at once
   * while the render underneath stayed at the old one, and since the grid
   * lays the two out by their intrinsic sizes, the caption sat visibly wrong
   * against the model until something else redrew it. Following the canvas
   * means the two always change together, one frame later but in step.
   */
  const source = scene.canvas;
  const w = Math.max(1, source.width);
  const h = Math.max(1, source.height);

  const caption = readCaption();
  const hidden = canvas.classList.contains('empty');

  // The background layer. An empty colour lets the stage's checkerboard
  // through, which is how a transparent background has always read here.
  const backdrop = readBackdrop();
  $('backdrop').style.backgroundColor = backdrop?.colour ?? '';
  placePreviewPicture(backdrop, w, h);

  /*
   * The band is measured at the *output* size, not at the preview's, and the
   * preview is scaled from that answer rather than measuring its own.
   *
   * It matters because the band's height is rounded to whole pixels. The
   * preview canvas is supersampled — two or three times the output — so
   * measuring there and dividing would round in a different place and leave
   * the preview a pixel or two out from the file you save. Measuring the
   * thing that actually ships, once, and scaling up is exact.
   */
  const out = readSettings();
  bandOutPx = 0;
  if (caption?.mode === 'ontop' && !hidden) {
    bandOutPx = layoutBand(bandProbe(), caption.band,
      { ...caption, width: out.width, height: out.height }).bandHeight;
  }
  const band = Math.round(bandOutPx * (h / Math.max(1, out.height)));

  if (overlay.width !== w || overlay.height !== h + band) {
    overlay.width = w;
    overlay.height = h + band;
  }
  // Rows in real pixels, so the band and the render scale as one piece; the
  // aspect ratio is what lets the whole thing be fitted into the stage.
  frame.style.gridTemplateRows = `${band}fr ${h}fr`;
  frame.style.aspectRatio = `${w} / ${h + band}`;
  frame.classList.toggle('behind', caption?.mode === 'behind');

  // Reported here rather than left to the callers: the band is measured as
  // part of drawing, and every path that changes it comes through this
  // function, so this is the one place the readout cannot go stale.
  updateViewSize();

  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  overlay.hidden = hidden;
  if (!caption || hidden) return;

  if (caption.mode === 'ontop') {
    drawBand(ctx, caption.band, { ...caption, width: w, height: h, y: 0 });
  } else {
    // In Front and Behind draw the same thing in the same place. Which one
    // ends up on top is the CSS class set above, not anything drawn here.
    drawText(ctx, caption.text, { ...caption, width: w, height: h });
  }
}

/* ------------------------------------------------------------- display */

/**
 * A reading that stays legible across a typed range.
 *
 * Two decimals is right for the ranges the sliders offer, and wrong at both
 * ends of the ranges you can now type: 0.001 r/s reads as "0.00" and a 250x
 * zoom wastes the width on zeroes. Precision follows magnitude instead.
 */
function trim(value) {
  const size = Math.abs(value);
  if (size >= 100) return value.toFixed(0);
  if (size >= 10) return value.toFixed(1);
  if (size !== 0 && size < 0.01) return value.toFixed(3);
  return value.toFixed(2);
}

function syncOutputs() {
  $('elevation-out').textContent = `${$('elevation').value}°`;
  $('start-out').textContent = `${$('start').value}°`;
  $('fov-out').textContent = `${$('fov').value}°`;
  $('zoom-out').textContent = `${trim(+$('zoom').value)}×`;
  const rps = +$('speed').value;
  const fps = +$('fps').value;
  $('speed-out').textContent = rps > 0 ? `${trim(rps)} r/s` : 'stopped';
  $('fps-out').textContent = fps > 0 ? `${fps} fps` : 'stopped';
  syncFrameCount();
  for (const id of ['ambient', 'key', 'fill', 'rim', 'specular', 'env-intensity',
    'exposure', 'shadow-darkness', 'normal-strength', 'emission-strength']) {
    $(`${id}-out`).textContent = trim(+$(id).value);
  }
  $('shininess-out').textContent = $('shininess').value;
  for (const { dir, ratio } of EXTRA_AXES) {
    $(`${ratio}-out`).textContent = SPIN_RATIOS[+$(ratio).value]?.label ?? '';
    $(`${ratio}-row`).hidden = $(dir).value === 'off';
  }
  $('brightness-out').textContent = `${$('brightness').value}%`;
  for (const id of ['env-rotation', 'key-azimuth', 'key-height', 'fill-azimuth', 'fill-height']) {
    $(`${id}-out`).textContent = `${Math.round(+$(id).value)}°`;
  }
  $('text-stroke-out').textContent = (+$('text-stroke').value).toFixed(1);
  $('text-size-out').textContent = `${$('text-size').value}%`;
  $('background-size-out').textContent = `${$('background-size').value}%`;
  for (const id of ['background-x', 'background-y']) {
    $(`${id}-out`).textContent = $(id).value;
  }
  for (const id of ['pos-x', 'pos-y', 'pos-z']) {
    $(`${id}-out`).textContent = trim(+$(id).value);
  }
  for (const id of ['pitch', 'yaw', 'roll']) {
    $(`${id}-out`).textContent = `${$(id).value}°`;
  }
}

/*
 * Show what the chosen speed and frame rate cost in frames, and how alarmed to
 * be about it. Orange is "this will be slow and large"; red means the count was
 * clamped, so the export will not actually run at the requested frame rate —
 * which the loop summary underneath then shows as a lower figure.
 */
function syncFrameCount() {
  const { frames, ideal, stopped, turns } = readSpin();
  const out = $('frames-out');
  out.textContent = frames;
  if (stopped) {
    out.classList.remove('warn', 'caution');
    $('frames-note').textContent = 'stopped — a single still';
    return;
  }
  // Red at the ceiling, whether or not anything was actually trimmed: sitting
  // exactly on the cap is still the point where the app stops obliging.
  out.classList.toggle('warn', frames >= FRAMES_MAX);
  out.classList.toggle('caution', frames < FRAMES_MAX && frames >= FRAMES_HEAVY);
  $('frames-note').textContent = ideal > FRAMES_MAX
    ? `capped from ${ideal.toLocaleString()}`
    : turns > 1 ? `frame rate ÷ spin speed × ${turns} spins` : 'frame rate ÷ spin speed';
}

function updateLoopInfo() {
  const spin = readSpin();
  if (spin.stopped) {
    // Quoting a turn length or a rate here would be inventing numbers: with
    // nothing moving there is no turn to time.
    $('loop-info').textContent = '1 frame · still — nothing is spinning';
    return;
  }
  // GIF has the coarsest timing grid, so it's the honest one to quote.
  const info = loopSummary(spin.frames, spin.rps, 'gif');
  const fps = info.fps.toFixed(1);
  const seconds = (info.totalMs / 1000).toFixed(2);
  const fpsHtml = info.fps > FPS_LIMIT
    ? `<span class="warn">${fps} fps</span>`
    : `${fps} fps`;
  const plural = spin.frames === 1 ? 'frame' : 'frames';
  // A loop of several spins is quoted as a loop, with the spin rate still
  // per turn, since that is what the Spin speed slider sets.
  const length = spin.turns > 1 ? `${seconds} s/loop of ${spin.turns} spins` : `${seconds} s/turn`;
  $('loop-info').innerHTML =
    `${spin.frames} ${plural} · ${length} · ${fpsHtml} · ` +
    `${(info.actualRps * spin.turns).toFixed(3)} rounds/s`;
}

/*
 * The size in the corner of the view.
 *
 * Width and Height keep describing the *render* — On Top does not change what
 * you asked for — so when the band makes the finished image taller, both
 * numbers are shown rather than one silently replacing the other.
 */
function updateViewSize() {
  const s = readSettings();
  const requested = `${s.width} × ${s.height}`;
  $('view-size').textContent = bandOutPx > 0
    ? `${requested} · output ${s.width} × ${s.height + bandOutPx}`
    : requested;
}

function setBusy(text) {
  if (text) { $('busy-text').textContent = text; $('busy').hidden = false; }
  else $('busy').hidden = true;
}

function setProgress(done, total) {
  const wrap = $('progress-wrap');
  if (done >= total) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $('progress').style.width = `${(done / total) * 100}%`;
}

function setSaveEnabled(enabled) {
  // A format this browser cannot make stays off whatever the store says.
  document.querySelectorAll('.save').forEach((b) => {
    b.disabled = !enabled || b.dataset.unsupported === 'true';
  });
}

/**
 * An error, worded for the person reading it.
 *
 * Running out of memory arrives as a RangeError with wording nobody should
 * have to decode ("Array buffer allocation failed"), and it has one useful
 * answer, so it gets that answer. Everything else is shown as it is.
 */
function friendlyError(err) {
  const message = err?.message ?? String(err);
  if (err instanceof RangeError || /allocation failed|out of memory/i.test(message)) {
    return `Ran out of memory (${message}). Try fewer frames or a smaller image size.`;
  }
  return message;
}

/* -------------------------------------------------------------- render */

let previewHandle = 0;
/* --------------------------------------------------------- preview pump */

/*
 * One requestAnimationFrame loop drives everything live on the canvas: the spin
 * preview and the centre-axis flash. Two loops would mean two draws in the same
 * frame, and a fade updating at 60 fps while the spin updates at 12.
 *
 * Each tick asks both contributors what they want at the current clock reading
 * and draws once if either changed, so nothing is drawn when nothing moves — at
 * 1 fps that is one draw per second rather than sixty.
 */
/*
 * A flag rather than a stored frame id: nothing here is ever cancelled, so the
 * loop only needs to know whether a tick is already queued. It stops on its own
 * once neither contributor wants another one.
 */
let pumping = false;

function pump() {
  pumping = false;                       // this tick is running; another may be queued
  const now = performance.now();
  const stepped = advancePlayback(now);
  const faded = advanceFlash(now);
  if (stepped || faded) scene.render();
  if (stepped) measureRate(now);
  updateRateReadout(now);
  if (playing || flashEndsAt) startPump();
}

function startPump() {
  if (pumping) return;
  pumping = true;
  requestAnimationFrame(pump);
}

/* ---------------------------------------------------------- spin preview */

/*
 * Playback is a lookup against the clock, not a frame counter. That is what
 * keeps it honest when it cannot keep up: a backgrounded tab (rAF stops
 * outright), a target rate above the display's refresh, or one slow frame all
 * resolve to the pose belonging to the current time instead of falling behind
 * by whatever was missed. Speed and loop length stay right; only smoothness
 * gives.
 */
let playing = false;
let playEpoch = 0;
let shownIndex = -1;
const cycle = { angles: [], starts: [], totalMs: 0 };

function rebuildCycle() {
  const spin = readSpin();
  cycle.angles = framePoses(spin.frames, spin);
  // GIF's grid, the same one #loop-info quotes: the coarsest of the formats,
  // and the only one whose quantisation is visible as judder.
  const { starts, totalMs } = frameStarts(frameDelaysMs(spin.frames, spin.rps, 'gif'));
  cycle.starts = starts;
  cycle.totalMs = totalMs;
  shownIndex = -1;                       // force the next tick to draw
}

/*
 * Rebuild after a settings change, holding the model where it is. Restarting
 * the loop instead would yank it back to frame 0 on every step of a Spin speed
 * drag, which is exactly when the preview is most useful.
 */
function resyncCycle() {
  const previous = cycle.totalMs;
  const phase = playing && previous > 0
    ? ((performance.now() - playEpoch) % previous) / previous
    : 0;
  rebuildCycle();
  if (playing) playEpoch = performance.now() - phase * cycle.totalMs;
}

function playbackIndexAt(now) {
  return frameIndexAt(cycle.starts, cycle.totalMs, now - playEpoch);
}

function advancePlayback(now) {
  if (!playing) return false;
  const index = playbackIndexAt(now);
  if (index === shownIndex) return false;
  shownIndex = index;
  scene.setAngle(...cycle.angles[index]);
  return true;
}

function startPlayback() {
  if (playing || rendering || !scene.model) return;
  rebuildCycle();
  playEpoch = performance.now();
  stepEma = 0;
  lastStepAt = 0;
  playing = true;
  startPump();
}

function stopPlayback({ rewind = true } = {}) {
  if (!playing) return;
  playing = false;
  shownIndex = -1;
  $('preview-fps').textContent = '';
  // Frame 0 is what every other still preview shows, and what the next
  // settings change would snap to anyway.
  if (rewind && scene.model) { scene.setAngle(0); scene.render(); }
}

/*
 * The achieved rate, measured from the gaps between frames actually shown — so
 * a 100 fps target on a 60 Hz display reads about 60 rather than claiming 100.
 * Smoothed, because individual gaps jitter by up to a vsync interval.
 */
let stepEma = 0;
let lastStepAt = 0;
let rateShownAt = 0;

function measureRate(now) {
  if (lastStepAt) {
    const gap = now - lastStepAt;
    stepEma = stepEma ? stepEma * 0.8 + gap * 0.2 : gap;
  }
  lastStepAt = now;
}

function updateRateReadout(now) {
  if (!playing) return;
  if (cycle.angles.length === 1) { $('preview-fps').textContent = 'still'; return; }
  if (!stepEma || now - rateShownAt < 250) return;
  rateShownAt = now;
  $('preview-fps').textContent = `${(1000 / stepEma).toFixed(1)} fps`;
}

/* ------------------------------------------------------ centre-axis flash */

/*
 * The guide flashes up whenever a Position control moves, so the reference is
 * on screen exactly while it is being used and then gets out of the way. Full
 * strength for FLASH_HOLD_MS, then faded over FLASH_FADE_MS.
 *
 * Opacity is derived from the clock for the same reason the spin is: a stepped
 * fade would resume mid-way after a backgrounded tab and stretch itself out.
 */
const FLASH_HOLD_MS = 2000;
const FLASH_FADE_MS = 2000;
let flashEndsAt = 0;
let flashOpacity = -1;

function advanceFlash(now) {
  if (!flashEndsAt) return false;
  const remaining = flashEndsAt - now;
  if (remaining <= 0) {
    stopAxisFlash();
    return true;                         // the guide just went away; redraw
  }
  const opacity = Math.min(1, remaining / FLASH_FADE_MS);
  if (opacity === flashOpacity) return false;
  scene.setAxisOpacity(opacity);
  flashOpacity = opacity;
  return true;
}

function stopAxisFlash() {
  flashEndsAt = 0;
  flashOpacity = -1;
  scene.setAxisOpacity(1);
  scene.setAxisVisible($('show-axis').checked);
}

function flashAxis() {
  // The checkbox wins: with the guide pinned on there is nothing to flash. It
  // also stays away entirely while frames are being captured, so a fade can
  // never bleed into an export.
  if ($('show-axis').checked || rendering || !scene.model) return;
  flashEndsAt = performance.now() + FLASH_HOLD_MS + FLASH_FADE_MS;
  flashOpacity = -1;                     // force the first frame to draw
  scene.setAxisVisible(true);
  startPump();
}

function schedulePreview() {
  cancelAnimationFrame(previewHandle);
  previewHandle = requestAnimationFrame(() => {
    if (!scene.model) return;
    scene.applySettings(readSettings());
    syncRenderingChrome();
    // applySettings() rebuilds the pivot rotation from scratch, so the spin
    // angle has to be re-applied here. Take it from the clock rather than from
    // the last frame drawn: a settings change also rebuilds the cycle, which
    // invalidates that index, and reusing it drops the model back to frame 0
    // on every change — most of a slider drag, at low frame rates.
    if (playing) {
      shownIndex = playbackIndexAt(performance.now());
      scene.setAngle(...cycle.angles[shownIndex]);
    } else {
      scene.setAngle(0);
    }
    scene.render();
    recordTextureFit();
    // In lockstep with the resize above. The overlay is resized immediately
    // on a settings change but the renderer's canvas only here, so between
    // the two they lay out at different sizes and the caption sits visibly
    // wrong against the render until something else redraws it.
    drawPreviewCaption();
  });
}

function applyAndPreview() {
  syncOutputs();
  syncLightingChrome();
  updateLoopInfo();
  drawPreviewCaption();          // which also refreshes the size readout
  if (playing) resyncCycle();   // frames/speed/direction may have moved
  schedulePreview();
}

/* ------------------------------------------------------------- loading */

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Say so when a lone file asked for something off the network.
 *
 * Without this the block is invisible: the model simply arrives untextured
 * and the file looks broken, when in fact it was pointing at a server.
 */
function blockedNote(stats) {
  const blocked = stats?.blocked ?? [];
  if (!blocked.length) return '';
  const what = blocked.length === 1 ? '1 external reference' : `${blocked.length} external references`;
  return ` · <span class="caution" title="${escapeHtml(blocked.join(', '))}">`
    + `${what} blocked</span>`;
}

/**
 * The second line of the model info, describing what was found in a zip.
 *
 * Worth its own line because a zip hides its contents: which model of the
 * several inside was chosen, how many textures were matched to it, and — the
 * part that has to be said out loud — how many of those were guessed from
 * filenames rather than actually referenced by the model.
 */
function archiveNote(report, stats) {
  if (!report) return '';
  const parts = [`from ${escapeHtml(baseName(report.picked))}`];
  if (report.models.length > 1) parts.push(`${report.models.length} models in zip`);

  // Only images are worth counting: a glTF also pulls its .bin out of the
  // archive, which is not something anyone thinks of as a texture.
  const textures = [...report.bound].filter((path) => IMAGE_EXTENSIONS.has(extOf(path))).length;
  if (textures) parts.push(`${textures} texture${textures === 1 ? '' : 's'}`);
  if (report.guessed.length) {
    parts.push(`<span class="caution">${report.guessed.length} matched by name</span>`);
  }
  if (report.missing.length) {
    parts.push(`<span class="caution">${report.missing.length} missing</span>`);
  }
  if (!stats.textured) parts.push('<span class="caution">no textures found</span>');
  for (const warning of report.warnings) {
    parts.push(`<span class="caution">${escapeHtml(warning)}</span>`);
  }
  return `<br><span class="small">${parts.join(' · ')}</span>`;
}


/**
 * The archive the panel is currently showing, and the combination chosen in
 * it. Both are kept so that changing one dropdown can reload the same file
 * with the rest of the choice intact.
 */
let currentFile = null;
let currentChoice = null;
/** The swaps the loaded model is actually showing, in the order asked for. */
let appliedReplacements = [];
/** What the picker is offering, kept so a replacer change can re-render. */
let currentOptions = null;
/** Replacer pairs as the picker currently shows them, trailing blank included. */
let replacers = [];
/**
 * Walk positions of the meshes switched off in the picker.
 *
 * Kept here rather than in the choice, because visibility is a view property:
 * nothing about the file changes, so a tick costs a re-render and not a
 * reload. It survives a texture change — same file, same tree, same walk —
 * and is cleared whenever the geometry underneath it could differ.
 */
let hiddenMeshes = new Set();

async function handleFile(file, choice = null) {
  if (!file) return;
  stopMeshFlash();
  // A new file is a new tree; walk positions from the last one mean nothing.
  if (!choice) hiddenMeshes = new Set();
  currentFile = file;
  currentChoice = choice;
  setBusy(`Loading ${file.name}…`);
  try {
    const { object, stats, report } = await loadModel(
      file, { creaseAngle: DEFAULT_SETTINGS.smoothAngle, choice });
    scene.setModel(object);
    scene.setHiddenMeshes(hiddenMeshes);
    pickLighting(!choice);
    scene.applySettings(readSettings());
    syncLightingChrome();
    syncRenderingChrome();
    // From a zip, the model inside names the export — "Patchwork chair" reads
    // better than "patchwork_chair_obj_0".
    modelName = stemOf(report ? report.picked : file.name);
    $('file-name').value = file.name;

    const bits = [
      `${stats.triangles.toLocaleString()} triangles`,
      `${stats.meshes} mesh${stats.meshes === 1 ? '' : 'es'}`,
    ];
    if (stats.textured) bits.push('textured');
    if (stats.vertexColours) bits.push('vertex colours');
    // Formats that keep textures in external files usually arrive bare. Inside
    // a zip those files are usually right there, so the advice only applies to
    // a lone model file.
    if (!stats.textured && !report && !SELF_CONTAINED.has(stats.ext)) {
      bits.push('no textures found — .' + stats.ext + ' often stores them separately');
    }
    $('model-info').innerHTML =
      escapeHtml(bits.join(' · ')) + blockedNote(stats) + archiveNote(report, stats);
    appliedReplacements = report?.replacements ?? [];
    showAdvanced(report);

    $('dropzone').hidden = true;
    canvas.classList.remove('empty');
    $('render').disabled = contextLost;
    discardStore();
    schedulePreview();
    if ($('preview').checked) startPlayback();   // requested before a model existed
  } catch (err) {
    console.error(err);
    $('model-info').innerHTML = `<span class="warn">${escapeHtml(friendlyError(err))}</span>`;
    appliedReplacements = [];
    // A model that will not load is exactly when the picker is wanted, so the
    // options travel with the error rather than dying with it.
    showAdvanced(err.report ?? null);
  } finally {
    setBusy('');
  }
}

/* ------------------------------------------------------------- advanced */

/**
 * Fill the Advanced picker in, and show only the rows that are a real
 * question. A bundle holding one model, one material file and no guesswork
 * has nothing to ask, so the whole section stays hidden.
 */
function showAdvanced(report) {
  const panel = $('advanced');
  // A plain file has no archive to ask about, but it can still hold a dozen
  // stacked meshes — so the two halves of this panel are gated separately
  // rather than the whole thing turning on an archive being present.
  const options = report?.options ?? null;
  currentOptions = options;

  const rows = [
    ['model', options?.models, report?.chosen?.model],
    ['coords', options?.coords, report?.chosen?.coords],
    ['texture', options?.textures, report?.chosen?.texture],
  ];

  let picking = 0;
  for (const [key, list, selected] of rows) {
    const select = $(`opt-${key}`);
    const row = $(`row-${key}`);
    fillSelect(select, list ?? [], selected);
    // One option is not a choice — except for the texture list, where the
    // single entry is only ever the "automatic" placeholder.
    const worthAsking = (list?.length ?? 0) > 1;
    row.hidden = !worthAsking;
    if (worthAsking) picking++;
  }

  // Swapping a material's texture only means anything while the material data
  // is the thing in charge; forcing one texture over the whole model already
  // overrides every binding there is.
  const swapping = !!options
    && (report.chosen?.texture ?? AUTO) === AUTO
    && (options.replaceFrom?.length ?? 0) > 1
    && (options.replaceWith?.length ?? 0) > 1;

  replacers = swapping
    ? (report.replacements ?? []).map(({ material, texture }) => ({ material, texture }))
    : [];
  if (swapping) {
    tidyReplacers();
    renderReplacers();
  }
  $('replacers').hidden = !swapping;

  const pruning = renderMeshList();

  panel.hidden = picking === 0 && !swapping && !pruning;
  if (panel.hidden) panel.open = false;

  const note = [];
  if (picking) note.push(ADVANCED_HINT);
  if (swapping) note.push(SWAP_HINT);
  if (pruning) note.push(MESH_HINT);
  $('advanced-note').textContent = panel.hidden ? '' : note.join(' ');
}

/* ----------------------------------------------------------- mesh picker */

/**
 * Fill the mesh checkboxes in. Returns whether the list is worth showing at
 * all — one mesh is not a choice.
 */
function renderMeshList() {
  const panel = $('meshes');
  const host = $('mesh-list');
  const list = scene.meshList();
  stopMeshFlash();

  // A walk position past the end of the current tree cannot refer to
  // anything, so it is dropped rather than left to skew the counts.
  for (const index of [...hiddenMeshes]) {
    if (index >= list.length) hiddenMeshes.delete(index);
  }

  if (list.length < 2) {
    host.replaceChildren();
    panel.hidden = true;
    panel.open = false;
    return false;
  }

  host.replaceChildren();
  for (const { index, label, title } of labelMeshes(list)) {
    const row = document.createElement('label');
    row.className = 'mesh-row';
    row.dataset.mesh = String(index);
    // The name and triangle count the label no longer shows live here, where
    // they cost no width.
    row.title = title;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !hiddenMeshes.has(index);
    box.dataset.mesh = String(index);
    const caption = document.createElement('span');
    caption.textContent = label;
    row.append(box, caption);
    host.append(row);
  }
  panel.hidden = false;
  syncMeshChrome(list.length);
  return true;
}

/** The summary's running count and what the one button offers to do. */
function syncMeshChrome(total) {
  $('meshes-summary').textContent = meshSummary(total, hiddenMeshes.size);
  $('mesh-toggle-all').textContent = toggleLabel(total, hiddenMeshes.size);
}

/**
 * Push the hidden set at the scene.
 *
 * Deliberately not applyAndPreview(): nothing about the timing, the frame
 * count or the output size has moved, so the loop summary has nothing to say.
 * The frame store does have to go — those frames have the mesh in them.
 */
/*
 * Warm the bundled faces at startup and redraw once they land.
 *
 * The first drawPreviewCaption() runs long before a font file has been
 * fetched, so whatever it measured was a fallback. Redrawing on fonts.ready
 * is what replaces that with the real thing.
 */
if (document.fonts?.load) {
  for (const family of BUNDLED_FONTS) waitForFont(family);
  document.fonts.ready.then(() => drawPreviewCaption());
}

function applyMeshVisibility() {
  scene.setHiddenMeshes(hiddenMeshes);
  syncMeshChrome(scene.meshList().length);
  discardStore();
  // Ticking a box under a flashing pointer moves the baseline the flash is
  // measured against, so repaint from the new one rather than let the two
  // fight over the same meshes.
  if (meshFlash) paintMeshFlash();
  else schedulePreview();
}

/* ------------------------------------------------------- flashing a mesh */

/*
 * Pointing at a checkbox blinks its mesh.
 *
 * The boxes are numbered, and a number says nothing about which part of the
 * model it is — so this is how you find out, short of ticking it and
 * comparing two renders by eye. The blink alternates the mesh against
 * whatever state it is already in: a ticked mesh winks out, an unticked one
 * winks in. Either way the thing that moves is the thing that box controls.
 *
 * Nothing here touches `hiddenMeshes`. The flash is a look, not a change, and
 * it puts the real state back the moment the pointer leaves.
 */
const FLASH_MS = 50;            // half a cycle — 50 on, 50 off, so 10 Hz

// A 10 Hz strobe is squarely in the band that bothers photosensitive people.
// It is a small part of one panel rather than the whole screen, but anyone who
// has asked for less motion gets the same information held steady instead.
const stillPlease = window.matchMedia?.('(prefers-reduced-motion: reduce)');

let meshFlash = null;           // { index, timer, inverted }

function startMeshFlash(index) {
  if (meshFlash?.index === index) return;
  stopMeshFlash();
  if (!scene.model || rendering || !Number.isFinite(index)) return;

  meshFlash = { index, timer: 0, inverted: true };
  paintMeshFlash();
  if (!stillPlease?.matches) scheduleFlashPhase();
}

/*
 * Each phase is scheduled only once the one before it has finished painting.
 *
 * A plain setInterval is the obvious way to write this and the wrong one: it
 * keeps queueing phases whether or not the last render returned, so any
 * machine where a frame costs more than FLASH_MS — a heavy model on a phone,
 * or anything falling back to software GL — backs up until the page stops
 * responding at all. Draining first turns that failure into a slower blink.
 */
function scheduleFlashPhase() {
  meshFlash.timer = setTimeout(() => {
    if (!meshFlash) return;
    meshFlash.inverted = !meshFlash.inverted;
    paintMeshFlash();
    scheduleFlashPhase();
  }, FLASH_MS);
}

function paintMeshFlash() {
  if (!meshFlash) return;
  const phase = new Set(hiddenMeshes);
  if (meshFlash.inverted) {
    if (phase.has(meshFlash.index)) phase.delete(meshFlash.index);
    else phase.add(meshFlash.index);
  }
  scene.setHiddenMeshes(phase);
  scene.render();
}

function stopMeshFlash() {
  if (!meshFlash) return;
  clearTimeout(meshFlash.timer);
  meshFlash = null;
  if (!scene.model) return;
  scene.setHiddenMeshes(hiddenMeshes);
  scene.render();
}

/* ------------------------------------------------------ texture replacers */

/**
 * Keep the replacer list tidy: no abandoned blanks, and always one spare pair
 * at the end so there is somewhere to start the next swap. Filling that spare
 * is what makes the list grow.
 *
 * The spare is withheld once every material is spoken for — an empty pair whose
 * only option is "Nothing" would be an invitation to nothing.
 */
function tidyReplacers() {
  const materials = (currentOptions?.replaceFrom ?? []).filter((o) => o.value !== NONE);
  replacers = replacers.filter((pair) => pair.material !== NONE);
  if (replacers.length < materials.length) {
    replacers.push({ material: NONE, texture: NONE });
  }
}

/** Build the Replace/With pairs, each under its own numbered heading. */
function renderReplacers() {
  const host = $('replacers');
  host.replaceChildren();
  const materials = (currentOptions?.replaceFrom ?? []).filter((o) => o.value !== NONE);
  const images = (currentOptions?.replaceWith ?? []).filter((o) => o.value !== NONE);

  replacers.forEach((pair, i) => {
    // A material already spoken for elsewhere is not offered again, so two
    // replacers can never fight over the same one.
    const taken = new Set(replacers
      .filter((other, j) => j !== i && other.material !== NONE)
      .map((other) => other.material));

    const head = document.createElement('p');
    head.className = 'replacer-head' + (pair.material === NONE ? ' empty' : '');
    head.textContent = `Texture Replacer #${i + 1}`;
    host.append(head);

    host.append(replacerRow('Replace', i, 'material', pair.material,
      [NOTHING, ...materials.filter((o) => !taken.has(o.value))]));
    host.append(replacerRow('With', i, 'texture', pair.texture, [NOTHING, ...images]));
  });
}

const NOTHING = { value: NONE, label: 'Nothing' };

function replacerRow(label, index, field, selected, list) {
  const row = document.createElement('div');
  row.className = 'row';
  const id = `opt-replace-${index}-${field}`;

  const caption = document.createElement('label');
  caption.setAttribute('for', id);
  caption.textContent = label;

  const select = document.createElement('select');
  select.id = id;
  select.dataset.replacer = String(index);
  select.dataset.field = field;
  fillSelect(select, list, selected);

  row.append(caption, select);
  return row;
}

/**
 * A replacer changed. Re-render either way — the other pairs' option lists
 * depend on this one — but only reload when the set of *complete* pairs
 * actually differs from what the model is showing. A pair with a material and
 * no texture yet is a half-finished thought, and reloading on it would throw
 * away the box that was just set.
 */
function replacerChanged(select) {
  const index = Number(select.dataset.replacer);
  const field = select.dataset.field;
  const pair = replacers[index];
  if (!pair) return;

  pair[field] = select.value;
  if (field === 'material' && select.value === NONE) pair.texture = NONE;

  tidyReplacers();
  renderReplacers();

  if (!sameReplacements(completeReplacers(), appliedReplacements)) reloadWithChoice('replacers');
}

function completeReplacers() {
  return replacers
    .filter((p) => p.material !== NONE && p.texture !== NONE)
    .map(({ material, texture }) => ({ material, texture }));
}

function sameReplacements(a, b) {
  return a.length === b.length
    && a.every((p, i) => p.material === b[i].material && p.texture === b[i].texture);
}

$('replacers').addEventListener('change', (event) => {
  const select = event.target.closest('select[data-replacer]');
  if (select) replacerChanged(select);
});

const ADVANCED_HINT =
  'Mix and match if the model looks wrong. Changing the model picks its '
  + 'matching texture setup again.';

const SWAP_HINT = 'Fill in a replacer to swap one material\u2019s texture; another opens below it.';

const MESH_HINT = 'Untick a mesh to leave it out \u2014 useful when a file holds '
  + 'several versions of the same part stacked together.';

function fillSelect(select, list, selected) {
  select.replaceChildren();
  for (const { value, label } of list) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if (value === selected) option.selected = true;
    select.append(option);
  }
  // Nothing matched, so show what is actually in force rather than implying
  // the first entry was chosen.
  if (select.selectedIndex < 0 && select.options.length) select.selectedIndex = 0;
}

/** Re-load the current archive with whatever the picker now says. */
function reloadWithChoice(changed) {
  if (!currentFile) return;
  const choice = {
    model: $('opt-model').value || null,
    coords: $('opt-coords').value || null,
    texture: $('opt-texture').value || null,
    replacements: completeReplacers(),
  };
  // Choosing a different model invalidates the other two: its material file
  // and textures are its own, and re-deriving them is the whole point of
  // "a .dae switches to the new texture setup".
  if (changed === 'model') {
    choice.coords = null;
    choice.texture = AUTO;
  }
  // A swap names materials out of one material file. Change the model or the
  // file and those names may not exist any more, so the replacers start over.
  if (changed === 'model' || changed === 'coords') {
    replacers = [];
    choice.replacements = [];
  }
  // A different model is a different tree, so the walk positions no longer
  // point at the same parts. Changing the material file or a texture leaves
  // the geometry alone, and there the hidden set is worth keeping.
  if (changed === 'model') hiddenMeshes = new Set();

  handleFile(currentFile, choice);
}

for (const key of ['model', 'coords', 'texture']) {
  $(`opt-${key}`).addEventListener('change', () => reloadWithChoice(key));
}

// Delegated, because the checkboxes are rebuilt on every load.
$('mesh-list').addEventListener('change', (e) => {
  const box = e.target;
  if (!(box instanceof HTMLInputElement) || box.dataset.mesh === undefined) return;
  const index = +box.dataset.mesh;
  if (box.checked) hiddenMeshes.delete(index);
  else hiddenMeshes.add(index);
  applyMeshVisibility();
});

/*
 * Delegated, because the rows are rebuilt per model. pointerover/out rather
 * than mouseenter/leave: those do not bubble, so delegation needs the pair
 * that does, plus a relatedTarget check so crossing from the label onto its
 * own checkbox does not read as leaving.
 */
$('mesh-list').addEventListener('pointerover', (e) => {
  const row = e.target.closest?.('.mesh-row');
  if (row) startMeshFlash(+row.dataset.mesh);
});
$('mesh-list').addEventListener('pointerout', (e) => {
  const row = e.target.closest?.('.mesh-row');
  if (row && !row.contains(e.relatedTarget)) stopMeshFlash();
});

// Touch has no hover, so there holding a box is what starts it. Mouse is left
// to pointerover alone: stopping on mouse-up would kill the flash the instant
// you ticked a box, with the pointer still sitting on it.
$('mesh-list').addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  const row = e.target.closest?.('.mesh-row');
  if (row) startMeshFlash(+row.dataset.mesh);
});
for (const type of ['pointerup', 'pointercancel']) {
  window.addEventListener(type, (e) => {
    if (e.pointerType !== 'mouse') stopMeshFlash();
  });
}
// A scrolled-away or hidden list must not keep blinking.
$('mesh-list').addEventListener('scroll', stopMeshFlash);

/* ----------------------------------------------------------------- text */

/*
 * Every caption control invalidates the frame store: the text is drawn into
 * the frames themselves, so an existing render no longer matches the
 * settings. The sliders are in RANGE_IDS and already redraw the preview, so
 * here they only have to drop the store.
 */
for (const id of ['text-top', 'text-middle', 'text-bottom', 'text-band-copy',
  'text-font', 'text-stroke', 'text-size', 'text-mode']) {
  $(id).addEventListener('input', () => {
    discardStore();
    drawPreviewCaption();
  });
}

// Picking a font that has not been fetched yet draws once with the fallback
// and again for real; both are cheap, and the alternative is a caption that
// sits at the wrong size until something else happens to redraw it.
$('text-font').addEventListener('input', async () => {
  const caption = readCaption();
  if (!caption) return;
  await waitForFont(caption.family);
  drawPreviewCaption();
});

/*
 * The font and size each mode was last set to.
 *
 * On Top wants its own defaults — black Oswald, and rather smaller letters —
 * but both controls are shared with In Front and Behind, so forcing them on
 * every switch would quietly discard whatever you had picked for the others.
 * One remembered pair per mode gives On Top its look without spending the
 * other modes' settings to do it, and hands back what you chose if you
 * switch away and come back.
 *
 * The size default is the interesting one. 100% means "ten capital Ms span
 * the image", which is right for a caption *over* a picture and much too big
 * for a paragraph above one: a sentence at 100% grew a band taller than the
 * image it captioned. 50% puts a typical caption at three or four lines, the
 * proportion the format is usually seen in.
 */
const OSWALD = Array.from($('text-font').options)
  .find((o) => o.value.startsWith('Oswald'))?.value ?? $('text-font').value;
const STYLE_BY_MODE = {
  front: { font: $('text-font').value, size: $('text-size').value },
  behind: { font: $('text-font').value, size: $('text-size').value },
  ontop: { font: OSWALD, size: '50' },
};
let lastTextMode = $('text-mode').value;

function rememberTextStyle() {
  if (lastTextMode === 'off') return;
  STYLE_BY_MODE[lastTextMode] = { font: $('text-font').value, size: $('text-size').value };
}
$('text-font').addEventListener('change', rememberTextStyle);
$('text-size').addEventListener('change', rememberTextStyle);

$('text-mode').addEventListener('change', async () => {
  const mode = $('text-mode').value;
  $('text-blocks').hidden = mode !== 'front' && mode !== 'behind';
  $('text-band').hidden = mode !== 'ontop';
  $('text-style').hidden = mode === 'off';
  $('text-stroke-row').hidden = mode === 'ontop';

  const style = STYLE_BY_MODE[mode];
  if (style) {
    $('text-font').value = style.font;
    $('text-size').value = style.size;
    syncOutputs();               // the size reading follows the slider
  }
  lastTextMode = mode;

  discardStore();
  drawPreviewCaption();
  // The remembered font may not have been fetched yet, and until it is the
  // caption is measured from a fallback and sized wrong. Draw again once it
  // has arrived, exactly as picking a font by hand does.
  const caption = readCaption();
  if (caption) {
    await waitForFont(caption.family);
    drawPreviewCaption();
  }
});
window.addEventListener('blur', stopMeshFlash);

$('mesh-toggle-all').addEventListener('click', () => {
  const total = scene.meshList().length;
  hiddenMeshes = hiddenMeshes.size >= total
    ? new Set()
    : new Set(Array.from({ length: total }, (_, i) => i));
  renderMeshList();
  applyMeshVisibility();
});

function discardStore() {
  store = null;
  setSaveEnabled(false);
  $('store-info').textContent = 'No frames rendered yet.';
  $('save-info').textContent = '';
}

/* --------------------------------------------------- typing a value in */

/**
 * Ranges that can be *typed* into a slider's reading, where those are wider
 * than the slider itself.
 *
 * The two jobs are different. A slider has to spend its width on the values
 * worth dragging through, so Zoom stops at 5x; but a 200x close-up on one
 * rivet is a real thing to want, and making the slider reach it would turn
 * every ordinary adjustment into a two-pixel target. So the slider keeps the
 * useful range and typing is the way past it.
 *
 * Anything not listed is still editable — its typed range is simply the
 * slider's own.
 */
const TEXT_RANGE = {
  fov: [1, 180],
  zoom: [0.1, 1000],
  speed: [0.001, 100],
  'pos-x': [-100, 100], 'pos-y': [-100, 100], 'pos-z': [-100, 100],
  /*
   * Rendering. Light intensities and the specular colour are plain
   * multipliers that three.js never clamps, so these ceilings are "long past
   * any visible difference" rather than a limit of the engine — ambient alone
   * is white at about 3. Shininess is the Blinn-Phong exponent, where the
   * highlight is narrower than a pixel well before a thousand.
   */
  ambient: [0, 100], key: [0, 100], fill: [0, 100], rim: [0, 100],
  specular: [0, 100], shininess: [1, 1000],
  'env-intensity': [0, 100], exposure: [0.01, 100], brightness: [0, 1000],
  'normal-strength': [0, 100], 'emission-strength': [0, 1000],
  'background-size': [0, 1000],
};

/** Each slider's own range, captured before anything widens it. */
const baseRanges = new Map(RANGE_IDS.map((id) => {
  const el = $(id);
  return [id, { min: +el.min, max: +el.max, step: el.step }];
}));

function textRange(id) {
  const base = baseRanges.get(id);
  return TEXT_RANGE[id] ?? [base.min, base.max];
}

/**
 * Put a value on a slider, stretching the slider if it will not otherwise
 * reach.
 *
 * The input keeps holding the value — there is no second copy of it to fall
 * out of step with the control. The cost is that a slider showing an extreme
 * is briefly coarse, which is the honest trade: you are at 250x because you
 * typed 250x, and dragging back to the left end returns both the value and
 * the normal scale.
 */
function setSliderValue(id, value) {
  const el = $(id);
  const base = baseRanges.get(id);
  const outside = value < base.min || value > base.max;
  const step = +base.step;
  // A range input snaps whatever you assign to its step grid, so a typed
  // 0.001 on a 0.01 slider would quietly become 0.
  const offGrid = step > 0 && Math.abs(value / step - Math.round(value / step)) > 1e-9;

  el.min = Math.min(base.min, value);
  el.max = Math.max(base.max, value);
  el.step = (outside || offGrid) ? 'any' : base.step;
  el.value = value;
}

/**
 * Give a stretched slider its usual scale back once the value fits again.
 *
 * Deliberately on `change` and not `input`: rescaling mid-drag would move the
 * thumb out from under the finger holding it.
 */
function normaliseRange(id) {
  const el = $(id);
  const base = baseRanges.get(id);
  const value = +el.value;
  if (value >= base.min && value <= base.max) { el.min = base.min; el.max = base.max; }
  const step = +base.step;
  if (!(step > 0) || Math.abs(value / step - Math.round(value / step)) < 1e-9) {
    el.step = base.step;
  }
}

/**
 * Double-clicking a slider's reading turns it into a box you can type in.
 *
 * The typed value goes back out as an ordinary `input` event on the slider
 * rather than through a private path, so everything already watching that
 * control — the preview, the frame store, the axis flash — reacts exactly as
 * it does to a drag, with no second set of rules to keep in step.
 */
function editNumber(id) {
  const out = $(`${id}-out`);
  if (out.hidden) return;                       // already editing this one
  const [lo, hi] = textRange(id);

  const box = document.createElement('input');
  box.type = 'number';
  box.className = 'number-edit';
  box.value = String(+$(id).value);
  box.min = lo;
  box.max = hi;
  box.step = 'any';
  box.title = `${lo} to ${hi}`;

  let closed = false;
  const close = (commit) => {
    if (closed) return;                         // blur fires again on removal
    closed = true;
    const typed = parseFloat(box.value);
    box.remove();
    out.hidden = false;
    if (!commit || !Number.isFinite(typed)) return;
    setSliderValue(id, Math.min(hi, Math.max(lo, typed)));
    // `typed` marks this as not a drag, which exempts it from the speed
    // slider's snap-to-stopped.
    $(id).dispatchEvent(new CustomEvent('input', { bubbles: true, detail: { typed: true } }));
    $(id).dispatchEvent(new Event('change', { bubbles: true }));
  };

  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); close(true); }
    else if (e.key === 'Escape') { e.preventDefault(); close(false); }
  });
  box.addEventListener('blur', () => close(true));

  out.hidden = true;
  out.after(box);
  box.focus();
  box.select();
}

/* -------------------------------------------------------------- events */

/*
 * The slider's bottom end snaps to a dead stop rather than offering speeds
 * nobody wants. Typing is exempt: 0.001 r/s is a deliberate choice by the time
 * someone has entered it by hand. Registered before the listener below so the
 * value is already corrected when the preview reads it.
 */
$('speed').addEventListener('input', (e) => {
  if (e.detail?.typed) return;
  // Rewrite the control, not just the reading, so the thumb visibly lands on
  // zero rather than sitting in a dead zone that behaves as stopped.
  if (+$('speed').value > 0 && +$('speed').value < MIN_RPS) $('speed').value = 0;
});

for (const id of RANGE_IDS) $(id).addEventListener('input', applyAndPreview);

for (const id of RANGE_IDS) {
  $(`${id}-out`).addEventListener('dblclick', () => editNumber(id));
  $(`${id}-out`).title = 'Double-click to type a value';
  $(id).addEventListener('change', () => normaliseRange(id));
}
for (const id of ['up-axis', 'direction', 'quality', 'background', 'background-mode',
  'width', 'height', 'tumble-dir', 'tumble-ratio', 'roll-dir', 'roll-ratio']) {
  $(id).addEventListener('input', () => { discardStore(); applyAndPreview(); });
}

for (const id of POSITION_IDS) {
  $(id).addEventListener('input', () => { discardStore(); flashAxis(); });
}

for (const id of PICTURE_IDS) $(id).addEventListener('input', discardStore);

/* ---------------------------------------------------------- background */

/** Show only the rows that belong to the chosen kind of background. */
function syncBackgroundChrome() {
  $('image').dataset.background = $('background-mode').value;
}
$('background-mode').addEventListener('input', syncBackgroundChrome);

const PICTURE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp']);
const PICTURE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp']);

/**
 * Decode a chosen picture and make it the background.
 *
 * Decoded up front, once, into an ImageBitmap: every exported frame draws it,
 * and a picture that will not decode is better reported now than discovered
 * halfway through a render. The previous picture is kept until the new one
 * has proved itself.
 */
async function chooseBackdropPicture(file) {
  if (!file) return;
  const name = $('background-name');
  const known = PICTURE_TYPES.has(file.type)
    || PICTURE_EXTENSIONS.has(extOf(file.name));
  if (!known) {
    name.textContent = `${file.name} is not a JPEG, PNG, WebP or BMP`;
    return;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    name.textContent = `Could not read ${file.name}`;
    return;
  }
  if (backdropPicture) {
    backdropPicture.bitmap.close();
    URL.revokeObjectURL(backdropPicture.url);
  }
  backdropPicture = { bitmap, url: URL.createObjectURL(file), name: file.name };
  $('backdrop-image').src = backdropPicture.url;
  name.textContent = file.name;
  name.title = `${file.name} · ${bitmap.width} × ${bitmap.height}`;
  discardStore();
  applyAndPreview();
}

$('background-browse').addEventListener('click', () => $('background-file').click());
$('background-file').addEventListener('change', (e) => {
  chooseBackdropPicture(e.target.files[0]);
  // Cleared so that choosing the same file again still counts as a change.
  e.target.value = '';
});

$('square').addEventListener('change', () => {
  if ($('square').checked) $('height').value = $('width').value;
  applyAndPreview();
});
$('width').addEventListener('input', () => {
  if ($('square').checked) $('height').value = $('width').value;
});
$('preset').addEventListener('change', () => {
  const size = $('preset').value;
  if (!size) return;
  $('width').value = size;
  $('height').value = size;
  discardStore();
  applyAndPreview();
});

$('reset-view').addEventListener('click', () => {
  setSliderValue('elevation', DEFAULT_SETTINGS.elevation);
  setSliderValue('start', DEFAULT_SETTINGS.startAngle);
  $('up-axis').value = DEFAULT_SETTINGS.upAxis;
  setSliderValue('fov', DEFAULT_SETTINGS.fov);
  setSliderValue('zoom', DEFAULT_SETTINGS.zoom);
  discardStore();
  applyAndPreview();
});

$('reset-position').addEventListener('click', () => {
  setSliderValue('pos-x', DEFAULT_SETTINGS.posX);
  setSliderValue('pos-y', DEFAULT_SETTINGS.posY);
  setSliderValue('pos-z', DEFAULT_SETTINGS.posZ);
  setSliderValue('pitch', DEFAULT_SETTINGS.pitch);
  setSliderValue('yaw', DEFAULT_SETTINGS.yaw);
  setSliderValue('roll', DEFAULT_SETTINGS.roll);
  discardStore();
  applyAndPreview();
  flashAxis();
});

/*
 * Everything in the Rendering section back to where it started, the debug
 * switches included: a layer left off by accident is the kind of thing a
 * reset is for.
 */
function resetRendering() {
  const d = DEFAULT_SETTINGS;
  setSliderValue('ambient', d.ambient);
  setSliderValue('key', d.keyLight);
  setSliderValue('fill', d.fillLight);
  setSliderValue('rim', d.rimLight);
  setSliderValue('specular', d.specular);
  setSliderValue('shininess', d.shininess);
  setSliderValue('env-intensity', d.envIntensity);
  setSliderValue('env-rotation', d.envRotation);
  setSliderValue('exposure', d.exposure);
  setSliderValue('shadow-darkness', d.shadowDarkness);
  setSliderValue('normal-strength', d.normalStrength);
  setSliderValue('emission-strength', d.emissionStrength);
  setSliderValue('brightness', d.brightness * 100);
  setLightAngles();
  $('quality').value = String(d.supersample);
  // Back to what the model asks for. Every light is at its default now, which
  // is each path's first preset, so there is nothing to carry across.
  $('shading').value = lightingMode = suggestedLighting ?? 'classic';
  $('environment').value = d.environment;
  $('tone-mapping').value = d.toneMapping;
  $('key-color').value = d.keyColor;
  $('fill-color').value = d.fillColor;
  $('ambient-color').value = d.ambientColor;
  $('shadows').value = d.shadows;
  $('debug-view').value = d.view;
  $('texture-filter').value = d.textureFilter;
  $('double-sided').checked = d.doubleSided;
  for (const key of Object.keys(layerState)) layerState[key] = true;
  renderLayerList();
  applyCapabilityLimits();
}

/*
 * The light angles' defaults are fractional — the old vectors, exactly — and
 * an HTML value attribute can only approximate them, so they are written in
 * from the settings instead. step="any" is what lets a range hold them.
 */
function setLightAngles() {
  const d = DEFAULT_SETTINGS;
  $('key-azimuth').value = d.keyAzimuth;
  $('key-height').value = d.keyHeight;
  $('fill-azimuth').value = d.fillAzimuth;
  $('fill-height').value = d.fillHeight;
}

$('reset-render').addEventListener('click', () => {
  resetRendering();
  discardStore();
  applyAndPreview();
});

for (const id of RENDER_CHOICE_IDS) {
  $(id).addEventListener('input', () => { discardStore(); applyAndPreview(); });
}

/* --------------------------------------------------- rendering chrome */

/**
 * One checkbox per material layer, each with how many of the model's
 * materials use it. Rebuilt whenever that could change: a new model, or a
 * different Materials path — Classic keeps only the colour map, so most
 * layers honestly have nothing to switch there.
 */
function renderLayerList() {
  const list = $('layer-list');
  const { counts } = scene.model ? scene.layerCounts() : { counts: {} };
  list.replaceChildren(...LAYERS.map(({ key, label }) => {
    const count = counts[key] ?? 0;
    const row = document.createElement('label');
    row.className = 'layer-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = layerState[key];
    box.dataset.layer = key;
    const text = document.createElement('span');
    text.textContent = label;
    const tally = document.createElement('span');
    tally.className = 'count';
    tally.textContent = scene.model ? String(count) : '';
    row.append(box, text, tally);
    if (scene.model && !count) {
      row.classList.add('unused');
      row.title = 'No material on this model uses this layer';
    }
    return row;
  }));
}

$('layer-list').addEventListener('change', (e) => {
  const key = e.target?.dataset?.layer;
  if (!key) return;
  layerState[key] = e.target.checked;
  discardStore();
  applyAndPreview();
});

/**
 * Say which Lighting is in use and whether the model picked it, and refresh
 * the layer counts. Only touches the DOM when the answer changes, since this
 * runs on every preview.
 */
let chromeKey = '';
function syncRenderingChrome() {
  if (!scene.model) return;
  const { counts, total, shading } = scene.layerCounts();
  const key = JSON.stringify([shading, counts, total, suggestedLighting]);
  if (key === chromeKey) return;
  chromeKey = key;
  const what = shading === 'physical'
    ? `Realistic, ${total} material${total === 1 ? '' : 's'} lit by the environment too`
    : 'Retro, colour and colour map only, lit as it always has been';
  $('shading-note').textContent = shading === suggestedLighting
    ? `Picked for this model: ${what}.`
    : `Using ${what}. This model would pick ${LIGHTING_NAMES[suggestedLighting]}.`;
  renderLayerList();
}

/* ------------------------------------------------------------ lighting */

const LIGHTING_NAMES = { physical: 'Realistic', classic: 'Retro' };

/** Where each setting a preset decides lives among the controls. */
const PRESET_CONTROLS = {
  ambient: 'ambient', ambientColor: 'ambient-color',
  keyLight: 'key', keyAzimuth: 'key-azimuth', keyHeight: 'key-height', keyColor: 'key-color',
  fillLight: 'fill', fillAzimuth: 'fill-azimuth', fillHeight: 'fill-height',
  fillColor: 'fill-color',
  rimLight: 'rim', specular: 'specular', shininess: 'shininess',
  environment: 'environment', envIntensity: 'env-intensity', envRotation: 'env-rotation',
  toneMapping: 'tone-mapping', exposure: 'exposure',
  shadows: 'shadows', shadowDarkness: 'shadow-darkness',
};

// Without half-float render targets there are no environments (see
// applyCapabilityLimits), so a preset asking for one gets None here.
const fitPreset = (values) =>
  (scene.caps.halfFloat ? values : { ...values, environment: 'none' });

/** Put a preset's lighting on the controls. The caller redraws. */
function applyPreset(preset) {
  const values = fitPreset(presetValues(preset, DEFAULT_SETTINGS));
  for (const key of PRESET_KEYS) {
    const id = PRESET_CONTROLS[key];
    if (baseRanges.has(id)) setSliderValue(id, values[key]);
    else $(id).value = values[key];
  }
}

/** The preset the controls currently match exactly, if any. */
function currentPreset(shading = $('shading').value) {
  return matchingPreset(shading, readSettings(), DEFAULT_SETTINGS, fitPreset);
}

/** The eight buttons, rebuilt only when the Lighting changes. */
let presetsFor = null;
function renderPresets() {
  const shading = $('shading').value;
  if (shading === presetsFor) return;
  presetsFor = shading;
  $('presets').replaceChildren(...PRESETS[shading].map((preset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = preset.label;
    button.title = preset.title;
    button.dataset.preset = preset.id;
    button.setAttribute('aria-pressed', 'false');
    return button;
  }));
}

$('presets').addEventListener('click', (e) => {
  const id = e.target.closest?.('button')?.dataset.preset;
  const preset = PRESETS[$('shading').value].find((p) => p.id === id);
  if (!preset) return;
  applyPreset(preset);
  discardStore();
  applyAndPreview();
});

function setData(el, key, value) {
  if (el.dataset[key] !== value) el.dataset[key] = value;
}

/**
 * Show only the Advanced Lighting rows that do something under the current
 * settings, and light up the preset they match. Cheap enough for every
 * slider movement, which is how a hand-tuned light drops its preset's
 * highlight the moment it stops being that preset.
 */
function syncLightingChrome() {
  const section = $('rendering');
  const shading = $('shading').value;
  const lit = shading === 'physical' && $('environment').value !== 'none';
  const chosenTone = $('tone-mapping').value;
  const tone = chosenTone === 'auto' ? (shading === 'physical' ? 'neutral' : 'none') : chosenTone;
  setData(section, 'shading', shading);
  setData(section, 'environment', lit ? 'lit' : 'none');
  setData(section, 'tone', tone === 'none' ? 'none' : 'on');
  setData(section, 'shadows', $('shadows').value);
  renderPresets();
  const active = currentPreset()?.id ?? '';
  for (const button of $('presets').children) {
    const pressed = String(button.dataset.preset === active);
    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
  }
}

/*
 * Switching Lighting. Each path has presets of its own, so lighting that is
 * still exactly one of the old path's presets becomes the new path's default
 * — Glossy means nothing under Realistic. Anything tuned by hand is kept as
 * it is: it was work, and the sliders it set still mean the same thing.
 */
let lightingMode = $('shading').value;
function lightingSwitched() {
  const from = lightingMode;
  const to = $('shading').value;
  lightingMode = to;
  if (from === to) return;
  if (currentPreset(from)) applyPreset(PRESETS[to][0]);
}

$('shading').addEventListener('input', () => {
  lightingSwitched();
  discardStore();
  applyAndPreview();
});

/*
 * Each model picks its Lighting as it loads: Realistic when its materials are
 * physically based, Retro otherwise, including whenever the file does not
 * say. Re-picking the texture or material file of the same model keeps a
 * choice made by hand, unless the answer itself changed.
 */
let suggestedLighting = null;
function pickLighting(newFile) {
  const suggested = scene.resolveShading('auto');
  const changed = suggested !== suggestedLighting;
  suggestedLighting = suggested;
  if ((newFile || changed) && $('shading').value !== suggested) {
    $('shading').value = suggested;
    lightingSwitched();
  }
}

// Preview-only guides: deliberately not part of readSettings(), so toggling
// them neither re-renders nor throws away an existing frame store.
$('show-border').addEventListener('change', () => {
  $('frame').classList.toggle('show-border', $('show-border').checked);
});

$('preview').addEventListener('change', () => {
  if ($('preview').checked) startPlayback();
  else stopPlayback();
});

$('show-axis').addEventListener('change', () => {
  stopAxisFlash();          // applies the checkbox state and clears any fade
  scene.render();
});

/*
 * Clicking the wordmark plays a short theme. The Audio object is built on the
 * first click rather than at load: it is 10 KB nobody needs unless they ask for
 * it, and a click is the user gesture browsers require before audio may start
 * at all. Rewinding first makes an impatient second click restart it instead of
 * doing nothing.
 */
let theme = null;
$('app-logo').addEventListener('click', () => {
  if (!theme) theme = new Audio('./content/Funee%20GIF%20Maker.opus');
  theme.currentTime = 0;
  // Safari has never played Opus in an Ogg container; there is nothing to do
  // about that here beyond not letting the rejection reach the console.
  theme.play().catch(() => {});
});

$('browse').addEventListener('click', () => $('file-input').click());
$('browse-empty').addEventListener('click', () => $('file-input').click());
$('file-input').accept = FILE_ACCEPT;
$('file-input').addEventListener('change', (e) => handleFile(e.target.files[0]));

['dragenter', 'dragover'].forEach((type) =>
  document.addEventListener(type, (e) => { e.preventDefault(); app.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((type) =>
  document.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'drop' || e.target === document.documentElement) app.classList.remove('dragover');
  }));
document.addEventListener('drop', (e) => handleFile(e.dataTransfer?.files?.[0]));

/* Drag to orbit. Pointer events cover mouse and touch in one path. */
let dragging = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!scene.model) return;
  dragging = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = (e.clientX - dragging.x) * 0.5;
  const dy = (e.clientY - dragging.y) * 0.5;
  dragging = { x: e.clientX, y: e.clientY };
  $('start').value = (((+$('start').value + dx) % 360) + 360) % 360;
  // Vertical drag is inverted relative to the horizontal one: dragging down
  // raises the camera so the model tips its top toward you.
  $('elevation').value = Math.max(-89, Math.min(89, +$('elevation').value + dy));
  applyAndPreview();
});
for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, () => { dragging = null; canvas.classList.remove('dragging'); });
}

/*
 * Scroll over the preview to zoom: one wheel notch is one step of the Zoom
 * slider, up to zoom in. A notch is about 100 pixels, or 3 lines in Firefox;
 * a quick spin can arrive as one event carrying several notches, so the count
 * comes from the size of the delta. A trackpad sends a stream of small deltas
 * instead, and those are saved up until they add to a notch's worth.
 *
 * The wheel stops at the slider's own ends, but never snaps back a value that
 * was typed past them. The change goes out as an ordinary input event on the
 * slider, so it behaves exactly like dragging it.
 */
const WHEEL_NOTCH = 100;
const WHEEL_NOTCH_LINES = 3;
let wheelSaved = 0;
$('stage').addEventListener('wheel', (e) => {
  if (!scene.model || e.ctrlKey) return;     // ctrl+wheel stays the browser's zoom
  e.preventDefault();                        // the panel must not scroll instead
  const size = Math.abs(e.deltaY);
  let ticks;
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    ticks = Math.sign(e.deltaY);
  } else if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    ticks = Math.sign(e.deltaY) * Math.max(1, Math.round(size / WHEEL_NOTCH_LINES));
  } else if (size >= WHEEL_NOTCH / 2) {
    ticks = Math.sign(e.deltaY) * Math.max(1, Math.round(size / WHEEL_NOTCH));
    wheelSaved = 0;
  } else {
    wheelSaved += e.deltaY;
    ticks = Math.trunc(wheelSaved / WHEEL_NOTCH);
    wheelSaved -= ticks * WHEEL_NOTCH;
  }
  if (!ticks) return;

  const zoom = $('zoom');
  const { min, max, step } = baseRanges.get('zoom');
  const value = +zoom.value;
  const next = Math.min(Math.max(max, value), Math.max(Math.min(min, value),
    Math.round((value - ticks * +step) * 100) / 100));
  if (next === value) return;
  setSliderValue('zoom', next);
  zoom.dispatchEvent(new Event('input', { bubbles: true }));
  zoom.dispatchEvent(new Event('change', { bubbles: true }));
}, { passive: false });

/* -------------------------------------------------------- render frames */

$('render').addEventListener('click', async () => {
  if (!scene.model || rendering) return;
  rendering = true;
  cancelRequested = false;
  stopAxisFlash();          // a fade must not carry into the capture
  stopMeshFlash();          // nor a blinking mesh
  stopPlayback({ rewind: false });

  discardStore();

  // Everything from here is inside the try, so the finally below always gets
  // to put the buttons back. Left outside it, anything that threw between
  // disabling Render and entering the try would leave the app unable to
  // render at all, with no message and nothing to do but reload.
  try {
    $('render').disabled = true;
    $('cancel').disabled = false;

    scene.applySettings(readSettings());
    const spin = readSpin();

    // Every frame measures the font. Waiting here rather than inside
    // makeResolver() keeps the per-frame path synchronous, and means the
    // whole capture agrees with itself instead of the first few frames
    // using a fallback.
    const caption = readCaption();
    if (caption) await waitForFont(caption.family);

    const started = performance.now();

    const result = await captureFrames(scene, spin, (done, total) => {
      setProgress(done, total);
      $('store-info').textContent = `Rendering frame ${done} of ${total}…`;
      return !cancelRequested;
    }, caption, readBackdrop());

    if (!result) {
      $('store-info').textContent = 'Cancelled.';
    } else {
      store = result;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      $('store-info').textContent =
        `${result.blobs.length} frames · ${result.width}×${result.height} · ` +
        `${(storeSize(result) / 1048576).toFixed(1)} MB held · rendered in ${seconds}s`;
      setSaveEnabled(true);
    }
  } catch (err) {
    console.error(err);
    $('store-info').innerHTML = `<span class="warn">${escapeHtml(friendlyError(err))}</span>`;
  } finally {
    setProgress(1, 1);
    rendering = false;
    $('render').disabled = contextLost;
    $('cancel').disabled = true;
    scene.setAngle(0);
    scene.render();
    if ($('preview').checked) startPlayback();
  }
});

$('cancel').addEventListener('click', () => { cancelRequested = true; });

/* --------------------------------------------------------------- saving */

document.querySelectorAll('.save').forEach((button) => {
  button.addEventListener('click', () => saveAs(button.dataset.format));
});

async function saveAs(format) {
  if (!store) return;
  const spin = readSpin();
  const loopWord = spin.turns > 1 ? `loop of ${spin.turns} spins` : 'turn';
  const settings = readSettings();
  setBusy(`Building ${FORMAT_LABELS[format]}…`);
  setSaveEnabled(false);

  try {
    let blob;
    let extension = format;
    let note = '';

    if (format === 'gif') {
      const frames = await decodeFrames(store);
      const rgb = hexToRgb(settings.background);
      const { blob: gifBlob, info } = encodeGif(frames, {
        rps: spin.rps,
        transparent: settings.transparent,
        background: rgb,
        dither: $('dither').checked,
      });
      blob = gifBlob;
      note = `${info.totalMs} ms per ${loopWord}`;
    } else if (format === 'webp') {
      const frames = await decodeFrames(store);
      const info = loopSummary(frames.length, spin.rps, 'webp');
      const stills = [];
      for (let i = 0; i < frames.length; i++) {
        stills.push({
          data: await encodeStill(frames[i], { quality: 0.9 }),
          duration: info.delays[i],
        });
      }
      blob = new Blob([muxAnimation(stills, {
        width: store.width, height: store.height, loop: 0,
      })], { type: 'image/webp' });
      note = `${info.totalMs} ms per ${loopWord}`;
    } else if (format === 'apng') {
      // No decode and no re-encode: the store is already PNG.
      const info = loopSummary(store.blobs.length, spin.rps, 'apng');
      const frames = [];
      for (let i = 0; i < store.blobs.length; i++) {
        frames.push({
          data: new Uint8Array(await store.blobs[i].arrayBuffer()),
          delay: info.delays[i],
        });
      }
      blob = new Blob([muxApng(frames, {
        width: store.width, height: store.height, loop: 0,
      })], { type: 'image/apng' });
      extension = 'png';
      note = `${info.totalMs} ms per ${loopWord} · lossless`;
    } else if (format === 'zip') {
      blob = await encodeZip(store, { name: `${modelName}_frames` });
      note = `${store.blobs.length} PNG frames`;
    }

    download(blob, `${modelName}_spin.${extension}`);
    $('save-info').textContent =
      `Saved ${modelName}_spin.${extension} — ${(blob.size / 1024).toFixed(0)} KB` +
      (note ? ` · ${note}` : '');
  } catch (err) {
    console.error(err);
    $('save-info').innerHTML = `<span class="warn">${escapeHtml(friendlyError(err))}</span>`;
  } finally {
    setBusy('');
    setSaveEnabled(true);
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function hexToRgb(hex) {
  const value = parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/* ------------------------------------------------ what the browser lacks */

/*
 * The checks that stop the app from running at all live in src/preflight.js,
 * which runs before this module and shows its messages under the file
 * browser. These are the problems only the running app can see. A lost
 * feature is switched off and reported there in orange; anything smaller —
 * no MSAA, no anisotropic filtering, textures shrunk to fit — is only
 * recorded for the Browser check list, because it changes nothing anyone
 * needs to act on.
 */

/**
 * Environment lighting needs half-float rendering. Without it the options
 * are disabled and Environment is set to None. Re-run after a reset, which
 * would otherwise put an unsupported choice back.
 */
function applyCapabilityLimits() {
  if (scene.caps.halfFloat) return;
  for (const option of $('environment').options) {
    if (option.value !== 'none') option.disabled = true;
  }
  $('environment').value = 'none';
  window.Funee?.raise('W3');
}

/**
 * Whether this browser can encode WebP, asked once at start-up.
 *
 * Safari cannot. It hands back a PNG instead, which encodeStill() already
 * refuses — but only after someone has clicked Save and waited. Knowing up
 * front turns that into a disabled button and one orange line.
 */
async function checkWebp() {
  let supported = false;
  try {
    // Drawn on first: Chrome refuses to encode a canvas that has no context.
    const probe = new OffscreenCanvas(1, 1);
    probe.getContext('2d').fillRect(0, 0, 1, 1);
    const blob = await probe.convertToBlob({ type: 'image/webp' });
    supported = blob.type === 'image/webp';
  } catch {
    supported = false;
  }
  if (window.Funee?.extras) window.Funee.extras.webp = supported;
  if (supported) return;
  const button = document.querySelector('.save[data-format="webp"]');
  button.dataset.unsupported = 'true';
  button.disabled = true;
  button.title = 'This browser cannot make WebP files.';
  window.Funee?.raise('W4');
}

/**
 * Note, for the Browser check only, when three.js has had to shrink the
 * model's textures to fit the graphics card. Softer textures are not worth
 * interrupting anyone over, but they are worth being able to find out about.
 */
let textureCheckedFor = null;
function recordTextureFit() {
  const extras = window.Funee?.extras;
  if (!extras || textureCheckedFor === scene.model) return;
  const side = scene.oversizedTexture();
  extras.oversizedTexture = scene.model ? side : null;
  // Settled once found: the textures will not get any smaller.
  if (side) textureCheckedFor = scene.model;
}

/*
 * The graphics card dropped the page: a driver reset, or a model too large
 * for graphics memory. Nothing drawn in 3D comes back without a reload, so
 * say that plainly, stop any render in progress, and leave the frames
 * already rendered saveable — those are ordinary memory, not the GPU's.
 */
let contextLost = false;
canvas.addEventListener('webglcontextlost', () => {
  contextLost = true;
  cancelRequested = true;
  stopPlayback({ rewind: false });
  $('render').disabled = true;
  window.Funee?.contextLost();
});

/* ----------------------------------------------------------------- init */

canvas.classList.add('empty');
setLightAngles();
renderLayerList();
syncBackgroundChrome();
applyCapabilityLimits();
scene.applySettings(readSettings());
applyAndPreview();
// For the Browser check list. Set before checkWebp(), which fills in its
// answer — immediately, if the browser has no OffscreenCanvas at all.
if (window.Funee) window.Funee.extras = { ...scene.caps, webp: null };
checkWebp();

// The last step: tells src/preflight.js the app started. Anything that threw
// before this line is what its "The app did not start" panel reports.
window.Funee?.ready();
