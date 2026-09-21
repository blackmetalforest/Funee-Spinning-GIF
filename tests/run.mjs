/**
 * Node tests for the pure-logic modules.
 *
 * Only the parts that need no DOM are covered here: timing and the two muxers.
 * The rendering path is verified in a real browser instead — see README.
 *
 *   node tests/run.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
         usableWidth, fontBasis } from '../src/overlay-text.js';
import { zipSync, strToU8 } from '../vendor/fflate.module.js';

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

const top1 = layoutText(stub(), { top: 'A' }, box).lines;
const top2 = layoutText(stub(), { top: 'A'.repeat(40) }, box).lines;
check('the first top line does not move', top1[0].y === top2[0].y);

check('an empty caption places nothing',
  layoutText(stub(), { top: '', middle: '', bottom: '' }, box).lines.length === 0);
check('isBlank spots an empty caption', isBlank({ top: ' ', middle: '', bottom: null }));
check('isBlank spots a filled one', !isBlank({ bottom: 'x' }));
check('isBlank tolerates nothing at all', isBlank());

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
