/**
 * App wiring: controls -> scene -> frame store -> exports.
 *
 * The flow deliberately separates rendering from saving. "Render frames" fills
 * the store once; each Save button then assembles that store into a format
 * without re-rendering, so you can export a GIF and a WebP and an APNG from a
 * single render.
 */

import { SpinScene, DEFAULT_SETTINGS } from './scene.js';
import { loadModel, FILE_ACCEPT, SELF_CONTAINED, AUTO, NONE } from './loaders.js';
import { baseName, stemOf, extOf, IMAGE_EXTENSIONS } from './archive.js';
import { labelMeshes, toggleLabel, meshSummary } from './mesh-list.js';
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

const RANGE_IDS = ['elevation', 'start', 'fov', 'zoom', 'speed', 'fps',
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
    // No longer a control: textures are always used when a model has them.
    shadeTexture: true,
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

function readSpin() {
  const rps = +$('speed').value;
  const { frames, stopped } = framesFor(+$('fps').value, rps);
  return { frames, rps, stopped, clockwise: $('direction').value === 'cw' };
}

function clampInt(value, lo, hi, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
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
  for (const id of ['ambient', 'key', 'fill', 'rim', 'specular']) {
    $(`${id}-out`).textContent = trim(+$(id).value);
  }
  $('shininess-out').textContent = $('shininess').value;
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
  const { frames, ideal, stopped } = framesFor(+$('fps').value, +$('speed').value);
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
    : 'frame rate ÷ spin speed';
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
  $('loop-info').innerHTML =
    `${spin.frames} ${plural} · ${seconds} s/turn · ${fpsHtml} · ` +
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

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
    scene.applySettings(readSettings());
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
    $('model-info').innerHTML = escapeHtml(bits.join(' · ')) + archiveNote(report, stats);
    appliedReplacements = report?.replacements ?? [];
    showAdvanced(report);

    $('dropzone').hidden = true;
    canvas.classList.remove('empty');
    $('render').disabled = false;
    discardStore();
    schedulePreview();
    if ($('preview').checked) startPlayback();   // requested before a model existed
  } catch (err) {
    console.error(err);
    $('model-info').innerHTML = `<span class="warn">${escapeHtml(err.message)}</span>`;
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
function applyMeshVisibility() {
  scene.setHiddenMeshes(hiddenMeshes);
  syncMeshChrome(scene.meshList().length);
  discardStore();
  schedulePreview();
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
for (const id of ['up-axis', 'direction', 'quality', 'background', 'transparent',
  'width', 'height']) {
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

$('reset-render').addEventListener('click', () => {
  setSliderValue('ambient', DEFAULT_SETTINGS.ambient);
  setSliderValue('key', DEFAULT_SETTINGS.keyLight);
  setSliderValue('fill', DEFAULT_SETTINGS.fillLight);
  setSliderValue('rim', DEFAULT_SETTINGS.rimLight);
  setSliderValue('specular', DEFAULT_SETTINGS.specular);
  setSliderValue('shininess', DEFAULT_SETTINGS.shininess);
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
