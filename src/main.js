/**
 * App wiring: controls -> scene -> frame store -> exports.
 *
 * The flow deliberately separates rendering from saving. "Render frames" fills
 * the store once; each Save button then assembles that store into a format
 * without re-rendering, so you can export a GIF and a WebP and an APNG from a
 * single render.
 */

import { SpinScene, DEFAULT_SETTINGS } from './scene.js';
import { loadModel, FILE_ACCEPT, extensionOf, SELF_CONTAINED } from './loaders.js';
import { captureFrames, decodeFrames, storeSize } from './capture.js';
import { loopSummary, FPS_LIMIT, frameAngles, frameDelaysMs,
         frameStarts, frameIndexAt } from './encoders/timing.js';
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

const RANGE_IDS = ['elevation', 'start', 'fov', 'zoom', 'speed', 'frames',
  'ambient', 'key', 'fill', 'rim', 'specular', 'shininess',
  'pos-x', 'pos-y', 'pos-z', 'pitch', 'yaw', 'roll'];

// Position sliders change the render, so they must also drop the frame store.
const POSITION_IDS = ['pos-x', 'pos-y', 'pos-z', 'pitch', 'yaw', 'roll'];

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
    fov: +$('fov').value,
    zoom: +$('zoom').value,
    background: $('background').value,
    transparent: $('transparent').checked,
    shadeTexture: $('textures').checked,
    ambient: +$('ambient').value,
    keyLight: +$('key').value,
    fillLight: +$('fill').value,
    rimLight: +$('rim').value,
    specular: +$('specular').value,
    shininess: +$('shininess').value,
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
function readSpin() {
  return {
    frames: clampInt($('frames').value, 1, 240, 48),
    rps: +$('speed').value,
    clockwise: $('direction').value === 'cw',
  };
}

function clampInt(value, lo, hi, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/* ------------------------------------------------------------- display */

function syncOutputs() {
  $('elevation-out').textContent = `${$('elevation').value}°`;
  $('start-out').textContent = `${$('start').value}°`;
  $('fov-out').textContent = `${$('fov').value}°`;
  $('zoom-out').textContent = `${(+$('zoom').value).toFixed(2)}×`;
  $('speed-out').textContent = `${(+$('speed').value).toFixed(2)} r/s`;
  $('frames-out').textContent = $('frames').value;
  for (const id of ['ambient', 'key', 'fill', 'rim', 'specular']) {
    $(`${id}-out`).textContent = (+$(id).value).toFixed(2);
  }
  $('shininess-out').textContent = $('shininess').value;
  for (const id of ['pos-x', 'pos-y', 'pos-z']) {
    $(`${id}-out`).textContent = (+$(id).value).toFixed(2);
  }
  for (const id of ['pitch', 'yaw', 'roll']) {
    $(`${id}-out`).textContent = `${$(id).value}°`;
  }
}

function updateLoopInfo() {
  const spin = readSpin();
  // GIF has the coarsest timing grid, so it's the honest one to quote.
  const info = loopSummary(spin.frames, spin.rps, 'gif');
  const fps = info.fps.toFixed(1);
  const seconds = (info.totalMs / 1000).toFixed(2);
  const fpsHtml = info.fps > FPS_LIMIT
    ? `<span class="warn">${fps} fps</span>`
    : `${fps} fps`;
  $('loop-info').innerHTML =
    `${spin.frames} frames · one full turn every ${seconds} s · ${fpsHtml} · ` +
    `${info.actualRps.toFixed(3)} rounds/s`;
}

function updateViewSize() {
  const s = readSettings();
  $('view-size').textContent = `${s.width} × ${s.height}`;
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
  document.querySelectorAll('.save').forEach((b) => { b.disabled = !enabled; });
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
  cycle.angles = frameAngles(spin.frames, spin.clockwise);
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
  scene.setAngle(cycle.angles[index]);
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
    // applySettings() rebuilds the pivot rotation from scratch, so the spin
    // angle has to be re-applied here. Take it from the clock rather than from
    // the last frame drawn: a settings change also rebuilds the cycle, which
    // invalidates that index, and reusing it drops the model back to frame 0
    // on every change — most of a slider drag, at low frame rates.
    if (playing) {
      shownIndex = playbackIndexAt(performance.now());
      scene.setAngle(cycle.angles[shownIndex]);
    } else {
      scene.setAngle(0);
    }
    scene.render();
  });
}

function applyAndPreview() {
  syncOutputs();
  updateLoopInfo();
  updateViewSize();
  if (playing) resyncCycle();   // frames/speed/direction may have moved
  schedulePreview();
}

/* ------------------------------------------------------------- loading */

async function handleFile(file) {
  if (!file) return;
  const ext = extensionOf(file.name);
  setBusy(`Loading ${file.name}…`);
  try {
    const { object, stats } = await loadModel(file, { creaseAngle: DEFAULT_SETTINGS.smoothAngle });
    scene.setModel(object);
    scene.applySettings(readSettings());
    modelName = file.name.replace(/\.[^.]+$/, '');
    $('file-name').value = file.name;

    const bits = [
      `${stats.triangles.toLocaleString()} triangles`,
      `${stats.meshes} mesh${stats.meshes === 1 ? '' : 'es'}`,
    ];
    if (stats.textured) bits.push('textured');
    if (stats.vertexColours) bits.push('vertex colours');
    // Formats that keep textures in external files usually arrive bare.
    if (!stats.textured && !SELF_CONTAINED.has(ext)) {
      bits.push('no textures found — .' + ext + ' often stores them separately');
    }
    $('model-info').textContent = bits.join(' · ');

    $('dropzone').hidden = true;
    canvas.classList.remove('empty');
    $('render').disabled = false;
    discardStore();
    schedulePreview();
    if ($('preview').checked) startPlayback();   // requested before a model existed
  } catch (err) {
    console.error(err);
    $('model-info').innerHTML = `<span class="warn">${err.message}</span>`;
  } finally {
    setBusy('');
  }
}

function discardStore() {
  store = null;
  setSaveEnabled(false);
  $('store-info').textContent = 'No frames rendered yet.';
  $('save-info').textContent = '';
}

/* -------------------------------------------------------------- events */

for (const id of RANGE_IDS) $(id).addEventListener('input', applyAndPreview);
for (const id of ['up-axis', 'direction', 'quality', 'background', 'transparent',
  'textures', 'width', 'height']) {
  $(id).addEventListener('input', () => { discardStore(); applyAndPreview(); });
}

for (const id of POSITION_IDS) {
  $(id).addEventListener('input', () => { discardStore(); flashAxis(); });
}

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
  $('elevation').value = DEFAULT_SETTINGS.elevation;
  $('start').value = DEFAULT_SETTINGS.startAngle;
  $('up-axis').value = DEFAULT_SETTINGS.upAxis;
  $('fov').value = DEFAULT_SETTINGS.fov;
  $('zoom').value = DEFAULT_SETTINGS.zoom;
  discardStore();
  applyAndPreview();
});

$('reset-position').addEventListener('click', () => {
  $('pos-x').value = DEFAULT_SETTINGS.posX;
  $('pos-y').value = DEFAULT_SETTINGS.posY;
  $('pos-z').value = DEFAULT_SETTINGS.posZ;
  $('pitch').value = DEFAULT_SETTINGS.pitch;
  $('yaw').value = DEFAULT_SETTINGS.yaw;
  $('roll').value = DEFAULT_SETTINGS.roll;
  discardStore();
  applyAndPreview();
  flashAxis();
});

$('reset-render').addEventListener('click', () => {
  $('ambient').value = DEFAULT_SETTINGS.ambient;
  $('key').value = DEFAULT_SETTINGS.keyLight;
  $('fill').value = DEFAULT_SETTINGS.fillLight;
  $('rim').value = DEFAULT_SETTINGS.rimLight;
  $('specular').value = DEFAULT_SETTINGS.specular;
  $('shininess').value = DEFAULT_SETTINGS.shininess;
  applyAndPreview();
});

// Preview-only guides: deliberately not part of readSettings(), so toggling
// them neither re-renders nor throws away an existing frame store.
$('show-border').addEventListener('change', () => {
  canvas.classList.toggle('show-border', $('show-border').checked);
});

$('preview').addEventListener('change', () => {
  if ($('preview').checked) startPlayback();
  else stopPlayback();
});

$('show-axis').addEventListener('change', () => {
  stopAxisFlash();          // applies the checkbox state and clears any fade
  scene.render();
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

/* -------------------------------------------------------- render frames */

$('render').addEventListener('click', async () => {
  if (!scene.model || rendering) return;
  rendering = true;
  cancelRequested = false;
  stopAxisFlash();          // a fade must not carry into the capture
  stopPlayback({ rewind: false });

  discardStore();
  $('render').disabled = true;
  $('cancel').disabled = false;

  scene.applySettings(readSettings());
  const spin = readSpin();
  const started = performance.now();

  try {
    const result = await captureFrames(scene, spin, (done, total) => {
      setProgress(done, total);
      $('store-info').textContent = `Rendering frame ${done} of ${total}…`;
      return !cancelRequested;
    });

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
    $('store-info').innerHTML = `<span class="warn">${err.message}</span>`;
  } finally {
    setProgress(1, 1);
    rendering = false;
    $('render').disabled = false;
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
      note = `${info.totalMs} ms per turn`;
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
      note = `${info.totalMs} ms per turn`;
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
      note = `${info.totalMs} ms per turn · lossless`;
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
    $('save-info').innerHTML = `<span class="warn">${err.message}</span>`;
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

/* ----------------------------------------------------------------- init */

canvas.classList.add('empty');
scene.applySettings(readSettings());
applyAndPreview();
