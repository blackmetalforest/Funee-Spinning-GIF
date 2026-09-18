/**
 * One repair to Wavefront .mtl text, kept apart from the loaders so it can be
 * tested without a browser.
 */

/**
 * Drop `Tr` lines that contradict the `d` line in the same material.
 *
 * `d` is dissolve, where 1 is opaque; `Tr` is transparency, where 1 is
 * invisible. They are meant to be complements. The 3ds Max Wavefront exporter
 * that produced most ripped game models writes *both*, with `Tr` carrying the
 * same meaning as `d`:
 *
 *     d  1.0000
 *     Tr 1.0000
 *
 * Read to the letter that says "completely opaque, and also completely
 * invisible", and since `Tr` comes second it wins — which is why these models
 * loaded, reported their meshes, and then could not be found anywhere in the
 * scene.
 *
 * Only a genuine contradiction is dropped, never a consistent pair, so a file
 * that correctly writes `Tr 0` alongside `d 1` is left exactly as it is.
 * MTLLoader's own `invertTrProperty` option cannot make that distinction: it
 * would turn every correct `Tr 0` into an invisible material instead.
 */
export function sanitiseMtl(text) {
  const lines = String(text).split(/\r?\n/);
  const drop = new Set();
  let dissolve = null;
  let trLine = -1;
  let transparency = null;

  const settle = () => {
    if (dissolve !== null && transparency !== null
        && Math.abs(dissolve + transparency - 1) > 1e-3) {
      drop.add(trLine);
    }
    dissolve = transparency = null;
    trLine = -1;
  };

  lines.forEach((line, i) => {
    if (/^\s*newmtl\b/i.test(line)) { settle(); return; }
    const match = /^\s*(d|tr)\s+(\S+)/i.exec(line);
    if (!match) return;
    const value = parseFloat(match[2]);
    if (!Number.isFinite(value)) return;
    if (match[1].toLowerCase() === 'd') dissolve = value;
    else { transparency = value; trLine = i; }
  });
  settle();

  return drop.size ? lines.filter((_, i) => !drop.has(i)).join('\n') : text;
}
