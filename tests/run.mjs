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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
