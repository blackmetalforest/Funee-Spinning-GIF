/**
 * Materials: which ones a model is drawn with, which of their layers are
 * switched on, and the single-channel views used to debug them.
 *
 * Everything here is three.js's own material system. The two rendering paths
 * are the library's two lighting models, the layer switches set and clear the
 * library's own map slots, and every debug view is a stock material — the only
 * shader text anywhere is a one-line channel pick for the packed data maps,
 * which no stock material can display on its own.
 *
 * The two paths:
 *
 *  - **Classic** restates every material as MeshPhongMaterial carrying its
 *    colour and colour map and nothing else. This is exactly what the app has
 *    always done, kept bit-for-bit, because the whole library of ripped game
 *    models was tuned against it.
 *  - **Physical** keeps a physically based material as the file described
 *    it — normal, metal/roughness, emission, occlusion, clearcoat and the rest
 *    all intact — and upgrades an older Phong or Lambert material into
 *    MeshStandardMaterial so it can join in.
 *
 * "Auto" chooses per model: Physical when the file ships physically based
 * materials (glTF, USDZ, most modern FBX) or a zip turned out to hold a full
 * texture set for it, Classic when neither (OBJ, Collada, older FBX). A model that rendered correctly before therefore still
 * renders the same, and the models that rendered black or dim now do not.
 */

import * as THREE from '../vendor/three/three.module.js';

export const SHADINGS = ['auto', 'physical', 'classic'];

/**
 * The layers a user can switch off, in the order the panel lists them.
 *
 * `has` answers "does this material use the layer at all", which is what lets
 * the panel grey out a switch that would change nothing. It is asked of the
 * material's *full* state, so a layer switched off still counts as present.
 */
export const LAYERS = [
  { key: 'map', label: 'Base colour map', has: (m) => !!m.map },
  { key: 'vertexColors', label: 'Vertex colours', has: (m) => !!m.vertexColors },
  { key: 'normal', label: 'Normal & bump maps', has: (m) => !!(m.normalMap || m.bumpMap) },
  { key: 'metalRough', label: 'Metalness & roughness maps',
    has: (m) => !!(m.metalnessMap || m.roughnessMap) },
  { key: 'emission', label: 'Emission',
    has: (m) => !!m.emissiveMap
      || (!!m.emissive && m.emissiveIntensity > 0 && Math.max(m.emissive.r, m.emissive.g, m.emissive.b) > 0) },
  { key: 'ao', label: 'Ambient occlusion', has: (m) => !!m.aoMap },
  { key: 'lightMap', label: 'Light map', has: (m) => !!m.lightMap },
  { key: 'alpha', label: 'Transparency',
    has: (m) => !!(m.transparent || m.alphaMap || m.alphaTest > 0 || m.opacity < 1) },
  { key: 'physical', label: 'Clearcoat, sheen & transmission',
    has: (m) => (m.clearcoat ?? 0) > 0 || (m.sheen ?? 0) > 0
      || (m.transmission ?? 0) > 0 || (m.iridescence ?? 0) > 0 },
];

export const ALL_LAYERS_ON = Object.fromEntries(LAYERS.map((l) => [l.key, true]));

/** The debug views, in panel order. `final` is the ordinary lit render. */
export const VIEWS = ['final', 'albedo', 'normals', 'metalness', 'roughness',
  'ao', 'emission', 'opacity', 'wireframe'];

/** Every texture slot any stock material has, for disposal and filtering. */
export const TEXTURE_SLOTS = ['map', 'normalMap', 'bumpMap', 'roughnessMap',
  'metalnessMap', 'emissiveMap', 'aoMap', 'lightMap', 'alphaMap', 'specularMap',
  'displacementMap', 'envMap', 'clearcoatMap', 'clearcoatNormalMap',
  'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap',
  'specularIntensityMap', 'specularColorMap', 'anisotropyMap', 'matcap', 'gradientMap'];

export function isPhysical(material) {
  return !!(material?.isMeshStandardMaterial);
}

/** Whether a material was written for physically based shading. */
export function wantsPhysical(material) {
  return isPhysical(material) || !!material?.userData?.textureSet;
}

/* ------------------------------------------------------------- building */

/**
 * The Classic material: colour and colour map, restated as Phong.
 * Unchanged from the renderer this replaces — see the file header.
 */
export function toClassic(source, mesh, settings) {
  return new THREE.MeshPhongMaterial({
    name: source?.name ?? '',
    color: source?.color?.clone?.() ?? new THREE.Color(0xffffff),
    map: source?.map ?? null,
    vertexColors: !!mesh.geometry?.attributes?.color,
    transparent: !!source?.transparent,
    opacity: source?.opacity ?? 1,
    alphaTest: source?.alphaTest ?? 0,
    side: THREE.FrontSide,
    shininess: settings.shininess,
    specular: new THREE.Color().setScalar(settings.specular),
  });
}

/**
 * Blinn-Phong's exponent restated as GGX roughness — the usual
 * correspondence, where the two highlights have the same width.
 */
export function shininessToRoughness(shininess) {
  return Math.min(1, Math.max(0.04, Math.sqrt(2 / (Math.max(0, shininess) + 2))));
}

/**
 * The Physical material for one source.
 *
 * A physically based source is used as it is: it already says everything the
 * renderer needs, and copying it would only risk dropping a property. An
 * unlit source stays unlit, because that was the file's instruction. Anything
 * else — Phong, Lambert, Toon — is upgraded into MeshStandardMaterial with
 * every map it carries, as a non-metal of matching glossiness.
 *
 * One map is deliberately not carried over: a Phong `alphaMap`. MTLLoader
 * fills it from `map_d`, which in ripped models almost always names the colour
 * texture itself, and three.js reads an alpha map's *green* channel — so it
 * would cut holes wherever the texture happens not to be green. The colour
 * map's own alpha already carries the real transparency.
 */
export function toPhysical(source, mesh) {
  if (isPhysical(source) || source?.isMeshBasicMaterial) return source;
  const material = new THREE.MeshStandardMaterial({
    name: source?.name ?? '',
    color: source?.color?.clone?.() ?? new THREE.Color(0xffffff),
    map: source?.map ?? null,
    vertexColors: !!mesh.geometry?.attributes?.color,
    transparent: !!source?.transparent,
    opacity: source?.opacity ?? 1,
    alphaTest: source?.alphaTest ?? 0,
    normalMap: source?.normalMap ?? null,
    normalMapType: source?.normalMapType ?? THREE.TangentSpaceNormalMap,
    bumpMap: source?.bumpMap ?? null,
    bumpScale: source?.bumpScale ?? 1,
    emissive: source?.emissive?.clone?.() ?? new THREE.Color(0x000000),
    emissiveMap: source?.emissiveMap ?? null,
    emissiveIntensity: source?.emissiveIntensity ?? 1,
    aoMap: source?.aoMap ?? null,
    aoMapIntensity: source?.aoMapIntensity ?? 1,
    lightMap: source?.lightMap ?? null,
    lightMapIntensity: source?.lightMapIntensity ?? 1,
    // Not Phong properties, but the archive loader hangs a found texture
    // set's data maps here for exactly this upgrade to pick up.
    roughnessMap: source?.roughnessMap ?? null,
    metalnessMap: source?.metalnessMap ?? null,
    flatShading: !!source?.flatShading,
    metalness: source?.metalnessMap ? 1 : 0,
    roughness: source?.roughnessMap ? 1
      : source?.shininess !== undefined ? shininessToRoughness(source.shininess) : 1,
  });
  if (source?.normalScale) material.normalScale.copy(source.normalScale);
  return material;
}

/* --------------------------------------------------------------- layers */

/** Record everything the layer switches may change, once, before any do. */
function snapshot(material) {
  if (material.userData.full) return material.userData.full;
  const full = {};
  for (const slot of TEXTURE_SLOTS) if (slot in material) full[slot] = material[slot] ?? null;
  for (const key of ['vertexColors', 'transparent', 'opacity', 'alphaTest',
    'emissiveIntensity', 'bumpScale', 'clearcoat', 'sheen', 'transmission',
    'iridescence']) {
    if (material[key] !== undefined) full[key] = material[key];
  }
  if (material.emissive) full.emissive = material.emissive.clone();
  if (material.normalScale) full.normalScale = material.normalScale.clone();
  material.userData.full = full;
  return full;
}

/** Which layers a material uses, judged on its full, unswitched state. */
export function layersOf(material) {
  const full = snapshot(material);
  return LAYERS.filter((layer) => layer.has(full)).map((layer) => layer.key);
}

/**
 * Put a material's layers into the state the switches ask for.
 *
 * Always written from the snapshot, never from the material's current values,
 * so switching a layer off and on again is exact — the strengths below
 * multiply the original, not whatever the last call left behind.
 *
 * `needsUpdate` is raised only when a map or flag actually appears or
 * disappears: those change the compiled shader, while a strength is just a
 * uniform. That keeps a slider drag from recompiling every material per step.
 */
export function applyLayers(material, layers, { normalStrength = 1, emissionStrength = 1 } = {}) {
  const full = snapshot(material);
  const on = (key) => layers?.[key] !== false;
  const before = shaderShape(material);

  const set = (slot, keep) => {
    if (slot in full) material[slot] = keep ? full[slot] : null;
  };
  set('map', on('map'));
  set('normalMap', on('normal'));
  set('bumpMap', on('normal'));
  set('metalnessMap', on('metalRough'));
  set('roughnessMap', on('metalRough'));
  set('emissiveMap', on('emission'));
  set('aoMap', on('ao'));
  set('lightMap', on('lightMap'));
  set('alphaMap', on('alpha'));

  if ('vertexColors' in full) material.vertexColors = on('vertexColors') && full.vertexColors;

  if (on('alpha')) {
    for (const key of ['transparent', 'opacity', 'alphaTest']) {
      if (key in full) material[key] = full[key];
    }
  } else {
    material.transparent = false;
    material.opacity = 1;
    material.alphaTest = 0;
  }

  if ('emissiveIntensity' in full) {
    material.emissiveIntensity = on('emission') ? full.emissiveIntensity * emissionStrength : 0;
  }
  if (full.normalScale) material.normalScale.copy(full.normalScale).multiplyScalar(normalStrength);
  if ('bumpScale' in full) material.bumpScale = full.bumpScale * normalStrength;

  // The physical extras toggle their own shader features through three.js's
  // setters, which bump the material version as a value crosses zero.
  for (const key of ['clearcoat', 'sheen', 'transmission', 'iridescence']) {
    if (key in full) material[key] = on('physical') ? full[key] : 0;
  }

  if (shaderShape(material) !== before) material.needsUpdate = true;
}

/** The parts of a material's state that decide which shader it compiles to. */
function shaderShape(material) {
  let shape = '';
  for (const slot of TEXTURE_SLOTS) shape += material[slot] ? '1' : '0';
  return `${shape}|${material.vertexColors}|${material.transparent}|${material.alphaTest > 0}`;
}

/* ---------------------------------------------------------- debug views */

const WIRE_COLOUR = new THREE.Color('#3d9be9');   // reads on light and dark grounds alike

/**
 * The stand-in material that shows one channel of `material`.
 *
 * Most views are a stock material handed the right map: the base colour is
 * MeshBasicMaterial with the colour map, emission is the same with the
 * emissive map, normals are MeshNormalMaterial with the normal map. The three
 * *data* views — metalness, roughness, occlusion — are the exception, because
 * glTF packs them into the channels of one texture (roughness in green,
 * metalness in blue, occlusion in red) and no stock material can show a single
 * channel. For those the colour map's sample is swizzled, one line of GLSL.
 *
 * Data views show the stored number as a grey level directly: a roughness of
 * 0.5 is drawn as 50% grey, not as the brighter grey an sRGB output would
 * otherwise turn it into. None of them are tone mapped.
 */
export function debugMaterial(material, view) {
  const side = material.side;
  const common = { side, toneMapped: false };

  switch (view) {
    case 'albedo':
      return new THREE.MeshBasicMaterial({
        ...common,
        color: material.color?.clone?.() ?? new THREE.Color(0xffffff),
        map: material.map ?? null,
        vertexColors: !!material.vertexColors,
        alphaMap: material.alphaMap ?? null,
        transparent: !!material.transparent,
        opacity: material.opacity ?? 1,
        alphaTest: material.alphaTest ?? 0,
      });

    case 'normals': {
      const normals = new THREE.MeshNormalMaterial({
        side,
        normalMap: material.normalMap ?? null,
        normalMapType: material.normalMapType ?? THREE.TangentSpaceNormalMap,
        bumpMap: material.bumpMap ?? null,
        bumpScale: material.bumpScale ?? 1,
        flatShading: !!material.flatShading,
      });
      if (material.normalScale) normals.normalScale.copy(material.normalScale);
      return normals;
    }

    case 'emission': {
      const colour = material.emissive?.clone?.() ?? new THREE.Color(0x000000);
      colour.multiplyScalar(material.emissiveIntensity ?? 1);
      return new THREE.MeshBasicMaterial({
        ...common, color: colour, map: material.emissiveMap ?? null,
      });
    }

    case 'metalness':
      return channelView(common, material.metalness ?? 0, material.metalnessMap, 'b');
    case 'roughness':
      return channelView(common, material.roughness ?? 1, material.roughnessMap, 'g');
    case 'ao':
      return channelView(common, 1, material.aoMap, 'r', material.aoMapIntensity ?? 1);

    case 'opacity': {
      const opacity = new THREE.MeshBasicMaterial({
        ...common,
        map: material.map ?? null,
        alphaMap: material.alphaMap ?? null,
        opacity: material.opacity ?? 1,
      });
      // The stock shader works the alpha out exactly as the lit one does; this
      // just paints it instead of using it.
      opacity.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <alphamap_fragment>',
          `#include <alphamap_fragment>
          diffuseColor = vec4( sRGBTransferEOTF( vec4( vec3( diffuseColor.a ), 1.0 ) ).rgb, 1.0 );`);
      };
      opacity.customProgramCacheKey = () => 'debug-opacity';
      return opacity;
    }

    case 'wireframe':
      return new THREE.MeshBasicMaterial({ ...common, color: WIRE_COLOUR, wireframe: true });

    default:
      return material;
  }
}

/**
 * One channel of a packed data texture, as grey. With no texture the factor
 * alone is shown, which is what the lit shader would use too.
 *
 * `intensity` covers occlusion's strength control, which mixes the sampled
 * value back toward 1 exactly as the lit shader does.
 */
function channelView(common, factor, texture, channel, intensity = 1) {
  const material = new THREE.MeshBasicMaterial({
    ...common,
    color: new THREE.Color().setScalar(1),
    map: texture ?? null,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFactor = { value: factor };
    shader.uniforms.uIntensity = { value: intensity };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uFactor;\nuniform float uIntensity;\nvoid main() {')
      .replace('#include <map_fragment>', `
        float value = uFactor;
        #ifdef USE_MAP
          value *= mix( 1.0, texture2D( map, vMapUv ).${channel}, uIntensity );
        #endif
        diffuseColor.rgb = sRGBTransferEOTF( vec4( vec3( value ), 1.0 ) ).rgb;`);
  };
  material.customProgramCacheKey = () => `debug-channel-${channel}`;
  return material;
}

/* ------------------------------------------------------------ filtering */

/**
 * How textures are sampled.
 *
 *  - `smooth` is whatever the loader chose — the app's long-standing look.
 *  - `sharp` adds anisotropic filtering, which keeps a texture crisp on a
 *    surface seen at a glancing angle instead of letting it smear.
 *  - `pixel` samples the nearest texel: the look of the console many of these
 *    rips came from, where an 8×8 texture is meant to be eight clear blocks.
 *
 * The loader's own choice is remembered on the texture, so returning to
 * `smooth` is exact.
 */
export function applyFiltering(texture, mode, maxAnisotropy) {
  if (!texture?.isTexture) return;
  const saved = texture.userData.filtering ??= {
    magFilter: texture.magFilter, minFilter: texture.minFilter, anisotropy: texture.anisotropy,
  };
  let { magFilter, minFilter, anisotropy } = saved;
  if (mode === 'sharp') {
    anisotropy = Math.max(anisotropy, maxAnisotropy);
  } else if (mode === 'pixel') {
    magFilter = THREE.NearestFilter;
    minFilter = THREE.NearestMipmapNearestFilter;
  }
  if (texture.magFilter === magFilter && texture.minFilter === minFilter
    && texture.anisotropy === anisotropy) return;
  texture.magFilter = magFilter;
  texture.minFilter = minFilter;
  texture.anisotropy = anisotropy;
  // Sampler state is applied on upload. A texture still loading will be
  // uploaded with these values anyway, and flagging it now would only warn.
  if (texture.image) texture.needsUpdate = true;
}
