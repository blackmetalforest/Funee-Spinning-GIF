/**
 * Node tests for the pure-logic modules.
 *
 * Only the parts that need no DOM are covered here: timing and the two muxers.
 * The rendering path is verified in a real browser instead — see README.
 *
 *   node tests/run.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

import { frameDelaysMs, loopSummary, frameAngles, roundHalfToEven,
         frameStarts, frameIndexAt } from '../src/encoders/timing.js';
import { muxAnimation } from '../src/encoders/webp.js';
import { muxApng } from '../src/encoders/apng.js';
import { encodePng } from '../src/encoders/png.js';
import { openArchive, AssetIndex, rankModels, cleanPath, normKey, extOf, stemOf,
         baseName, dirName, channelOf, nameAffinity } from '../src/archive.js';
import { sanitiseMtl } from '../src/mtl-fix.js';
import { labelMeshes, toggleLabel, meshSummary } from '../src/mesh-list.js';
import { fontPx, strokePx, wrapLines, layoutText, drawText, isBlank, MS_ACROSS,
         usableWidth, fontBasis, layoutBand, drawBand } from '../src/overlay-text.js';
import { zipSync, strToU8 } from '../vendor/fflate.module.js';
import * as THREE from '../vendor/three/three.module.js';
import { toClassic, toPhysical, applyLayers, layersOf, debugMaterial, applyFiltering,
         shininessToRoughness, wantsPhysical, ALL_LAYERS_ON, LAYERS, VIEWS } from '../src/materials.js';
import { wrapModeFor, samplerWraps, applySamplerWraps, promoteOnlyUvSet } from '../src/dae-fix.js';
import { setKeyOf } from '../src/archive.js';
import { placeBackdrop, drawBackdrop } from '../src/backdrop.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'out');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

console.log('\ntiming');
// Python's round() is half-to-even; Math.round is not. 12.5 must give 12.
check('banker rounding 12.5 -> 12', roundHalfToEven(12.5) === 12);
check('banker rounding 13.5 -> 14', roundHalfToEven(13.5) === 14);
check('banker rounding 12.4 -> 12', roundHalfToEven(12.4) === 12);

// Totals must land exactly on 1000/rps, which is the whole point of the
// carried-error rounding.
for (const [n, rps] of [[48, 0.25], [24, 0.25], [36, 1], [12, 0.7], [8, 1]]) {
  const gif = loopSummary(n, rps, 'gif');
  check(`gif ${n}f @ ${rps} r/s totals ${Math.round(1000 / rps)}ms`,
    gif.totalMs === Math.round(1000 / rps) || Math.abs(gif.totalMs - 1000 / rps) <= 10,
    `got ${gif.totalMs}`);
}
// WebP/APNG use a 1ms grid, so they should be exact where GIF cannot be.
check('webp 24f @ 0.3 r/s is exact (3333ms)', loopSummary(24, 0.3, 'webp').totalMs === 3333);
check('gif 24f @ 0.3 r/s quantises to 3330ms', loopSummary(24, 0.3, 'gif').totalMs === 3330);

console.log('\nangles');
const angles = frameAngles(24, true);
check('24 angles', angles.length === 24);
check('starts at 0', angles[0] === 0);
check('no repeated pose at the wrap', Math.abs(angles[23]) !== 360);
check('even 15 deg steps', Math.abs(Math.abs(angles[1] - angles[0]) - 15) < 1e-9);
check('counter-clockwise flips sign', frameAngles(4, false)[1] > 0);

console.log('\nplayback lookup');
// The live preview asks which frame belongs to a clock reading rather than
// counting frames, so it stays correct when it cannot keep up.
{
  const delays = frameDelaysMs(48, 0.25, 'gif');
  const { starts, totalMs } = frameStarts(delays);
  check('starts begin at 0', starts[0] === 0);
  check('starts are cumulative', starts[1] === delays[0] && starts[2] === delays[0] + delays[1]);
  check('total matches the summary', totalMs === loopSummary(48, 0.25, 'gif').totalMs);

  check('t=0 is frame 0', frameIndexAt(starts, totalMs, 0) === 0);
  check('just before a boundary stays put', frameIndexAt(starts, totalMs, starts[1] - 1) === 0);
  check('the boundary itself advances', frameIndexAt(starts, totalMs, starts[1]) === 1);
  check('a late frame resolves', frameIndexAt(starts, totalMs, starts[30] + 1) === 30);

  // Wrapping is what lets a backgrounded tab resume at the right phase
  // instead of fast-forwarding through every frame it missed.
  check('one full loop wraps to 0', frameIndexAt(starts, totalMs, totalMs) === 0);
  check('many loops later keeps phase',
    frameIndexAt(starts, totalMs, totalMs * 37 + starts[9]) === 9);
  check('negative elapsed is handled', frameIndexAt(starts, totalMs, -1) === 47);

  // A single frame is a still: every clock reading is frame 0.
  const one = frameStarts(frameDelaysMs(1, 1, 'gif'));
  check('a 1-frame loop is always frame 0',
    frameIndexAt(one.starts, one.totalMs, 0) === 0 &&
    frameIndexAt(one.starts, one.totalMs, 999999) === 0);
  check('empty delays do not throw', frameIndexAt([], 0, 5) === 0);
}

console.log('\npng encoder');
// A tiny 2x2 image, then confirm the signature and chunk order.
const pixels = new Uint8ClampedArray([
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 255, 0,
]);
const png = encodePng({ data: pixels, width: 2, height: 2 });
check('png signature', png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47);
check('has IHDR', Buffer.from(png).includes(Buffer.from('IHDR')));
check('has IDAT', Buffer.from(png).includes(Buffer.from('IDAT')));
check('has IEND', Buffer.from(png).includes(Buffer.from('IEND')));

console.log('\napng muxer');
const apngFrames = [];
for (let i = 0; i < 4; i++) {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = i * 60; data[p + 1] = 40; data[p + 2] = 200; data[p + 3] = 255;
  }
  apngFrames.push({ data: encodePng({ data, width: 4, height: 4 }), delay: 125 });
}
const apng = muxApng(apngFrames, { width: 4, height: 4, loop: 0 });
const apngBuf = Buffer.from(apng);
check('has acTL', apngBuf.includes(Buffer.from('acTL')));
check('has fcTL per frame', apngBuf.toString('latin1').split('fcTL').length - 1 === 4);
check('has fdAT for frames 2..n', apngBuf.toString('latin1').split('fdAT').length - 1 === 3);
writeFileSync(join(OUT, 'unit_apng.png'), apng);

console.log('\nwebp muxer');
// Reuse fixtures if a browser run left real stills behind; otherwise skip.
const FIXTURES = join(here, 'fixtures');
const stillPath = join(FIXTURES, 'still0.webp');
if (existsSync(stillPath)) {
  const stills = [0, 1, 2].map((i) => ({
    data: new Uint8Array(readFileSync(join(FIXTURES, `still${i}.webp`))),
    duration: 125,
  }));
  const webp = muxAnimation(stills, { width: 64, height: 64, loop: 0 });
  const buf = Buffer.from(webp);
  check('RIFF/WEBP header', buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP');
  check('has VP8X', buf.includes(Buffer.from('VP8X')));
  check('has ANIM', buf.includes(Buffer.from('ANIM')));
  check('one ANMF per frame', buf.toString('latin1').split('ANMF').length - 1 === 3);
  writeFileSync(join(OUT, 'unit_webp.webp'), webp);
} else {
  console.log('  FAIL  webp muxer fixtures missing'); failed++;
}

console.log('\narchive paths');
check('backslashes become slashes', cleanPath('W:\\Art\\Textures\\Foo.png') === 'W:/Art/Textures/Foo.png');
check('dot segments collapse', cleanPath('a/./b/../c/d.png') === 'a/c/d.png');
check('leading slash dropped', cleanPath('/a/b.png') === 'a/b.png');
check('basename', baseName('a/b/c.png') === 'c.png');
check('dirname', dirName('a/b/c.png') === 'a/b');
check('dirname at the root is empty', dirName('c.png') === '');
check('extension lowercased', extOf('A/B.PNG') === 'png');
check('a file with no extension', extOf('source/M1A2') === '');
check('stem keeps its spaces', stemOf('a/Patchwork chair.obj') === 'Patchwork chair');
// The rewrite packagers perform on the way into a zip: spaces become
// underscores, so only a separator-blind key matches the two.
check('normKey ignores separators',
  normKey('DesertEagle_Desert Eagle_BaseColor') === normKey('DesertEagle_Desert_Eagle_BaseColor'));
check('normKey keeps digits', normKey('#CAM0001_Textures_COL_4k') === 'cam0001texturescol4k');

console.log('\ntexture channels');
check('baseColor is colour', channelOf('t/Body_baseColor.png') === 'colour');
check('albedo is colour', channelOf('t/lambert1_1001_albedo.jpeg') === 'colour');
check('Defuse (sic) is colour', channelOf('t/Main_Defuse.jpg') === 'colour');
check('COL is colour', channelOf('t/#CAM0001_Textures_COL_4k.png') === 'colour');
// The trap: a careless colour test matching "color" would claim this one,
// so the specific channels have to be tried first.
check('metallicRoughness is not colour', channelOf('t/X_metallicRoughness.png') === 'roughness');
check('normal is not colour', channelOf('t/X_normal.jpeg') === 'normal');
check('NRML is not colour', channelOf('t/X_NRML_4k.png') === 'normal');
check('AO is not colour', channelOf('t/lambert1_1001_AO.jpg') === 'ao');
check('emissive is not colour', channelOf('t/X_emissive.png') === 'emissive');
check('opacity is not colour', channelOf('t/X_OPAC_4k.png') === 'opacity');
check('an unrecognised name is unknown', channelOf('t/01.png') === 'unknown');

console.log('\nname affinity');
check('an exact material name wins', nameAffinity('lambert1_1001', 't/lambert1_1001.png') === 100);
check('the texture extends the material name',
  nameAffinity('lambert1_1001', 't/lambert1_1001_albedo.jpeg') === 80);
check('the material extends the texture name',
  nameAffinity('capelliHI:lambert1SG', 't/capelli.png') === 80);
// A couple of letters in common must never be enough to bind.
check('unrelated names score nothing', nameAffinity('Material__25', 't/Track_Def.jpg') === 0);
check('a null material never matches', nameAffinity('(null)', 't/01.png') === 0);

console.log('\narchive hunting');
const dot = encodePng({ data: new Uint8ClampedArray([255, 0, 0, 255]), width: 1, height: 1 });
const OBJ = strToU8('mtllib Patchwork chair.mtl\nv 0 0 0\nusemtl material_0\n');

function fakeFile(name, files) {
  const bytes = zipSync(files);
  return {
    name,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

// The Sketchfab shape: the model buried in source/, textures alongside it,
// and a nested archive that has to be opened to reach anything at all.
const bundle = await openArchive(fakeFile('b.zip', {
  'license.txt': strToU8('not a model'),
  '__MACOSX/._scene.obj': strToU8('resource fork'),
  'textures/Body_baseColor.png': dot,
  'source/inner.zip': zipSync({
    'model/Patchwork chair.obj': OBJ,
    'model/Patchwork chair.mtl': strToU8('newmtl material_0\n'),
  }),
}));
check('a model inside a nested zip is found',
  bundle.models[0]?.path === 'source/inner.zip!/model/Patchwork chair.obj',
  JSON.stringify(bundle.models.map((m) => m.path)));
check('nothing else is offered as a model', bundle.models.length === 1);
check('__MACOSX entries are ignored',
  ![...bundle.index.entries.keys()].some((p) => p.includes('__MACOSX')));
check('files of no interest are never inflated',
  ![...bundle.index.entries.keys()].some((p) => p.endsWith('license.txt')));

const modelDir = dirName(bundle.models[0].path);
check('a sidecar beside the model resolves',
  bundle.index.find('Patchwork chair.mtl', modelDir)
    === 'source/inner.zip!/model/Patchwork chair.mtl');
check('a texture in the outer zip resolves from the inner model',
  bundle.index.find('Body_baseColor.png', modelDir) === 'textures/Body_baseColor.png');
check('an absolute Windows path resolves by its tail',
  bundle.index.find('C:\\Users\\artist\\textures\\Body_baseColor.png', modelDir)
    === 'textures/Body_baseColor.png');
check('a genuinely missing reference resolves to nothing',
  bundle.index.find('Abrams_Tank.mtl', modelDir) === null);

// A .rar cannot be opened, and saying so beats failing silently.
const opaque = await openArchive(fakeFile('r.zip', {
  'source/model.rar': strToU8('Rar!'),
  'textures/Body_baseColor.png': dot,
}));
check('a rar-only bundle yields no model', opaque.models.length === 0);
check('the rar is reported', opaque.warnings.some((w) => w.includes('.rar')),
  JSON.stringify(opaque.warnings));

console.log('\nmodel ranking');
// Several formats in one bundle: the one carrying real material data wins,
// however much bigger the others are.
const ranked = rankModels([
  { path: 'source/model.obj', ext: 'obj', size: 300e6 },
  { path: 'scene.gltf', ext: 'gltf', size: 5e3 },
  { path: 'source/model.stl', ext: 'stl', size: 50e6 },
]);
check('glTF outranks a far larger OBJ', ranked[0].path === 'scene.gltf');
check('OBJ outranks STL', ranked[1].path === 'source/model.obj');
const lods = rankModels([
  { path: 'model_LOD3.fbx', ext: 'fbx', size: 1e6 },
  { path: 'model.fbx', ext: 'fbx', size: 1e6 },
]);
check('a LOD variant loses to the real model', lods[0].path === 'model.fbx');
// A bake is usually the biggest file in the bundle, so size alone would let it
// win against the model it was derived from.
const bakes = rankModels([
  { path: 'Penguin_bake.dae', ext: 'dae', size: 4e6 },
  { path: 'Penguin.dae', ext: 'dae', size: 1e5 },
]);
check('a bake loses to the model it came from', bakes[0].path === 'Penguin.dae');

console.log('\nasset lookup');
// Two files sharing a basename in different folders: the suffix has to
// decide, or a 4k texture gets served where a 2k one was asked for.
const twin = new AssetIndex(new Map([
  ['Textures/Tex_2k/COL.png', dot],
  ['Textures/Tex_4k/COL.png', dot],
]));
check('a longer path suffix disambiguates a shared basename',
  twin.find('Textures/Tex_4k/COL.png') === 'Textures/Tex_4k/COL.png');
check('a bare basename still resolves to one of them', twin.find('COL.png') !== null);

// '#' is legal in a filename and these bundles are full of it, so a
// fragment can never simply be stripped.
const hashed = new AssetIndex(new Map([['textures/#CAM0001_COL_4k.png', dot]]));
check('a # in a filename is not treated as a fragment',
  hashed.find('textures/#CAM0001_COL_4k.png') === 'textures/#CAM0001_COL_4k.png');
check('a percent-encoded name still resolves',
  hashed.find('textures/%23CAM0001_COL_4k.png') === 'textures/#CAM0001_COL_4k.png');
// Packagers re-encode .tga as .png without rewriting the reference.
check('a changed extension still resolves',
  hashed.find('#CAM0001_COL_4k.tga') === 'textures/#CAM0001_COL_4k.png');

console.log('\nmtl dissolve/transparency');
// The 3ds Max exporter behind most ripped models writes both, with Tr
// carrying d's meaning. Taken literally the material is invisible, which is
// what "the mesh loads but I cannot find it" actually was.
const contradictory = 'newmtl a\nd 1.0000\nTr 1.0000\nmap_Kd a.png\n';
check('a contradictory Tr is dropped', !/Tr/.test(sanitiseMtl(contradictory)));
check('the d line survives', /^d 1\.0000$/m.test(sanitiseMtl(contradictory)));
check('everything else survives', /map_Kd a\.png/.test(sanitiseMtl(contradictory)));
// A file that means it is left alone, which is why this cannot just be
// MTLLoader's invertTrProperty: that would turn Tr 0 into an invisible material.
check('a consistent Tr 0 is kept', /Tr 0/.test(sanitiseMtl('newmtl a\nd 1\nTr 0\n')));
check('a consistent half-transparent pair is kept',
  /Tr 0\.5/.test(sanitiseMtl('newmtl a\nd 0.5\nTr 0.5\n')));
check('Tr alone is never touched', /Tr 1/.test(sanitiseMtl('newmtl a\nTr 1\n')));
check('d alone is never touched', sanitiseMtl('newmtl a\nd 1\n') === 'newmtl a\nd 1\n');
// Each block is judged on its own.
const mixed = sanitiseMtl('newmtl a\nd 1\nTr 1\nnewmtl b\nd 1\nTr 0\n');
check('only the contradicting block loses its Tr',
  (mixed.match(/Tr/g) || []).length === 1 && /Tr 0/.test(mixed), JSON.stringify(mixed));
check('keywords that merely start with d are safe',
  /disp bump\.png/.test(sanitiseMtl('newmtl a\nd 1\nTr 1\ndisp bump.png\n')));

console.log('\nmesh list');
// The visible label is the position and nothing else: a rip's mesh names are
// blank, hashed or all identical, so a list of them cannot be scanned.
const named = labelMeshes([
  { index: 0, name: 'body', triangles: 1204 },
  { index: 1, name: 'head_v2', triangles: 8 },
]);
check('the label is the position', named[0].label === '1' && named[1].label === '2');
check('positions are 1-based',
  labelMeshes([{ index: 6, name: '', triangles: 0 }])[0].label === '7');
check('indices are carried through', named.map((m) => m.index).join() === '0,1');

// Nothing is lost — it moves to the tooltip.
check('the tooltip keeps the name', named[0].title === 'Mesh 1 · body · 1,204 triangles');
check('the tooltip keeps the count', named[1].title === 'Mesh 2 · head_v2 · 8 triangles');
check('one triangle is singular',
  labelMeshes([{ index: 0, name: 'a', triangles: 1 }])[0].title === 'Mesh 1 · a · 1 triangle');
check('a nameless mesh has no empty segment',
  labelMeshes([{ index: 0, name: '', triangles: 5 }])[0].title === 'Mesh 1 · 5 triangles');
check('whitespace counts as no name',
  labelMeshes([{ index: 0, name: '   ', triangles: 5 }])[0].title === 'Mesh 1 · 5 triangles');
check('a missing name field is tolerated',
  labelMeshes([{ index: 0, triangles: 5 }])[0].title === 'Mesh 1 · 5 triangles');
check('a missing triangle count is tolerated',
  labelMeshes([{ index: 0, name: 'a' }])[0].title === 'Mesh 1 · a · 0 triangles');
// Repeated names are the norm in a rip, and cannot collide now that the
// label is positional.
const dupes = labelMeshes([
  { index: 0, name: 'Object_2', triangles: 10 },
  { index: 1, name: 'Object_2', triangles: 20 },
]);
check('repeated names still get distinct labels', dupes[0].label !== dupes[1].label);
check('repeated names keep their own tooltips', dupes[0].title !== dupes[1].title);
check('an empty list is not an error', labelMeshes([]).length === 0);
check('a non-list is not an error', labelMeshes(undefined).length === 0);

// The button names what it will do, so it only offers "All on" with nothing left.
check('the button offers to hide while anything shows', toggleLabel(4, 0) === 'All off');
check('still offers to hide with one left', toggleLabel(4, 3) === 'All off');
check('offers to show once all are hidden', toggleLabel(4, 4) === 'All on');
check('an empty model does not offer to show', toggleLabel(0, 0) === 'All off');

check('the summary counts what shows', meshSummary(14, 3) === 'Meshes — 11 of 14 shown');
check('the summary handles none hidden', meshSummary(2, 0) === 'Meshes — 2 of 2 shown');
check('the summary never goes negative', meshSummary(2, 5) === 'Meshes — 0 of 2 shown');

console.log('\noverlay text');
/*
 * A stub context: every glyph is 0.82em wide, which is roughly Impact's M.
 * Layout is all measureText, so this is the whole dependency.
 */
const stub = () => ({
  font: '10px x',
  measureText(t) { return { width: t.length * 0.82 * (parseFloat(this.font) || 10) }; },
});

/*
 * The promise the feature is built on, stated the way a user would check it:
 * MS_ACROSS capital Ms go on one line, one more does not, at any image size.
 * Asserting the line count rather than an intermediate ratio is what caught
 * the font being sized to the full width while wrapping used the margins —
 * which quietly wrapped the promised 14 at 13.
 */
const linesFor = (w, n) => {
  const ctx = stub();
  const size = fontPx(ctx, 'Impact', w);
  ctx.font = `${size}px Impact`;
  return wrapLines(ctx, 'M'.repeat(n), usableWidth(w)).length;
};
for (const w of [200, 480, 1000]) {
  check(`${MS_ACROSS} Ms fit one line on a ${w}px image`, linesFor(w, MS_ACROSS) === 1);
  check(`one more wraps on a ${w}px image`, linesFor(w, MS_ACROSS + 1) === 2);
}
check('font size is linear in width',
  Math.abs(fontPx(stub(), 'Impact', 1000) / fontPx(stub(), 'Impact', 500) - 2) < 1e-9);
check('the size control scales it',
  Math.abs(fontPx(stub(), 'Impact', 480, 2) / fontPx(stub(), 'Impact', 480) - 2) < 1e-9);

// Stroke: 1 unit is 1px on a 480-tall image, and grows with the image.
check('stroke 5 is 5px at 480',
  Math.abs(strokePx(5, fontPx(stub(), 'Impact', 480)) - 5) < 0.02);
check('stroke doubles with the image',
  Math.abs(strokePx(5, fontPx(stub(), 'Impact', 960)) - 10) < 0.05);
check('stroke follows the size control',
  Math.abs(strokePx(5, fontPx(stub(), 'Impact', 480, 2)) - 10) < 0.05);
check('stroke never goes negative', strokePx(-5, 40) === 0);
check('stroke zero is zero', strokePx(0, 40) === 0);

/*
 * Zero has to mean *no outline at all*, and asserting the number is not
 * enough. Assigning 0 to ctx.lineWidth is ignored — the spec requires a
 * value greater than zero — so the context silently keeps the 1 it already
 * had. Gating the draw on ctx.lineWidth therefore read 1 back and stroked a
 * hairline that no setting could turn off. This watches the calls instead.
 */
const recorder = () => {
  const calls = [];
  let lineWidth = 1;
  const rec = {
    calls,
    font: '10px x',
    measureText(t) { return { width: t.length * 0.82 * (parseFloat(this.font) || 10) }; },
    save() {}, restore() {},
    fillText() { calls.push('fill'); },
    strokeText() { calls.push(`stroke@${lineWidth}`); },
  };
  // The point of the stub: a real context *ignores* a lineWidth that is not
  // finite and greater than zero, keeping whatever it had. A plain property
  // would happily store 0 and the test would pass against the very bug it
  // exists to catch.
  Object.defineProperty(rec, 'lineWidth', {
    get: () => lineWidth,
    set: (v) => { if (Number.isFinite(v) && v > 0) lineWidth = v; },
  });
  return rec;
};
const drawWith = (weight) => {
  const rec = recorder();
  drawText(rec, { top: 'HI' }, { width: 480, height: 480, family: 'Impact', weight });
  return rec.calls;
};
check('a stroke weight draws an outline', drawWith(5).some((c) => c.startsWith('stroke')));
check('zero draws no outline at all', !drawWith(0).some((c) => c.startsWith('stroke')),
  drawWith(0).join());
check('zero still draws the letters', drawWith(0).includes('fill'));

// Wrapping
const ctx = stub();
ctx.font = '10px x';                       // every char 8.2px wide
check('short text stays on one line', wrapLines(ctx, 'AB', 100).length === 1);
check('long text wraps at a space', wrapLines(ctx, 'AAAAA BBBBB CCCCC', 100).length > 1);
check('wrapping breaks on whitespace',
  wrapLines(ctx, 'AAAAA BBBBB CCCCC', 100).every((l) => !l.startsWith(' ')));
check('no line exceeds the width',
  wrapLines(ctx, 'AAAAA BBBBB CCCCC DDDDD', 100)
    .every((l) => ctx.measureText(l).width <= 100));
// One shouted unspaced word is the common case, not a corner.
const broken = wrapLines(ctx, 'A'.repeat(40), 100);
check('an over-long word is broken up', broken.length > 1);
check('the broken pieces all fit',
  broken.every((l) => ctx.measureText(l).width <= 100));
check('breaking loses no characters', broken.join('') === 'A'.repeat(40));
check('blank text yields no lines', wrapLines(ctx, '   ', 100).length === 0);
check('null text yields no lines', wrapLines(ctx, null, 100).length === 0);

// Enter breaks a line early — the same thing wrapping does, done by hand.
check('a newline starts a new line', wrapLines(ctx, 'AA\nBB', 100).length === 2);
check('the break lands where it was typed',
  wrapLines(ctx, 'AA\nBB', 100).join('|') === 'AA|BB');
check('several newlines all count', wrapLines(ctx, 'A\nB\nC\nD', 100).length === 4);
check('a typed break survives alongside wrapping',
  wrapLines(ctx, 'AAAAA BBBBB CCCCC\nDD', 100).at(-1) === 'DD');
// Enter twice is a deliberate gap, not nothing.
check('an empty line is kept', wrapLines(ctx, 'A\n\nB', 100).join('|') === 'A||B');
check('trailing newlines are trimmed off', wrapLines(ctx, 'A\n\n', 100).length === 1);

// The default size is ten Ms, which is what 140% of the original fourteen was.
check('the default is ten Ms across', MS_ACROSS === 10);
check('ten Ms fit, eleven do not',
  linesFor(480, 10) === 1 && linesFor(480, 11) === 2);

/*
 * Letter size follows the HEIGHT. Widening the frame must not grow the text —
 * it must let more of it onto the line, which is the whole point of widening
 * a frame to fit a longer caption.
 */
const sizeAt = (w, h) => layoutText(stub(), { top: 'M' }, { width: w, height: h, family: 'Impact' }).size;
check('a wider image keeps the same letter size',
  Math.abs(sizeAt(1000, 480) - sizeAt(480, 480)) < 1e-9,
  `${sizeAt(1000, 480)} vs ${sizeAt(480, 480)}`);
check('a taller image grows the letters',
  Math.abs(sizeAt(480, 960) / sizeAt(480, 480) - 2) < 1e-9);
check('width no longer changes the size at all',
  Math.abs(sizeAt(200, 480) - sizeAt(2000, 480)) < 1e-9);
check('fontBasis reads the height', Math.abs(fontBasis(480) - 480 * 0.92) < 1e-9);

// ...and the extra width is spent on characters.
const fitsOn = (w, h) => {
  const ctx = stub();
  const size = fontPx(ctx, 'Impact', h);
  ctx.font = `${size}px Impact`;
  let n = 0;
  while (wrapLines(ctx, 'M'.repeat(n + 1), usableWidth(w)).length === 1) n++;
  return n;
};
check('a square image fits ten', fitsOn(480, 480) === 10);
check('twice the width fits about twice as many',
  fitsOn(960, 480) >= 20 && fitsOn(960, 480) <= 21, String(fitsOn(960, 480)));

// Placement
const box = { width: 480, height: 480, family: 'Impact' };
const one = layoutText(stub(), { top: 'A', middle: 'B', bottom: 'C' }, box);
check('all three blocks are placed', one.lines.length === 3);
check('every line is centred horizontally', one.lines.every((l) => l.x === 240));
check('top sits above middle sits above bottom',
  one.lines[0].y < one.lines[1].y && one.lines[1].y < one.lines[2].y);

// The middle block recentres as it grows; the bottom block grows upward.
const mid1 = layoutText(stub(), { middle: 'A' }, box).lines;
const mid2 = layoutText(stub(), { middle: 'A'.repeat(40) }, box).lines;
const centreOf = (ls, size) => (ls[0].y + ls[ls.length - 1].y + size) / 2;
const s1 = layoutText(stub(), { middle: 'A' }, box).size;
check('a second middle line appears', mid2.length > mid1.length);
check('the middle block stays centred',
  Math.abs(centreOf(mid1, s1) - centreOf(mid2, s1)) < 0.01, 
  `${centreOf(mid1, s1)} vs ${centreOf(mid2, s1)}`);
check('the middle block grew upward', mid2[0].y < mid1[0].y);

const bot1 = layoutText(stub(), { bottom: 'A' }, box).lines;
const bot2 = layoutText(stub(), { bottom: 'A'.repeat(40) }, box).lines;
check('the last bottom line does not move',
  Math.abs(bot1[bot1.length - 1].y - bot2[bot2.length - 1].y) < 0.01);
check('the bottom block is pushed upward', bot2[0].y < bot1[0].y);
check('the bottom block stays on the image', bot2[0].y > 0);

/*
 * Text is placed by its ink, not by its em box, so that every font ends up
 * with the same clear space. Placing by the box balanced top against bottom
 * but left each face on a different margin — Arimo 21px where Anton got 18 —
 * because Anton's capitals nearly fill their box and Arimo's do not.
 */
const inked = (ascent, descent) => {
  const c = stub();
  c.measureText = function (t) {
    return { width: t.length * 0.82 * (parseFloat(this.font) || 10),
             actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: descent };
  };
  return c;
};
const PAD = 480 * (18 / 480);            // 18px on a 480px image

// Two invented faces whose ink sits very differently in the box. Both must
// come out on exactly the same margin.
const tight = layoutText(inked(-2, 46), { top: 'A', bottom: 'C' },
  { width: 480, height: 480, family: 'X' });
const loose = layoutText(inked(-9, 33), { top: 'A', bottom: 'C' },
  { width: 480, height: 480, family: 'X' });
check('a tight face starts its ink at the margin',
  Math.abs((tight.lines[0].y + 2) - PAD) < 1e-6, String(tight.lines[0].y + 2));
check('a loose face starts its ink at the same margin',
  Math.abs((loose.lines[0].y + 9) - PAD) < 1e-6, String(loose.lines[0].y + 9));
check('both end their ink at the same margin',
  Math.abs((tight.lines[1].y + 46) - (480 - PAD)) < 1e-6
  && Math.abs((loose.lines[1].y + 33) - (480 - PAD)) < 1e-6);
check('18px at 480', Math.abs(PAD - 18) < 1e-9);

// The middle block centres its ink, not its box.
const mid = layoutText(inked(-9, 33), { middle: 'A' },
  { width: 480, height: 480, family: 'X' }).lines[0];
check('the middle block centres its ink',
  Math.abs(((mid.y + 9) + (mid.y + 33)) / 2 - 240) < 1e-6);

// A multi-line bottom block still ends on the margin.
const tall = layoutText(inked(-9, 33), { bottom: 'A'.repeat(40) },
  { width: 480, height: 480, family: 'X' }).lines;
check('a wrapped bottom block still ends on the margin',
  Math.abs((tall[tall.length - 1].y + 33) - (480 - PAD)) < 1e-6);

// Without ink extents, fall back to treating the box as the ink.
const plain = layoutText(stub(), { top: 'A' }, box);
check('without metrics the box is used as-is',
  Math.abs(plain.lines[0].y - PAD) < 1e-9, String(plain.lines[0].y));

const top1 = layoutText(stub(), { top: 'A' }, box).lines;
const top2 = layoutText(stub(), { top: 'A'.repeat(40) }, box).lines;
check('the first top line does not move', top1[0].y === top2[0].y);

check('an empty caption places nothing',
  layoutText(stub(), { top: '', middle: '', bottom: '' }, box).lines.length === 0);
check('isBlank spots an empty caption', isBlank({ top: ' ', middle: '', bottom: null }));
check('isBlank spots a filled one', !isBlank({ bottom: 'x' }));
check('isBlank tolerates nothing at all', isBlank());

console.log('\ncaption band (On Top)');
/*
 * The band is the one piece of layout whose *height* is an output, and two
 * places have to arrive at the same number for it — the preview and the
 * capture — or they disagree about how big the exported image is. Hence
 * rather more tests than a bit of text drawing would usually earn.
 */
const bandOf = (text, width = 480, height = 480, scale = 1) =>
  layoutBand(stub(), text, { width, height, family: 'Impact', scale });

check('nothing typed grows no band', bandOf('').bandHeight === 0);
check('whitespace alone grows no band', bandOf('   \n  ').bandHeight === 0);
check('text grows a band', bandOf('HELLO').bandHeight > 0);

{
  // The stub has no ink extents, so a line is exactly `size` tall and the
  // step between lines is size * LINE_HEIGHT. Both are constants here, so a
  // second line must add exactly one step and nothing else.
  const one = bandOf('MMM');
  const two = bandOf('MMM\nMMM');
  const three = bandOf('MMM\nMMM\nMMM');
  const step = two.bandHeight - one.bandHeight;
  check('a second line adds one line step', step > 0);
  check('a third line adds the same again',
        Math.abs((three.bandHeight - two.bandHeight) - step) <= 1);
  check('the step is the line height', Math.abs(step - one.size * 1.12) <= 1);
}

{
  // Wrapping must respect the side margins, exactly as the in-image captions
  // do — measuring against the full width is the bug that once wrapped the
  // promised 14 Ms at 13.
  const fits = bandOf('M'.repeat(MS_ACROSS));
  const over = bandOf('M'.repeat(MS_ACROSS + 1));
  check('the promised Ms fit on one band line', fits.lines.length === 1);
  check('one more wraps the band to two', over.lines.length === 2);
  const ctx = stub();
  const laid = layoutBand(ctx, 'M'.repeat(MS_ACROSS), { width: 480, height: 480, family: 'Impact' });
  ctx.font = `${laid.size}px Impact`;
  check('the band line fits the usable width',
        ctx.measureText(laid.lines[0].text).width <= usableWidth(480) + 0.5);
}

{
  /*
   * Scale invariance, the rule the whole file is built on: a band is the same
   * fraction of the image at every size. This is the test that catches a
   * stray absolute pixel, which would leave the band right at 480 and wrong
   * everywhere else.
   */
  const small = bandOf('SOME CAPTION HERE', 480, 480);
  const big = bandOf('SOME CAPTION HERE', 960, 960);
  check('doubling the image doubles the band',
        Math.abs(big.bandHeight - small.bandHeight * 2) <= 1);
  check('the same text wraps the same either way',
        big.lines.length === small.lines.length);
}

{
  // The font is sized from the height, so a wider image fits more on a line
  // without the band getting taller — the same rule fontBasis() exists for.
  const square = bandOf('M'.repeat(MS_ACROSS * 2), 480, 480);
  const wide = bandOf('M'.repeat(MS_ACROSS * 2), 960, 480);
  check('a wider image needs fewer band lines', wide.lines.length < square.lines.length);
  check('a wider image does not change the letter size',
        Math.abs(wide.size - square.size) < 0.01);
}

{
  const taller = bandOf('HELLO', 480, 480, 2);
  const plain = bandOf('HELLO', 480, 480, 1);
  check('the size control grows the band', taller.bandHeight > plain.bandHeight);
}

{
  // Every line is centred, and the band starts at its own top rather than
  // the image's — the preview offsets it, the capture does not.
  const laid = bandOf('ONE\nTWO');
  check('band lines are centred', laid.lines.every((l) => l.x === 240));
  check('the band starts at its own origin', laid.lines[0].y >= 0);
  check('the last line sits inside the band',
        laid.lines[1].y + laid.size <= laid.bandHeight + 1);
}

{
  /*
   * drawBand paints a white panel and black text with no outline. Recording
   * the calls is the only way to assert "no outline" — a stroke of zero is
   * not something the geometry can show.
   */
  const calls = [];
  const rec = {
    font: '10px x', fillStyle: '', strokeStyle: '', textAlign: '', textBaseline: '',
    measureText(t) { return { width: t.length * 0.82 * (parseFloat(this.font) || 10) }; },
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    fillRect(...a) { calls.push(['fillRect', this.fillStyle, ...a]); },
    fillText(t, x, y) { calls.push(['fillText', this.fillStyle, t, x, y]); },
    strokeText(t) { calls.push(['strokeText', t]); },
  };
  const h = drawBand(rec, 'HI', { width: 480, height: 480, family: 'Impact' });
  const rects = calls.filter((c) => c[0] === 'fillRect');
  const texts = calls.filter((c) => c[0] === 'fillText');
  check('drawBand reports the height it drew', h > 0);
  check('drawBand paints one panel', rects.length === 1);
  check('the panel is white', rects[0][1] === '#fff');
  check('the panel spans the full width and the band', rects[0][4] === 480 && rects[0][5] === h);
  check('the text is black', texts.length === 1 && texts[0][1] === '#000');
  check('the band is never stroked', !calls.some((c) => c[0] === 'strokeText'));
  check('drawBand leaves the context as it found it',
        calls[0][0] === 'save' && calls[calls.length - 1][0] === 'restore');

  const empty = [];
  const rec2 = { ...rec, fillRect: (...a) => empty.push(a), fillText: (...a) => empty.push(a) };
  check('an empty band draws nothing', drawBand(rec2, '  ', { width: 480, height: 480, family: 'Impact' }) === 0);
  check('an empty band really draws nothing', empty.length === 0);
}

console.log('\nbundled fonts');
/*
 * The three places a bundled font is named — the @font-face rules, the
 * "Included" options, and BUNDLED_FONTS in main.js — have to agree exactly.
 * Nothing shouts when they do not: the browser simply falls back, and since
 * the caption is sized by measuring the font, it quietly comes out at a
 * different size and wraps somewhere else. That is the bug this catches.
 */
const root = join(here, '..');
const css = readFileSync(join(root, 'src/style.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8');

const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => ({
  family: (/font-family:\s*'([^']+)'/.exec(m[1]) || [])[1],
  file: (/url\('([^']+)'\)/.exec(m[1]) || [])[1],
  range: /unicode-range:/.test(m[1]),
  display: /font-display:\s*block/.test(m[1]),
}));
check('five faces are declared', faces.length === 5, `got ${faces.length}`);
check('every face names a family', faces.every((f) => f.family));
check('every face file exists',
  faces.every((f) => f.file && existsSync(join(root, 'src', f.file))),
  faces.filter((f) => !f.file || !existsSync(join(root, 'src', f.file))).map((f) => f.file).join());
// Without unicode-range the browser assumes the subset covers everything and
// draws missing-glyph boxes instead of falling through to the next font.
check('every face limits its unicode-range', faces.every((f) => f.range));
check('every face blocks rather than swapping', faces.every((f) => f.display));

const menu = (/<select id="text-font">([\s\S]*?)<\/select>/.exec(html) || [])[1] || '';
const firstFamilies = [...menu.matchAll(/<option value="((?:'[^']*'|[^",])+)/g)]
  .map((m) => m[1].trim().replace(/^'|'$/g, ''));
// Only bundled faces are offered now, so every option must be one.
check('the menu offers nothing but bundled faces',
  firstFamilies.every((f) => faces.some((x) => x.family === f)),
  firstFamilies.join(' | '));
check('five fonts are offered', firstFamilies.length === 5, firstFamilies.join(' | '));
check('each offered font has a @font-face',
  firstFamilies.every((f) => faces.some((face) => face.family === f)),
  firstFamilies.filter((f) => !faces.some((x) => x.family === f)).join());

const declared = (/const BUNDLED_FONTS = \[([^\]]*)\]/.exec(mainJs) || [])[1] || '';
const preloaded = [...declared.matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('main.js preloads five', preloaded.length === 5, preloaded.join());
check('main.js preloads exactly what is declared',
  preloaded.slice().sort().join() === faces.map((f) => f.family).sort().join(),
  `${preloaded.sort().join()} vs ${faces.map((f) => f.family).sort().join()}`);

// Shipping a font without its licence is the thing this whole change exists
// to avoid, so it is worth a test of its own.
for (const f of faces) {
  const name = f.file.split('/').pop().replace('-latin.woff2', '');
  check(`${name} ships a licence`,
    readdirSync(join(root, 'vendor/fonts')).some((x) => /^OFL-.*\.txt$/.test(x)
      && readFileSync(join(root, 'vendor/fonts', x), 'utf8')
        .toLowerCase().includes(f.family.toLowerCase().replace(' ', ''))
      || readdirSync(join(root, 'vendor/fonts')).includes(`OFL-${f.family.replace(' ', '')}.txt`)));
}

/* ------------------------------------------------------------ materials */

console.log('\nmaterials: the two paths');
{
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  const map = new THREE.Texture();
  const normalMap = new THREE.Texture();
  const pbr = new THREE.MeshStandardMaterial({ map, normalMap, emissive: 0xff0000 });
  const classic = toClassic(pbr, mesh, { shininess: 40, specular: 0 });
  check('Classic is Phong', classic.isMeshPhongMaterial);
  check('Classic keeps the colour map', classic.map === map);
  // The point of Classic: it is the old renderer, so it must *not* grow maps.
  check('Classic drops the normal map, as it always has', !classic.normalMap);
  check('Classic drops emission, as it always has', classic.emissive.getHex() === 0);
  check('Physical uses a PBR source as it is', toPhysical(pbr, mesh) === pbr);
  const unlit = new THREE.MeshBasicMaterial();
  check('an unlit source stays unlit', toPhysical(unlit, mesh) === unlit);

  const phong = new THREE.MeshPhongMaterial({ map, normalMap, shininess: 30,
    emissive: 0x00ff00, alphaMap: new THREE.Texture() });
  const upgraded = toPhysical(phong, mesh);
  check('Phong upgrades to Standard', upgraded.isMeshStandardMaterial && upgraded !== phong);
  check('upgrade keeps the colour map', upgraded.map === map);
  check('upgrade keeps the normal map', upgraded.normalMap === normalMap);
  check('upgrade keeps emission', upgraded.emissive.getHex() === 0x00ff00);
  check('upgrade is a non-metal', upgraded.metalness === 0);
  check('upgrade does not take the MTL alpha map', !upgraded.alphaMap);
  check('glossier Phong is smoother', shininessToRoughness(200) < shininessToRoughness(10));
  check('roughness stays in range', shininessToRoughness(0) <= 1 && shininessToRoughness(1e6) >= 0.04);

  const set = new THREE.MeshPhongMaterial({ map });
  set.roughnessMap = new THREE.Texture();
  set.metalnessMap = new THREE.Texture();
  set.userData.textureSet = true;
  const fromSet = toPhysical(set, mesh);
  check('a found texture set carries its data maps',
    fromSet.roughnessMap === set.roughnessMap && fromSet.metalnessMap === set.metalnessMap);
  check('a metalness map drives metalness fully', fromSet.metalness === 1 && fromSet.roughness === 1);
  check('a found set asks for Physical', wantsPhysical(set) && !wantsPhysical(new THREE.MeshPhongMaterial()));
}

console.log('\nmaterials: layer switches');
{
  const map = new THREE.Texture();
  const normalMap = new THREE.Texture();
  const m = new THREE.MeshStandardMaterial({ map, normalMap, emissive: 0x404040,
    emissiveIntensity: 2, transparent: true, opacity: 0.5, alphaTest: 0.1 });
  m.normalScale.set(1, -1);
  check('reports the layers it uses',
    layersOf(m).join() === 'map,normal,emission,alpha', layersOf(m).join());

  const v0 = m.version;
  applyLayers(m, ALL_LAYERS_ON);
  check('all on changes nothing', m.map === map && m.normalMap === normalMap && m.opacity === 0.5);
  check('all on does not recompile', m.version === v0);

  applyLayers(m, { ...ALL_LAYERS_ON, map: false, normal: false, emission: false, alpha: false });
  check('colour map off', m.map === null);
  check('normal map off', m.normalMap === null);
  check('emission off', m.emissiveIntensity === 0);
  check('transparency off', !m.transparent && m.opacity === 1 && m.alphaTest === 0);
  check('a switched-off layer still counts as present', layersOf(m).includes('map'));
  check('removing a map recompiles', m.version > v0);

  applyLayers(m, ALL_LAYERS_ON, { normalStrength: 2, emissionStrength: 3 });
  check('back on is exact', m.map === map && m.normalMap === normalMap
    && m.transparent && m.opacity === 0.5 && m.alphaTest === 0.1);
  check('strengths multiply the original, not the last value',
    m.emissiveIntensity === 6 && m.normalScale.x === 2 && m.normalScale.y === -2);
  const v1 = m.version;
  applyLayers(m, ALL_LAYERS_ON, { normalStrength: 0.5, emissionStrength: 1 });
  check('a strength alone does not recompile', m.version === v1);
  check('strength applied again from the snapshot', m.emissiveIntensity === 2 && m.normalScale.x === 0.5);

  const phong = new THREE.MeshPhongMaterial();
  applyLayers(phong, { ...ALL_LAYERS_ON, metalRough: false });
  check('switches a material lacks are ignored', !('metalnessMap' in phong));
  check('every layer has a label and a test', LAYERS.every((l) => l.label && typeof l.has === 'function'));
}

console.log('\nmaterials: debug views');
{
  const map = new THREE.Texture();
  const rough = new THREE.Texture();
  const m = new THREE.MeshStandardMaterial({ map, roughnessMap: rough, roughness: 0.5,
    emissive: 0x112233, emissiveMap: new THREE.Texture(), normalMap: new THREE.Texture() });
  check('final is the material itself', debugMaterial(m, 'final') === m);
  const albedo = debugMaterial(m, 'albedo');
  check('base colour is unlit and carries the map', albedo.isMeshBasicMaterial && albedo.map === map);
  check('debug views are not tone mapped', !albedo.toneMapped);
  const normals = debugMaterial(m, 'normals');
  check('normals view uses the normal map', normals.isMeshNormalMaterial && normals.normalMap === m.normalMap);
  const roughness = debugMaterial(m, 'roughness');
  check('roughness view samples the roughness map', roughness.map === rough);
  check('channel views compile per channel',
    roughness.customProgramCacheKey() !== debugMaterial(m, 'metalness').customProgramCacheKey());
  check('emission view carries the emissive map', debugMaterial(m, 'emission').map === m.emissiveMap);
  check('wireframe is a wireframe', debugMaterial(m, 'wireframe').wireframe === true);
  check('every view builds', VIEWS.every((v) => debugMaterial(m, v)));
}

console.log('\nmaterials: filtering');
{
  const t = new THREE.Texture();
  const before = [t.magFilter, t.minFilter, t.anisotropy];
  applyFiltering(t, 'pixel', 16);
  check('pixelated samples the nearest texel', t.magFilter === THREE.NearestFilter);
  applyFiltering(t, 'sharp', 16);
  check('sharp raises anisotropy', t.anisotropy === 16 && t.magFilter === before[0]);
  applyFiltering(t, 'smooth', 16);
  check('smooth restores the loader\'s choice exactly',
    t.magFilter === before[0] && t.minFilter === before[1] && t.anisotropy === before[2]);
}

/* ------------------------------------------------------------- collada */

console.log('\ncollada: sampler wrap modes');
check('WRAP repeats', wrapModeFor('WRAP') === THREE.RepeatWrapping);
check('MIRROR mirrors', wrapModeFor('MIRROR') === THREE.MirroredRepeatWrapping);
check('CLAMP clamps', wrapModeFor(' clamp ') === THREE.ClampToEdgeWrapping);
check('BORDER clamps', wrapModeFor('BORDER') === THREE.ClampToEdgeWrapping);
check('nonsense is ignored', wrapModeFor('SIDEWAYS') === null && wrapModeFor(undefined) === null);
{
  // The shape of the Toad file: one clamped sampler, one mirrored.
  const dae = `<COLLADA><library_effects>
    <effect id="Effect_Material0"><profile_COMMON>
      <newparam sid="surface_0"><surface type="2D"><init_from>Texture0</init_from></surface></newparam>
      <newparam sid="sampler_0"><sampler2D><source>surface_0</source>
        <wrap_s>CLAMP</wrap_s><wrap_t>CLAMP</wrap_t></sampler2D></newparam>
      <technique sid="common"><phong><diffuse><texture texture="sampler_0" texcoord="CHANNEL0"/></diffuse></phong></technique>
    </profile_COMMON></effect>
    <effect id="Effect_Material6"><profile_COMMON>
      <newparam sid="sampler_6"><sampler2D><source>surface_6</source>
        <wrap_s>MIRROR</wrap_s><wrap_t>MIRROR</wrap_t></sampler2D></newparam>
    </profile_COMMON></effect>
    <effect id="Effect_NoWrap"><profile_COMMON>
      <newparam sid="sampler_x"><sampler2D><source>surface_x</source></sampler2D></newparam>
    </profile_COMMON></effect>
  </library_effects></COLLADA>`;
  const wraps = samplerWraps(dae);
  check('reads each sampler', wraps.size === 2, `got ${wraps.size}`);
  check('keyed by effect and sampler',
    wraps.get('Effect_Material6|sampler_6')?.s === THREE.MirroredRepeatWrapping);
  check('a clamped sampler clamps',
    wraps.get('Effect_Material0|sampler_0')?.t === THREE.ClampToEdgeWrapping);
  check('a sampler that says nothing is left out', !wraps.has('Effect_NoWrap|sampler_x'));

  // What ColladaLoader.parse() hands back, reduced to the parts that matter.
  const texture = new THREE.Texture();
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;       // the loader's blanket default
  const kept = new THREE.Texture();
  kept.wrapS = kept.wrapT = THREE.ClampToEdgeWrapping;         // set by a MAYA technique
  const library = {
    materials: {
      a: { url: 'Effect_Material0', build: new THREE.MeshPhongMaterial({ map: texture }) },
      b: { url: 'Effect_Material6', build: new THREE.MeshPhongMaterial({ map: kept }) },
    },
    effects: {
      Effect_Material0: { profile: { technique: { parameters: {
        diffuse: { texture: { id: 'sampler_0' } } } } } },
      Effect_Material6: { profile: { technique: { parameters: {
        diffuse: { texture: { id: 'sampler_6', extra: { technique: { wrapU: 0 } } } } } } } },
    },
  };
  const changed = applySamplerWraps({ library }, dae);
  check('the declared wrap replaces the loader default', texture.wrapS === THREE.ClampToEdgeWrapping);
  check('a MAYA technique the loader honoured is left alone', kept.wrapS === THREE.ClampToEdgeWrapping);
  check('reports what it changed', changed === 1, `got ${changed}`);
  check('nothing to do is not an error', applySamplerWraps(null, dae) === 0);
}

console.log('\ncollada: coordinate sets');
{
  const onlySet1 = new THREE.BufferGeometry();
  onlySet1.setAttribute('uv1', new THREE.Float32BufferAttribute([0, 0, 1, 1], 2));
  const both = new THREE.BufferGeometry();
  both.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0], 2));
  both.setAttribute('uv1', new THREE.Float32BufferAttribute([1, 1], 2));
  const root = new THREE.Group();
  root.add(new THREE.Mesh(onlySet1), new THREE.Mesh(both));
  const promoted = promoteOnlyUvSet(root);
  check('a mesh with only set 1 draws from it', onlySet1.attributes.uv === onlySet1.attributes.uv1);
  check('a mesh with set 0 is left alone', both.attributes.uv.getX(0) === 0);
  check('counts what it promoted', promoted === 1);
}

console.log('\narchive: texture sets');
check('colour and normal share a set',
  setKeyOf('t/#CAM0001_Textures_COL_4k.png') === setKeyOf('t/#CAM0001_Textures_NRML_4k.png'));
check('roughness joins the set',
  setKeyOf('t/#CAM0001_Textures_COL_4k.png') === setKeyOf('t/#CAM0001_Textures_ROUGH_4k.png'));
check('occlusion joins the set',
  setKeyOf('t/#CAM0001_Textures_COL_4k.png') === setKeyOf('t/#CAM0001_Textures_AO_4k.png'));
check('glTF-style names pair up',
  setKeyOf('hull_01_baseColor.png') === setKeyOf('hull_01_normal.png'));
check('a different set does not pair',
  setKeyOf('hull_01_baseColor.png') !== setKeyOf('hull_02_normal.png'));

console.log('\nbackground picture');
{
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  // A 16:9 picture on a square image: fits the height, sides cut off equally.
  const wide = placeBackdrop(1920, 1080, 480, 480);
  check('fits the height by default', near(wide.height, 480) && near(wide.y, 0));
  check('a wide picture overhangs both sides equally',
    near(wide.width, 480 * 16 / 9) && near(wide.x, (480 - wide.width) / 2) && wide.x < 0);

  // A tall picture leaves clear strips either side.
  const tall = placeBackdrop(500, 1000, 480, 480);
  check('a narrow picture leaves the sides uncovered',
    near(tall.width, 240) && near(tall.x, 120));

  // Relative everything: doubling the image doubles every number.
  const opts = { size: 140, x: 30, y: -45 };
  const a = placeBackdrop(1920, 1080, 480, 320, opts);
  const b = placeBackdrop(1920, 1080, 960, 640, opts);
  check('keeps its relative size and place when the image is resized',
    near(b.x, a.x * 2) && near(b.y, a.y * 2) && near(b.width, a.width * 2)
    && near(b.height, a.height * 2));

  check('size is a percentage of the fitted size',
    near(placeBackdrop(100, 100, 480, 480, { size: 50 }).height, 240));
  check('size 0 draws nothing', placeBackdrop(100, 100, 480, 480, { size: 0 }).width === 0);

  const right = placeBackdrop(1000, 1000, 480, 480, { x: 100 });
  const up = placeBackdrop(1000, 1000, 480, 480, { y: 100 });
  check('+100 across slides it just off the right edge', near(right.x, 480));
  check('+100 up slides it just off the top edge', near(up.y + up.height, 0));
  const zoomed = placeBackdrop(1000, 1000, 480, 480, { size: 400, x: -100 });
  check('a zoomed picture can still be panned past its own edge',
    near(zoomed.x + zoomed.width, 0));

  // drawBackdrop: what reaches the context.
  const calls = [];
  const ctx = {
    save: () => calls.push('save'), restore: () => calls.push('restore'),
    beginPath() {}, clip: () => calls.push('clip'),
    rect: (...r) => calls.push(['rect', ...r]),
    fillRect: (...r) => calls.push(['fillRect', ...r]),
    drawImage: (img, ...r) => calls.push(['drawImage', ...r]),
    set fillStyle(v) { calls.push(['fillStyle', v]); },
  };
  drawBackdrop(ctx, null, { width: 480, height: 480 });
  check('no background draws nothing', calls.length === 0);
  drawBackdrop(ctx, { colour: '#123456' }, { width: 480, height: 480, top: 90, total: 570 });
  check('a colour fills the whole frame, band included',
    JSON.stringify(calls) === JSON.stringify([['fillStyle', '#123456'], ['fillRect', 0, 0, 480, 570]]));
  calls.length = 0;
  drawBackdrop(ctx, { image: { width: 1000, height: 1000 }, size: 100, x: 0, y: 0 },
    { width: 480, height: 480, top: 90, total: 570 });
  const draw = calls.find((c) => c[0] === 'drawImage');
  check('a picture sits in the render, below the band, clipped to it',
    JSON.stringify(draw) === JSON.stringify(['drawImage', 0, 90, 480, 480])
    && calls.some((c) => c[0] === 'rect' && c[2] === 90 && c[4] === 480) && calls.includes('clip'));
}

console.log('\npreflight');
{
  const source = readFileSync(join(root, 'src', 'preflight.js'), 'utf8');

  // Just enough of a browser to run src/preflight.js: elements that hold
  // text and children, canvases whose answers each test chooses, and a
  // window whose events the test fires by hand.
  function makeBrowser(opts = {}) {
    const o = { protocol: 'http:', importMaps: true, webgl2: true, webgl1: true,
      fast: true, offscreen: true, imageBitmap: true, readback: 'ok', ...opts };
    const byId = (node, id) => {
      if (node.attrs?.id === id) return node;
      for (const child of node.children ?? []) {
        const hit = byId(child, id);
        if (hit) return hit;
      }
      return null;
    };
    const textOf = (node) => (node.text ?? '') + (node.children ?? []).map(textOf).join('');
    const make2d = () => {
      const pixels = new Uint8ClampedArray(64);
      let fill = [0, 0, 0];
      return {
        set fillStyle(v) { fill = v.match(/\d+/g).map(Number); },
        fillRect(x, y) { pixels.set([...fill, 255], (y * 4 + x) * 4); },
        getImageData() {
          if (o.readback === 'throw') throw new Error('SecurityError');
          const data = Uint8ClampedArray.from(pixels);
          if (o.readback === 'noise') data[5] += 1;
          if (o.readback === 'blank') data.fill(255);
          return { data };
        },
      };
    };
    const makeElement = (tag) => {
      const node = {
        tagName: tag.toUpperCase(), attrs: {}, children: [], parentNode: null,
        style: {}, listeners: {}, text: '',
        set textContent(v) { this.text = String(v); this.children = []; },
        get textContent() { return textOf(this); },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] ?? null; },
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
        removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; },
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
        querySelectorAll(sel) {
          const cls = sel.replace('.', '');
          const out = [];
          const walk = (n) => { for (const c of n.children) { if ((c.attrs.class ?? '').split(' ').includes(cls)) out.push(c); walk(c); } };
          walk(this);
          return out;
        },
        focus() {},
      };
      if (tag === 'canvas') {
        node.getContext = (kind, attributes) => {
          if (kind === '2d') return make2d();
          const ok = kind === 'webgl2' ? o.webgl2 && (!attributes?.failIfMajorPerformanceCaveat || o.fast)
            : kind === 'webgl' ? o.webgl1 : false;
          if (!ok) {
            for (const fn of node.listeners.webglcontextcreationerror ?? []) fn({ statusMessage: 'blocklisted' });
            return null;
          }
          return { RENDERER: 1, getExtension: () => null, getParameter: () => 'Fake GPU' };
        };
      }
      return node;
    };
    const body = makeElement('body');
    const alerts = makeElement('div'); alerts.setAttribute('id', 'alerts'); body.appendChild(alerts);
    const document = {
      body,
      createElement: makeElement,
      getElementById: (id) => byId(body, id),
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      removeEventListener() {},
    };
    const window = {
      document,
      location: { protocol: o.protocol, origin: 'http://localhost:8000', host: 'localhost:8000' },
      navigator: { userAgent: 'TestBrowser/1.0' },
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      setTimeout: (fn) => fn(),
      HTMLScriptElement: o.importMaps === null ? {} : { supports: (t) => t === 'importmap' && o.importMaps },
      createImageBitmap: o.imageBitmap ? () => {} : undefined,
    };
    if (o.offscreen) {
      window.OffscreenCanvas = function () { return { getContext: (k) => (k === '2d' ? make2d() : null) }; };
    }
    const fire = (type, event = {}) => { for (const fn of window.listeners[type] ?? []) fn(event); };
    vm.runInNewContext(source, { window });
    // Each message under the file browser: its colour and its text.
    const shown = () => alerts.children.map((a) => ({
      level: a.children[0].attrs.class === 'warn' ? 'red' : 'orange', text: textOf(a),
    }));
    const check = () => { window.Funee.showCheck(); return textOf(document.getElementById('browser-check-panel')); };
    return { window, document, fire, shown, check, Funee: window.Funee };
  }

  const { Funee } = makeBrowser();
  const M = Funee.MESSAGES;
  const healthy = { protocol: 'http:', importMaps: true, webgl2: true, webgl1: true,
    software: false, offscreen2d: true, imageBitmap: true, readback: 'ok' };
  const ids = (f) => JSON.stringify(Funee.checks({ ...healthy, ...f }));
  check('a healthy browser has no problems', ids({}) === '[]');
  check('opened from disk is F1', ids({ protocol: 'file:' }) === '["F1"]');
  check('no import maps is F2', ids({ importMaps: false }) === '["F2"]');
  check('unknown import-map support is not a failure', ids({ importMaps: null }) === '[]');
  check('no WebGL at all is F3a', ids({ webgl2: false, webgl1: false }) === '["F3a"]');
  check('WebGL 1 only is F3b', ids({ webgl2: false, webgl1: true }) === '["F3b"]');
  check('no OffscreenCanvas is F4', ids({ offscreen2d: false }) === '["F4"]');
  check('no createImageBitmap is F5', ids({ imageBitmap: false }) === '["F5"]');
  check('blocked read-back is F6', ids({ readback: 'blocked' }) === '["F6"]');
  check('software 3D is only a warning', ids({ software: true }) === '["W1"]');
  check('altered pixels are only a warning', ids({ readback: 'altered' }) === '["W2"]');

  // Start-up, end to end.
  const only = (b, level) => b.shown().filter((a) => a.level === level);
  let b = makeBrowser();
  b.Funee.ready();
  b.fire('load');
  check('a started app on a healthy browser shows nothing', b.shown().length === 0);
  check('nothing is ever a pop-up: no panel until Browser check is asked for',
    !b.document.getElementById('browser-check-panel'));

  b = makeBrowser();
  b.fire('error', { message: 'The requested module does not provide <b>setKeyOf</b>',
    filename: 'http://localhost:8000/src/loaders.js', lineno: 13 });
  b.fire('error', { target: { src: 'http://localhost:8000/src/main.js', type: 'module' } });
  b.fire('load');
  let red = only(b, 'red');
  check('an app that never called ready() gets one red "did not start"',
    red.length === 1 && red[0].text.includes(M.F7.title));
  check('a line is just the headline and a link to the Browser check',
    red[0].text === M.F7.title + ' Browser check');
  check('the Browser check holds the explanation',
    b.check().includes(M.F7.why) && b.check().includes(M.F7.tryText));
  const report = b.check();
  check('the error that stopped it is in the Browser check details, as plain text',
    report.includes('provide <b>setKeyOf</b> (/src/loaders.js:13)'));
  check('a module that failed to load is named, with its imports',
    report.includes('Could not load /src/main.js or one of the files it imports'));
  check('nothing is built from HTML', !/\.innerHTML\b/.test(source));

  b = makeBrowser({ webgl2: false, webgl1: false });
  b.fire('load');
  red = only(b, 'red');
  check('WebGL switched off is reported as that, not as "did not start"',
    red.length === 1 && red[0].text.includes(M.F3a.title));
  check("the browser's own reason reaches the Browser check", b.check().includes('WebGL reason: blocklisted'));

  b = makeBrowser({ webgl2: false, webgl1: true });
  b.fire('load');
  check('WebGL 1 only is red', only(b, 'red').some((a) => a.text.includes(M.F3b.title)));

  b = makeBrowser({ protocol: 'file:' });
  b.fire('load');
  check('opened from disk is red when it stops the start',
    only(b, 'red').some((a) => a.text.includes(M.F1.title)));

  b = makeBrowser({ protocol: 'file:' });
  b.Funee.ready();
  b.fire('load');
  check('opened from disk is not reported where the app runs anyway (Firefox)', b.shown().length === 0);

  b = makeBrowser({ readback: 'blank' });
  b.Funee.ready();
  b.fire('load');
  check('an image read back as something else is red',
    only(b, 'red').some((a) => a.text.includes(M.F6.title)));

  b = makeBrowser({ readback: 'noise', fast: false });
  b.Funee.ready();
  b.fire('load');
  check('slow 3D is one orange line', only(b, 'red').length === 0
    && JSON.stringify(b.shown()) === JSON.stringify([{ level: 'orange', text: M.W1.title + ' Browser check' }]));
  check('altered pixels are not shown on the page, only explained in the Browser check',
    !b.shown().some((a) => a.text.includes(M.W2.title))
    && b.check().includes(M.W2.title) && b.check().includes(M.W2.why));

  b = makeBrowser();
  b.Funee.ready();
  b.fire('load');
  b.Funee.raise('W4');
  b.Funee.raise('W4');
  check('a lost feature reported by the app is one orange line',
    only(b, 'orange').filter((a) => a.text.includes(M.W4.title)).length === 1);
  b.Funee.contextLost();
  red = only(b, 'red');
  check('the graphics card dropping out is one red line',
    red.length === 1 && red[0].text === M.R1.title + ' Browser check');
  check('its Reload link is in the Browser check', b.check().includes('Reload the page'));

  b = makeBrowser();
  b.Funee.ready();
  b.fire('load');
  b.fire('error', { message: 'late failure' });
  b.fire('error', { message: 'another failure' });
  b.fire('unhandledrejection', { reason: { name: 'AbortError', message: 'aborted' } });
  check('errors after start-up are one orange line, however many',
    b.shown().length === 1 && b.shown()[0].level === 'orange' && b.shown()[0].text.includes(M.R3.title));
  check('each error message is in the Browser check, cancellations are not',
    b.check().includes('late failure') && b.check().includes('another failure') && !b.check().includes('aborted'));

  // Minor problems appear in the Browser check and nowhere else.
  b = makeBrowser();
  b.Funee.ready();
  b.fire('load');
  b.Funee.extras = { halfFloat: true, webp: true, maxSamples: 0, antialias: true,
    maxAnisotropy: 1, maxTextureSize: 2048, oversizedTexture: 4096 };
  const list = b.check();
  check('minor problems show only in the Browser check',
    b.shown().length === 0 && list.includes('❌  Anti-aliased edges')
    && list.includes('❌  Sharp texture filtering')
    && list.includes('some are 4096 px, over the 2048 px limit'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
