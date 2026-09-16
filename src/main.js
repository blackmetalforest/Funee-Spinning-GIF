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
import { loopSummary, FPS_LIMIT } from './encoders/timing.js';
import { encodeGif } from './encoders/gif.js';
import { muxAnimation, encodeStill } from './encoders/webp.js';
import { muxApng } from './encoders/apng.js';
import { encodeZip, encodeSpriteSheet } from './encoders/frames.js';

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
  'ambient', 'key', 'fill', 'rim', 'specular', 'shininess'];

const FORMAT_LABELS = { gif: 'GIF', webp: 'WebP', apng: 'APNG', zip: 'ZIP', sheet: 'Sprite sheet' };

function readSettings() {
  return {
    width: clampInt($('width').value, 32, 2000, 480),
    height: clampInt($('height').value, 32, 2000, 480),
    supersample: parseInt($('quality').value, 10),
    elevation: +$('elevation').value,
    startAngle: +$('start').value,
    upAxis: $('up-axis').value,
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
function schedulePreview() {
  cancelAnimationFrame(previewHandle);
  previewHandle = requestAnimationFrame(() => {
    if (!scene.model) return;
    scene.applySettings(readSettings());
    scene.setAngle(0);
    scene.render();
  });
}

function applyAndPreview() {
  syncOutputs();
  updateLoopInfo();
  updateViewSize();
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

$('reset-render').addEventListener('click', () => {
  $('ambient').value = DEFAULT_SETTINGS.ambient;
  $('key').value = DEFAULT_SETTINGS.keyLight;
  $('fill').value = DEFAULT_SETTINGS.fillLight;
  $('rim').value = DEFAULT_SETTINGS.rimLight;
  $('specular').value = DEFAULT_SETTINGS.specular;
  $('shininess').value = DEFAULT_SETTINGS.shininess;
  applyAndPreview();
});

// Preview-only guide: deliberately not part of readSettings(), so toggling it
// neither re-renders nor throws away an existing frame store.
$('show-border').addEventListener('change', () => {
  canvas.classList.toggle('show-border', $('show-border').checked);
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
    } else if (format === 'sheet') {
      const sheet = await encodeSpriteSheet(store);
      blob = sheet.blob;
      extension = 'png';
      note = `${sheet.columns}×${sheet.rows} grid of ${sheet.frameWidth}×${sheet.frameHeight}`;
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
