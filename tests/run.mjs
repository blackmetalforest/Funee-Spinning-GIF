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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
