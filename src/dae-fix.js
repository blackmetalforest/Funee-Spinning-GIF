/**
 * Two repairs to what three.js's ColladaLoader builds, kept apart from the
 * loaders so the parts that read the file can be tested without a browser.
 *
 * Both are cases where the .dae says something plainly and the loader does
 * not act on it, which is why the same model could load perfectly from its
 * .obj and come out wrong from its .dae.
 */

/**
 * COLLADA's sampler wrap modes, as three.js wrapping constants.
 *
 * The values are the three.js numbers themselves (RepeatWrapping,
 * ClampToEdgeWrapping, MirroredRepeatWrapping) so this file has no import to
 * satisfy when it runs under Node. BORDER has no three.js equivalent; clamping
 * is the nearest, and what a border colour of "none given" looks like anyway.
 */
const WRAP = { repeat: 1000, clamp: 1001, mirror: 1002 };
const WRAP_BY_NAME = {
  WRAP: WRAP.repeat,
  MIRROR: WRAP.mirror,
  MIRROR_ONCE: WRAP.mirror,
  CLAMP: WRAP.clamp,
  BORDER: WRAP.clamp,
  NONE: WRAP.clamp,
};

export function wrapModeFor(name) {
  return WRAP_BY_NAME[String(name ?? '').trim().toUpperCase()] ?? null;
}

/**
 * Every sampler's declared wrap modes, keyed by "<effect id>|<sampler sid>".
 *
 * ColladaLoader reads a sampler's `<source>` and nothing else, so a file that
 * asks for mirrored or clamped wrapping gets repeat regardless. The Toad
 * model's spots are the case in point: a quarter-circle texture meant to be
 * mirrored into a whole one, repeated instead into a grid of quarters.
 *
 * Read with patterns rather than a DOM so it runs under Node for the tests;
 * the structure it looks for is fixed by the schema and shallow.
 */
export function samplerWraps(text) {
  const wraps = new Map();
  const effects = String(text).matchAll(/<effect\b[^>]*\bid\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/effect>/g);
  for (const [, effectId, effectBody] of effects) {
    const params = effectBody.matchAll(/<newparam\b[^>]*\bsid\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/newparam>/g);
    for (const [, sid, body] of params) {
      if (!/<sampler2D\b/.test(body)) continue;
      const s = wrapModeFor(body.match(/<wrap_s>\s*([^<]*?)\s*<\/wrap_s>/)?.[1]);
      const t = wrapModeFor(body.match(/<wrap_t>\s*([^<]*?)\s*<\/wrap_t>/)?.[1]);
      if (s === null && t === null) continue;
      wraps.set(`${effectId}|${sid}`, { s, t });
    }
  }
  return wraps;
}

/** Which material slot each COLLADA shading parameter's texture lands in. */
const SLOT_BY_PARAMETER = {
  diffuse: 'map',
  specular: 'specularMap',
  bump: 'normalMap',
  ambient: 'lightMap',
  emission: 'emissiveMap',
};

/**
 * Give each texture the wrapping its sampler declared.
 *
 * Only where the loader had nothing to go on. A texture carrying a MAYA
 * `<extra>` technique was already given that technique's wrap by the loader,
 * and the two can disagree, so those are left alone — this only replaces the
 * blanket "repeat" the loader falls back to.
 *
 * `result` is what ColladaLoader.parse() returns; its `library` holds each
 * material's effect and, once built, the three.js material itself.
 */
export function applySamplerWraps(result, text) {
  const library = result?.library;
  if (!library?.materials || !library?.effects) return 0;
  const wraps = samplerWraps(text);
  if (!wraps.size) return 0;

  let changed = 0;
  for (const entry of Object.values(library.materials)) {
    const material = entry?.build;
    const effectId = entry?.url;
    const parameters = library.effects[effectId]?.profile?.technique?.parameters;
    if (!material || !parameters) continue;

    for (const [parameter, slot] of Object.entries(SLOT_BY_PARAMETER)) {
      const reference = parameters[parameter]?.texture;
      const texture = material[slot];
      if (!reference || !texture?.isTexture) continue;
      const technique = reference.extra?.technique;
      if (technique && Object.keys(technique).length) continue;

      const wrap = wraps.get(`${effectId}|${reference.id}`);
      if (!wrap) continue;
      if (wrap.s !== null) texture.wrapS = wrap.s;
      if (wrap.t !== null) texture.wrapT = wrap.t;
      if (texture.image) texture.needsUpdate = true;
      changed++;
    }
  }
  return changed;
}

/**
 * Use the second texture-coordinate set when it is the only one.
 *
 * COLLADA numbers coordinate sets, and 3ds Max's ColladaMax exporter writes
 * its map channel 1 as `set="1"`. ColladaLoader files set 1 under `uv1`, but
 * every three.js map samples `uv` unless told otherwise — so a mesh whose only
 * coordinates are set 1 draws each texture from coordinates that do not
 * exist, and comes out as a smear of one texel. Shadow and Midna both arrive
 * this way; their .obj exports carry the same coordinates as plain `vt` and
 * work, which is exactly the "the OBJ loads but the DAE doesn't" symptom.
 *
 * Aliasing rather than retargeting every texture's channel keeps it to one
 * rule that covers every map, including ones swapped in later.
 */
export function promoteOnlyUvSet(object) {
  let promoted = 0;
  object.traverse((child) => {
    const attributes = child.isMesh && child.geometry?.attributes;
    if (!attributes || attributes.uv || !attributes.uv1) return;
    if (!(attributes.uv1.itemSize >= 2)) return;
    child.geometry.setAttribute('uv', attributes.uv1);
    promoted++;
  });
  return promoted;
}
