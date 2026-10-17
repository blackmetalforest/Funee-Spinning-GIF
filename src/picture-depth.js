/**
 * Depth for a picture: its solid parts cut out and given thickness, like a
 * shape cut from a thick sheet.
 *
 * Any still picture can have it; one with no see-through parts is all solid
 * and becomes a block (image-model.js
 * builds the slab the first time Depth is switched on). Everything here works
 * on plain arrays, so the tests can run it without a browser.
 *
 * **Solid or not.** A pixel at least half opaque is solid and anything less is
 * empty space (SOLID_ALPHA). A feathered edge would otherwise leave nowhere
 * definite for the body to end.
 *
 * **Outline.** The boundary between solid and empty pixels is followed as
 * closed loops, solid always on the left: an object's outside edge runs
 * anticlockwise and a hole's clockwise. Each loop is drawn through the middle
 * of every pixel edge it passes, which already cuts each stair step into a
 * diagonal. A light smoothing then rounds off the pattern the steps leave on
 * a curve, and points that lie on a straight line are dropped.
 *
 * **The slab.** A front face and a back face, each the outline filled in, and
 * a wall around every loop. The faces show the picture, with the colours
 * just outside the outline filled in from the nearest solid pixel
 * (solidPixels), so that no dark fringe of see-through pixels is blended into
 * the edge. The wall takes the colour of the picture just inside its edge,
 * run straight back through the thickness, from a blurred copy (wallPixels):
 * read pixel by pixel, a thin drawn outline turns into streaks. The slab is
 * one unit deep, from z −0.5 to 0.5, and the scene scales it to the
 * thickness chosen.
 */

import { ShapeUtils, Vector2 } from '../vendor/three/three.module.js';

/** Alpha from which a pixel counts as solid: 50%. */
export const SOLID_ALPHA = 128;

/** Smoothing passes over each outline. */
const SMOOTH_PASSES = 6;
/** How far, in pixels, an outline may stray from a straight line and still be one. */
const SIMPLIFY_PX = 0.2;
/** Outlines enclosing less than this many square pixels are specks, and are left out. */
const SPECK_PX = 1;
/** How far along the outline, each way, the wall's shading looks for its direction, in pixels. */
const NORMAL_SPAN_PX = 4;
/** The wall's shading turns a sharp corner rather than rounding it from here on. */
const CREASE_DEG = 40;
/**
 * How far inside the outline, in pixels, the wall takes its colour from. The
 * pixels right at the edge are the half see-through ones, whose colour is
 * often a fringe of whatever the picture was drawn over, and one pixel's
 * fringe after another reads as streaks along the wall.
 */
const WALL_INSET_PX = 1.5;

/** 1 for each solid pixel of an RGBA picture, 0 for each empty one. */
export function solidMask(rgba, width, height) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3] >= SOLID_ALPHA ? 1 : 0;
  return mask;
}

/**
 * The solid parts' outlines, as loops of [x0, y0, x1, y1, …] in pixels,
 * with y counting rows from the first. Solid is on the left of every loop.
 *
 * The loop walks the corners between pixels. Where two solid pixels touch
 * only at a corner, it turns right and keeps them joined, so a thin diagonal
 * line stays one piece rather than falling apart into a chain of squares.
 */
export function traceOutlines(mask, width, height) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? mask[y * width + x] : 0);
  // Which of each pixel's edges have been walked: 1 bottom, 2 top, 4 left, 8 right.
  const walked = new Uint8Array(width * height);
  const loops = [];

  const follow = (startX, startY) => {
    const points = [];
    let x = startX;
    let y = startY;
    let dx = 1;
    let dy = 0;
    for (;;) {
      // The pixel whose edge this step runs along, with solid on the left.
      let pixel;
      let bit;
      if (dx === 1) { pixel = y * width + x; bit = 1; }
      else if (dx === -1) { pixel = (y - 1) * width + x - 1; bit = 2; }
      else if (dy === 1) { pixel = y * width + x - 1; bit = 8; }
      else { pixel = (y - 1) * width + x; bit = 4; }
      if (walked[pixel] & bit) break;
      walked[pixel] |= bit;
      points.push(x + dx / 2, y + dy / 2);
      x += dx;
      y += dy;

      // The four pixels around the corner now reached.
      const ne = at(x, y);
      const nw = at(x - 1, y);
      const se = at(x, y - 1);
      const sw = at(x - 1, y - 1);
      if ((ne && sw && !nw && !se) || (nw && se && !ne && !sw)) {
        [dx, dy] = [dy, -dx];                        // touching corners: turn right
      } else if (ne && !se) { dx = 1; dy = 0; }
      else if (sw && !nw) { dx = -1; dy = 0; }
      else if (nw && !ne) { dx = 0; dy = 1; }
      else { dx = 0; dy = -1; }
    }
    return points;
  };

  // Every loop has a step along the bottom of some solid pixel.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] && !(walked[i] & 1) && !at(x, y - 1)) loops.push(follow(x, y));
    }
  }
  return loops;
}

/** Twice the area a loop encloses: positive anticlockwise (an outside edge), negative for a hole. */
export function loopArea(points) {
  let sum = 0;
  const n = points.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    sum += points[j] * points[i + 1] - points[i] * points[j + 1];
  }
  return sum / 2;
}

/**
 * Round a loop's stair pattern off. Each pass pulls every point towards its
 * neighbours and then pushes it back slightly further (Taubin's method), which
 * evens out the steps without shrinking the shape as plain averaging would.
 */
export function smoothLoop(points, passes = SMOOTH_PASSES) {
  const n = points.length / 2;
  let from = Float64Array.from(points);
  let to = new Float64Array(points.length);
  for (let pass = 0; pass < passes; pass++) {
    for (const weight of [0.5, -0.53]) {
      for (let k = 0; k < n; k++) {
        const p = ((k + n - 1) % n) * 2;
        const q = ((k + 1) % n) * 2;
        to[k * 2] = from[k * 2] + weight * ((from[p] + from[q]) / 2 - from[k * 2]);
        to[k * 2 + 1] = from[k * 2 + 1] + weight * ((from[p + 1] + from[q + 1]) / 2 - from[k * 2 + 1]);
      }
      [from, to] = [to, from];
    }
  }
  return Array.from(from);
}

/** Drop the points of a loop that lie within `tolerance` of a straight line (Douglas–Peucker). */
export function simplifyLoop(points, tolerance = SIMPLIFY_PX) {
  const n = points.length / 2;
  if (n <= 4) return points.slice();
  // Split the loop at its first point and the point farthest from it.
  let far = 0;
  let best = -1;
  for (let k = 1; k < n; k++) {
    const d = (points[k * 2] - points[0]) ** 2 + (points[k * 2 + 1] - points[1]) ** 2;
    if (d > best) { best = d; far = k; }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  const px = (k) => points[(k % n) * 2];
  const py = (k) => points[(k % n) * 2 + 1];
  const stack = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = px(a); const ay = py(a);
    const ex = px(b) - ax; const ey = py(b) - ay;
    const length = Math.hypot(ex, ey) || 1;
    let worst = 0;
    let at = -1;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((px(k) - ax) * ey - (py(k) - ay) * ex) / length;
      if (d > worst) { worst = d; at = k; }
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(px(k), py(k));
  return out;
}

/** Whether a point is inside a loop. */
function inside(x, y, points) {
  let result = false;
  const n = points.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const yi = points[i + 1];
    const yj = points[j + 1];
    if ((yi > y) !== (yj > y)
      && x < ((points[j] - points[i]) * (y - yi)) / (yj - yi) + points[i]) result = !result;
  }
  return result;
}

/**
 * The picture's solid parts as shapes: each an outside edge with the holes
 * inside it. A hole belongs to the smallest outside edge around it, so an
 * island inside a hole inside a shape comes out as two shapes.
 */
export function outlineShapes(mask, width, height) {
  // Solid all over, as a picture with no transparency is: a plain box, square
  // at the corners. Traced and smoothed, a small one would come out rounded.
  if (mask.every((solid) => solid)) {
    return [{ outline: [0, 0, width, 0, width, height, 0, height], holes: [] }];
  }
  const loops = traceOutlines(mask, width, height)
    .map((loop) => withoutRepeats(simplifyLoop(smoothLoop(loop))))
    .map((points) => ({ points, area: loopArea(points) }))
    .filter((loop) => loop.points.length >= 6 && Math.abs(loop.area) >= SPECK_PX);

  const shapes = loops.filter((loop) => loop.area > 0)
    .map((loop) => ({ outline: loop.points, area: loop.area, holes: [], box: boxOf(loop.points) }));
  for (const hole of loops.filter((loop) => loop.area < 0)) {
    const x = hole.points[0];
    const y = hole.points[1];
    let owner = null;
    for (const shape of shapes) {
      const b = shape.box;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if ((!owner || shape.area < owner.area) && inside(x, y, shape.outline)) owner = shape;
    }
    owner?.holes.push(hole.points);
  }
  return shapes.map(({ outline, holes }) => ({ outline, holes }));
}

/**
 * A loop with no point straight after an equal one, the last against the
 * first included: the triangulator quietly drops a closing repeat, which
 * would put every later point out by one.
 */
function withoutRepeats(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 2) {
    const n = out.length;
    if (n && out[n - 2] === points[i] && out[n - 1] === points[i + 1]) continue;
    out.push(points[i], points[i + 1]);
  }
  while (out.length > 2 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) {
    out.length -= 2;
  }
  return out;
}

function boxOf(points) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 2) {
    box[0] = Math.min(box[0], points[i]);
    box[1] = Math.min(box[1], points[i + 1]);
    box[2] = Math.max(box[2], points[i]);
    box[3] = Math.max(box[3], points[i + 1]);
  }
  return box;
}

/**
 * The slab for some shapes, as arrays for a BufferGeometry: position, normal,
 * uv and index, the faces' triangles first and the walls' after them, from
 * `faceCount` on. The picture is one unit tall and `aspect` wide, centred on
 * the origin like the flat card, and the slab runs from z −0.5 to 0.5.
 */
export function slabArrays(shapes, width, height, aspect) {
  const position = [];
  const normal = [];
  const uv = [];
  const faces = [];
  const walls = [];
  // Pixels to model units; the same scale both ways, so normals carry over.
  const toX = (x) => (x / width - 0.5) * aspect;
  const toY = (y) => y / height - 0.5;
  // `inset` moves only where the picture is read from, back along the normal.
  const vertex = (x, y, z, nx, ny, nz, inset = 0) => {
    position.push(toX(x), toY(y), z);
    normal.push(nx, ny, nz);
    uv.push(clamp01((x - nx * inset) / width), clamp01((y - ny * inset) / height));
    return position.length / 3 - 1;
  };

  for (const { outline, holes } of shapes) {
    // Front and back faces: the outline filled in, holes left open.
    const ring = (points) => {
      const out = [];
      for (let i = 0; i < points.length; i += 2) out.push(new Vector2(points[i], points[i + 1]));
      return out;
    };
    const flat = [outline, ...holes].flat();
    const triangles = ShapeUtils.triangulateShape(ring(outline), holes.map(ring));
    const front = [];
    const back = [];
    for (let i = 0; i < flat.length; i += 2) {
      front.push(vertex(flat[i], flat[i + 1], 0.5, 0, 0, 1));
      back.push(vertex(flat[i], flat[i + 1], -0.5, 0, 0, -1));
    }
    for (let [a, b, c] of triangles) {
      // Anticlockwise seen from the front, whichever way they came.
      const turn = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1])
        - (flat[c * 2] - flat[a * 2]) * (flat[b * 2 + 1] - flat[a * 2 + 1]);
      if (turn < 0) [b, c] = [c, b];
      faces.push(front[a], front[b], front[c], back[a], back[c], back[b]);
    }

    for (const loop of [outline, ...holes]) wall(loop);
  }

  /** The wall round one loop, shaded as wallNormals says. */
  function wall(points) {
    const n = points.length / 2;
    const { into, out } = wallNormals(points);
    for (let k = 0; k < n; k++) {
      const q = (k + 1) % n;
      const [ax, ay] = [out[k * 2], out[k * 2 + 1]];
      const [bx, by] = [into[q * 2], into[q * 2 + 1]];
      const aTop = vertex(points[k * 2], points[k * 2 + 1], 0.5, ax, ay, 0, WALL_INSET_PX);
      const aBottom = vertex(points[k * 2], points[k * 2 + 1], -0.5, ax, ay, 0, WALL_INSET_PX);
      const bBottom = vertex(points[q * 2], points[q * 2 + 1], -0.5, bx, by, 0, WALL_INSET_PX);
      const bTop = vertex(points[q * 2], points[q * 2 + 1], 0.5, bx, by, 0, WALL_INSET_PX);
      walls.push(aTop, aBottom, bBottom, aTop, bBottom, bTop);
    }
  }

  return {
    position: new Float32Array(position),
    normal: new Float32Array(normal),
    uv: new Float32Array(uv),
    index: Uint32Array.from([...faces, ...walls]),
    faceCount: faces.length,
  };
}

/**
 * Which way the wall faces at each point of a loop: away from the solid side,
 * which is the right of the direction of travel.
 *
 * The direction is taken over NORMAL_SPAN_PX of outline each way rather than
 * from the segments touching the point. What is left of the pixel steps is
 * too small to see in the outline, but it tilts each little segment a few
 * degrees this way and that, and lit from the side, every tilt is a line
 * across the wall. Where the outline bends gently the shading then runs
 * smoothly round the bend, so a curve looks curved; where it turns by more
 * than CREASE_DEG the corner stays crisp, each side keeping its own.
 *
 * Returns `into` and `out`, [x0, y0, x1, y1, …]: at each point, the normal for
 * the segment arriving there and for the one leaving, the same unless the
 * point is a corner.
 */
export function wallNormals(points) {
  const n = points.length / 2;
  const arc = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    const q = (k + 1) % n;
    arc[k + 1] = arc[k] + Math.hypot(points[q * 2] - points[k * 2], points[q * 2 + 1] - points[k * 2 + 1]);
  }
  const total = arc[n] || 1;
  const span = Math.min(NORMAL_SPAN_PX, total / 8);
  // The point `length` along the loop from its first point, either way round.
  const pointAt = (length) => {
    const along = ((length % total) + total) % total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arc[mid] <= along) lo = mid; else hi = mid - 1;
    }
    const q = (lo + 1) % n;
    const t = arc[lo + 1] > arc[lo] ? (along - arc[lo]) / (arc[lo + 1] - arc[lo]) : 0;
    return [points[lo * 2] + (points[q * 2] - points[lo * 2]) * t,
      points[lo * 2 + 1] + (points[q * 2 + 1] - points[lo * 2 + 1]) * t];
  };
  const facing = (ax, ay, bx, by) => {
    const length = Math.hypot(bx - ax, by - ay) || 1;
    return [(by - ay) / length, -(bx - ax) / length];
  };
  const smoothCos = Math.cos((CREASE_DEG * Math.PI) / 180);
  const into = new Float64Array(n * 2);
  const out = new Float64Array(n * 2);
  for (let k = 0; k < n; k++) {
    const x = points[k * 2];
    const y = points[k * 2 + 1];
    const [ax, ay] = pointAt(arc[k] - span);
    const [bx, by] = pointAt(arc[k] + span);
    const before = facing(ax, ay, x, y);
    const after = facing(x, y, bx, by);
    const corner = before[0] * after[0] + before[1] * after[1] < smoothCos;
    const both = corner ? null : facing(ax, ay, bx, by);
    into.set(both ?? before, k * 2);
    out.set(both ?? after, k * 2);
  }
  return { into, out };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * The picture's colours for the slab: solid pixels as they are, made fully
 * opaque, and every empty pixel given the colour of the nearest solid one.
 * The faces' edges and the wall sample the picture right at the outline, so
 * the colours just outside it have to be the object's own.
 */
export function solidPixels(rgba, mask, width, height) {
  const out = new Uint8ClampedArray(rgba);
  const queue = new Int32Array(width * height);
  const filled = new Uint8Array(width * height);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < mask.length; i++) {
    out[i * 4 + 3] = 255;
    if (mask[i]) { filled[i] = 1; queue[tail++] = i; }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const take = (j) => {
      if (filled[j]) return;
      filled[j] = 1;
      out[j * 4] = out[i * 4];
      out[j * 4 + 1] = out[i * 4 + 1];
      out[j * 4 + 2] = out[i * 4 + 2];
      queue[tail++] = j;
    };
    if (x > 0) take(i - 1);
    if (x < width - 1) take(i + 1);
    if (i >= width) take(i - width);
    if (i < mask.length - width) take(i + width);
  }
  return out;
}

/** Largest side of the walls' picture: they only need its colours in broad strokes. */
const WALL_MAX_SIDE = 512;
/** How far the walls' colours are spread along the edge, in pixels of the picture. */
const WALL_BLUR_PX = 5;

/**
 * The walls' picture: `rgba` (solidPixels' output) shrunk to at most
 * WALL_MAX_SIDE and blurred, so the colour along a wall changes smoothly.
 * Returns { data, width, height }.
 */
export function wallPixels(rgba, width, height) {
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / WALL_MAX_SIDE));
  const w = Math.ceil(width / factor);
  const h = Math.ceil(height / factor);
  // Shrink by averaging each factor × factor block.
  let data = new Float32Array(w * h * 4);
  const counts = new Float32Array(w * h);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / factor) * w;
    for (let x = 0; x < width; x++) {
      const to = row + Math.floor(x / factor);
      const from = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) data[to * 4 + c] += rgba[from + c];
      counts[to]++;
    }
  }
  for (let i = 0; i < counts.length; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] /= counts[i];

  // Two box blurs each way come close to a Gaussian.
  const radius = Math.max(1, Math.round(WALL_BLUR_PX / factor));
  for (let pass = 0; pass < 2; pass++) {
    data = boxBlur(data, w, h, radius, true);
    data = boxBlur(data, w, h, radius, false);
  }
  return { data: Uint8ClampedArray.from(data), width: w, height: h };
}

/** One box blur along every row, or every column, clamped at the edges. */
function boxBlur(source, w, h, radius, rows) {
  const out = new Float32Array(source.length);
  const lines = rows ? h : w;
  const length = rows ? w : h;
  const step = rows ? 1 : w;
  const span = radius * 2 + 1;
  for (let line = 0; line < lines; line++) {
    const base = rows ? line * w : line;
    const at = (k) => (base + Math.min(length - 1, Math.max(0, k)) * step) * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += source[at(k) + c];
      for (let k = 0; k < length; k++) {
        out[(base + k * step) * 4 + c] = sum / span;
        sum += source[at(k + radius + 1) + c] - source[at(k - radius) + c];
      }
    }
  }
  return out;
}
