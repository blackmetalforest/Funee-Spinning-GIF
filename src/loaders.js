/**
 * Format dispatch — mirrors spin3d/loader.py.
 *
 * three.js supplies the parsers, so this file is mostly routing: pick a loader
 * by extension, parse from an ArrayBuffer, and normalise whatever comes back
 * into a single Object3D. Loaders return wildly different shapes — a Group, a
 * BufferGeometry, a {scene} wrapper — so normalise() is doing real work.
 *
 * Crease-angle smoothing is applied only to geometry that arrives without
 * normals (STL, some OBJ/PLY). Files that ship their own normals keep them.
 *
 * A .zip takes a second route through the same dispatch: src/archive.js
 * flattens it, the most promising model in it is chosen, and every external
 * reference that model makes is answered from the archive rather than from the
 * network. See loadArchive() at the foot of the file.
 */

import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from '../vendor/three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from '../vendor/three/addons/loaders/OBJLoader.js';
import { MTLLoader } from '../vendor/three/addons/loaders/MTLLoader.js';
import { STLLoader } from '../vendor/three/addons/loaders/STLLoader.js';
import { PLYLoader } from '../vendor/three/addons/loaders/PLYLoader.js';
import { ColladaLoader } from '../vendor/three/addons/loaders/ColladaLoader.js';
import { ThreeMFLoader } from '../vendor/three/addons/loaders/3MFLoader.js';
import { FBXLoader } from '../vendor/three/addons/loaders/FBXLoader.js';
import { USDZLoader } from '../vendor/three/addons/loaders/USDZLoader.js';
import { VOXLoader, VOXMesh } from '../vendor/three/addons/loaders/VOXLoader.js';
import { TDSLoader } from '../vendor/three/addons/loaders/TDSLoader.js';
import { TGALoader } from '../vendor/three/addons/loaders/TGALoader.js';
import { toCreasedNormals } from '../vendor/three/addons/utils/BufferGeometryUtils.js';
import {
  openArchive, baseName, dirName, extOf, stemOf, normKey, channelOf, nameAffinity,
} from './archive.js';
import { sanitiseMtl } from './mtl-fix.js';

export const SUPPORTED_EXTENSIONS = [
  'glb', 'gltf', 'obj', 'stl', 'ply', 'dae', '3mf', 'fbx', 'usdz', 'vox', '3ds',
];

/** Archives are offered alongside the model formats themselves. */
export const ARCHIVE_EXTENSIONS = ['zip'];

export const FILE_ACCEPT = [...SUPPORTED_EXTENSIONS, ...ARCHIVE_EXTENSIONS]
  .map((e) => `.${e}`).join(',');

/** Formats that carry textures inside a single file — the friction-free ones. */
export const SELF_CONTAINED = new Set(['glb', 'usdz', 'fbx', 'vox', '3mf']);

export function extensionOf(name) {
  return (name.split('.').pop() || '').toLowerCase();
}

/**
 * Stand-in for a texture the archive does not contain.
 *
 * A 1x1 opaque white pixel, because a colour map is multiplied into the
 * material colour: white leaves the model looking exactly as it would have
 * with no map at all. Letting the request 404 instead would leave three.js
 * holding a texture with no image, which renders black.
 */
const MISSING_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=';

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', tga: 'image/x-tga',
};

/**
 * Wrap whatever a loader returns into an Object3D.
 * Bare BufferGeometry (STL, PLY) gets a default material; it is replaced by
 * the scene's Phong override immediately afterwards.
 */
function normalise(result, creaseAngle) {
  let object;
  if (!result) throw new Error('Loader returned nothing');

  if (result.isBufferGeometry) {
    let geometry = result;
    if (!geometry.attributes.normal && creaseAngle > 0) {
      geometry = toCreasedNormals(geometry, THREE.MathUtils.degToRad(creaseAngle));
    } else if (!geometry.attributes.normal) {
      geometry.computeVertexNormals();
    }
    object = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({ color: 0xcccccc }));
  } else if (result.isObject3D) {
    object = result;
  } else if (result.scene?.isObject3D) {
    object = result.scene;              // glTF, Collada
  } else {
    throw new Error('Unsupported loader result');
  }

  // Anything still missing normals gets them, or lighting collapses to black.
  object.traverse((child) => {
    if (child.isMesh && child.geometry && !child.geometry.attributes.normal) {
      child.geometry.computeVertexNormals();
    }
  });
  return object;
}

/** True if the object contains at least one drawable mesh. */
function hasMesh(object) {
  let found = false;
  object.traverse((c) => { if (c.isMesh && c.geometry) found = true; });
  return found;
}

/** Every material on a mesh, whether it holds one or an array. */
function materialsOf(mesh) {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/**
 * Parse one model buffer. `ctx` carries the three.js LoadingManager that
 * answers external references, and the path they resolve against — both are
 * absent for a plain single file, where there is nothing external to find.
 */
async function parseModel(ext, buffer, ctx) {
  const { manager, path = '', creaseAngle = 40, materials = null } = ctx ?? {};

  switch (ext) {
    case 'glb':
    case 'gltf': {
      const loader = new GLTFLoader(manager);
      /*
       * Deliberately *not* given our manager.
       *
       * DRACOLoader fetches its decoder through a FileLoader built on the
       * manager it was handed, and FileLoader runs every URL through
       * manager.resolveURL(). Hand it the manager that answers the model's
       * references and the decoder request goes through the same redirect —
       * the archive resolver looks for "draco_wasm_wrapper.js" inside the
       * zip, does not find it, and hands back the missing-texture pixel,
       * which is then parsed as JavaScript. The decoder is part of this app,
       * not part of the file being opened, so it loads on the default
       * manager and reaches the disk untouched.
       */
      const draco = new DRACOLoader();
      // Vendored locally so the app still works offline and on Pages.
      draco.setDecoderPath('./vendor/three/addons/libs/draco/gltf/');
      loader.setDRACOLoader(draco);
      return loader.parseAsync(buffer, path);
    }
    case 'obj': {
      const text = new TextDecoder().decode(buffer);
      const loader = new OBJLoader(manager);
      if (materials) loader.setMaterials(materials);
      return loader.parse(text);
    }
    case 'stl':
      return new STLLoader().parse(buffer);
    case 'ply':
      return new PLYLoader().parse(buffer);
    case 'dae': {
      const text = new TextDecoder().decode(buffer);
      return new ColladaLoader(manager).parse(text, path);
    }
    case '3mf':
      return new ThreeMFLoader(manager).parse(buffer);
    case 'fbx':
      return new FBXLoader(manager).parse(buffer, path);
    case 'usdz':
      return new USDZLoader(manager).parse(buffer);
    case 'vox': {
      const chunks = new VOXLoader().parse(buffer);
      const group = new THREE.Group();
      for (const chunk of chunks) group.add(new VOXMesh(chunk));
      return group;
    }
    case '3ds':
      return new TDSLoader(manager).parse(buffer, path);
    default:
      throw new Error(`Unsupported file type: .${ext}`);
  }
}

/**
 * Answer every reference a lone model makes with a blank pixel.
 *
 * A .gltf, .dae, .fbx or .3ds opened on its own can name any URL it likes
 * for a texture, and three.js will go and fetch it. Whoever wrote that file
 * then learns the address, the user agent and the moment it was opened — a
 * tracking pixel wearing a 3D model. Relative paths are no better: they
 * resolve against whatever is hosting the app and 404 there.
 *
 * Archives have been immune to this from the start, because their resolver
 * answers out of the zip and refuses anything with a scheme. This is the
 * same guarantee for the files that do not come in a zip, and it is what
 * makes "everything runs in your browser" true rather than nearly true.
 */
function localOnlyManager(blocked) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(data|blob):/i.test(url)) return url;
    const name = baseName(url) || url;
    if (!blocked.includes(name)) blocked.push(name);
    return MISSING_PIXEL;
  });
  // A .tga that the file embedded as a data: URI still needs its decoder.
  manager.addHandler(/\.tga(#|$|\?)/i, new TGALoader(manager));
  return manager;
}

/**
 * Load a model from a File/Blob. Returns { object, stats, report }.
 * `creaseAngle` matches the desktop app's --smooth flag.
 */
export async function loadModel(file, { creaseAngle = 40, choice = null } = {}) {
  const ext = extensionOf(file.name);
  if (ext === 'zip') return loadArchive(file, { creaseAngle, choice });

  const buffer = await file.arrayBuffer();
  const blocked = [];
  const manager = localOnlyManager(blocked);
  const result = await parseModel(ext, buffer, { creaseAngle, manager });
  const object = normalise(result, creaseAngle);
  if (!hasMesh(object)) {
    throw new Error('That file contains no meshes to render');
  }
  repairMaterials(object);
  return { object, stats: { ...describe(object, ext), blocked }, report: null };
}

/* ------------------------------------------------------------- archives */

/**
 * Serve a loader's external references out of an archive.
 *
 * Every three.js loader routes the URLs it wants through its LoadingManager,
 * so a single URL modifier is enough to redirect all of them — glTF buffers,
 * MTL maps, FBX textures — at once, with no per-loader special casing.
 */
function makeResolver(index, baseDir, report) {
  const manager = new THREE.LoadingManager();
  const urls = new Map();                 // archive path -> { bare, tagged }
  const paths = new Map();                // tagged URL -> archive path

  manager.setURLModifier((url) => {
    if (/^(blob|data):/i.test(url)) return url;

    const path = index.find(url, baseDir);
    if (!path) {
      const name = baseName(url);
      if (name && !report.missing.includes(name)) report.missing.push(name);
      return MISSING_PIXEL;
    }

    if (!urls.has(path)) {
      const ext = extOf(path);
      const blob = new Blob([index.bytes(path)], {
        type: MIME_BY_EXT[ext] ?? 'application/octet-stream',
      });
      const bare = URL.createObjectURL(blob);
      // The '#.ext' tail is load-bearing. three.js chooses a decoder for
      // formats the browser cannot read itself — TGA here — by matching the
      // URL against a regex, and a blob: URL carries no extension at all. The
      // fragment is dropped when the blob is actually fetched.
      urls.set(path, { bare, tagged: `${bare}#.${ext}` });
      paths.set(urls.get(path).tagged, path);
    }
    report.bound.add(path);
    return urls.get(path).tagged;
  });

  // TGA is common in older OBJ and FBX bundles and no browser decodes it.
  manager.addHandler(/\.tga(#|$|\?)/i, new TGALoader(manager));

  return {
    manager,
    /**
     * Which archive entry a loaded texture came from.
     *
     * ImageLoader assigns the URL it was given straight to `image.src`, so a
     * texture that went through TextureLoader can be traced back to its file —
     * that is what puts "face.png" in the Replace list. GLTFLoader decodes to
     * an ImageBitmap instead, which carries no URL, so glTF returns null and
     * the entry is labelled by material name alone.
     */
    pathFor(texture) {
      const src = texture?.image?.src;
      return src ? paths.get(src) ?? null : null;
    },
    revoke() {
      for (const { bare } of urls.values()) URL.revokeObjectURL(bare);
      urls.clear();
    },
  };
}

/**
 * Walk every material on the model in a fixed order, handing each one a stable
 * key.
 *
 * The list the user picks from and the material written back to both come from
 * here, so the two can never drift apart and drop a replacement on the wrong
 * part of the model. Materials sharing a name collapse onto one key, which is
 * what you want: within a .mtl a name is unique, and where one really is reused
 * both copies are meant.
 */
function eachMaterial(object, visit) {
  let index = 0;
  object.traverse((child) => {
    if (!child.isMesh) return;
    for (const material of materialsOf(child)) {
      if (material) visit(material, material.name || `#${index}`, index);
      index++;
    }
  });
}

/**
 * The .mtl files an OBJ names in its `mtllib` lines.
 *
 * An `mtllib` value is unquoted and runs to the end of the line, which is how
 * "mtllib Patchwork chair.mtl" manages to be one filename with a space in it.
 * Several lines are legal.
 */
function mtlNamesIn(text) {
  return [...text.matchAll(/^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/gim)].map((m) => m[1]);
}

/**
 * Decide which material file an OBJ should use.
 *
 * In order: the one it actually names, then one sharing its filename, then the
 * only one in the archive. Ripped models very often name a file the packager
 * did not include, while a correctly named one sits right beside the model —
 * so the fallbacks matter as much as the declared name.
 */
function autoCoords(index, modelPath, text) {
  const dir = dirName(modelPath);
  for (const name of mtlNamesIn(text)) {
    const found = index.find(name, dir);
    if (found) return found;
  }
  const stem = normKey(stemOf(modelPath));
  const mtls = [...index.entries.keys()].filter((p) => extOf(p) === 'mtl');
  return mtls.find((p) => normKey(stemOf(p)) === stem)
    ?? (mtls.length === 1 ? mtls[0] : null);
}

/** Parse one .mtl into three.js materials, with its maps served from the zip. */
function parseMtl(index, mtlPath, manager) {
  const loader = new MTLLoader(manager);
  // Maps inside the .mtl are relative to the .mtl, not to the .obj.
  const materials = loader.parse(
    sanitiseMtl(new TextDecoder().decode(index.bytes(mtlPath))),
    dirName(mtlPath) + '/');
  materials.preload();
  return materials;
}

/**
 * Sentinels for the Advanced picker. Real choices are archive paths, so these
 * use a character no path can contain.
 */
export const NONE = '\u0000none';        // deliberately use no material file
export const BUILTIN = '\u0000builtin';  // the model carries its own
export const AUTO = '\u0000auto';        // let the material data decide

/**
 * Everything in the archive the user could reasonably be asked to choose
 * between, so the Advanced panel can offer it.
 *
 * Computed whether or not the load succeeds — a model that will not parse is
 * exactly the case where being able to choose something else matters most.
 *
 * What counts as a choice depends on the model: only OBJ keeps its materials
 * in a separate file, so only OBJ gets a list of them. Everything else
 * describes its own materials internally, which is why picking a .dae
 * "automatically switches to the new texture setup" — there is nothing else it
 * could use.
 */
function buildOptions(index, models, chosenPath, materials = []) {
  const ext = extOf(chosenPath ?? '');
  const mtls = [...index.entries.keys()].filter((p) => extOf(p) === 'mtl').sort();

  const coords = ext === 'obj'
    ? [...mtls.map((p) => ({ value: p, label: baseName(p) })),
       { value: NONE, label: 'None — no material file' }]
    : [{ value: BUILTIN, label: `Built into ${baseName(chosenPath ?? 'the model')}` }];

  const images = index.images().map((p) => ({ value: p, label: baseName(p) }));

  return {
    models: models.map((m) => ({ value: m.path, label: baseName(m.path) })),
    coords,
    textures: [{ value: AUTO, label: 'From the material data' }, ...images],
    // Each material is named alongside the file it is currently showing.
    // Rip material names are cryptic — "_153f42ee_dds" — so the filename is
    // the half that makes the list possible to choose from.
    replaceFrom: [
      { value: NONE, label: 'Nothing' },
      ...materials.map(({ key, name, texture }) => ({
        value: key,
        label: texture ? `${name || key} — ${baseName(texture)}` : (name || key),
      })),
    ],
    replaceWith: [{ value: NONE, label: 'Nothing' }, ...images],
  };
}

/**
 * Load one specific model out of an already-opened archive.
 */
async function loadFromArchive(index, candidate, { creaseAngle, choice, warnings }) {
  const ext = candidate.ext;
  const baseDir = dirName(candidate.path);
  const report = {
    picked: candidate.path,
    bound: new Set(),
    missing: [],
    guessed: [],
    coords: null,
    coordsKind: 'built-in',
    textureOverride: null,
    replacements: [],
    materials: [],
    warnings: [...warnings],
  };

  const { manager, revoke, pathFor } = makeResolver(index, baseDir, report);
  const idle = trackLoads(manager);
  index.take(candidate.path);             // never offer the model as a texture

  let object;
  try {
    const bytes = index.bytes(candidate.path);
    let materials = null;

    if (ext === 'obj') {
      const text = new TextDecoder().decode(bytes);
      // An explicit choice of "none" is respected: some rips ship an .mtl
      // whose bindings are worse than nothing.
      const asked = choice?.coords;
      const coords = asked === NONE ? null
        : (asked && asked !== BUILTIN && asked !== AUTO && index.bytes(asked) ? asked
          : autoCoords(index, candidate.path, text));
      if (coords && index.bytes(coords)) {
        materials = parseMtl(index, coords, manager);
        report.coords = coords;
        report.coordsKind = 'mtl';
      } else {
        report.coordsKind = 'none';
        for (const name of mtlNamesIn(text)) {
          if (!index.find(name, baseDir) && !report.missing.includes(baseName(name))) {
            report.missing.push(baseName(name));
          }
        }
      }
    }

    const result = await parseModel(ext, bytes.buffer, {
      manager, index, report, creaseAngle, materials,
      // Trailing slash: three.js resolves a relative reference by plain
      // concatenation, so the model's own folder has to end in one.
      path: baseDir ? baseDir + '/' : '',
    });
    object = normalise(result, creaseAngle);
    if (!hasMesh(object)) throw new Error('That model contains no meshes to render');

    // Textures load asynchronously even from loaders whose parse() is
    // synchronous, so the blob URLs have to outlive the parse call.
    await idle();
    if (choice?.texture && choice.texture !== AUTO && index.bytes(choice.texture)) {
      // One texture for the whole model and a single-material swap are
      // mutually exclusive; the picker hides the pair while this is in force.
      applyTextureOverride(object, index, manager, choice.texture, report);
    } else {
      bindLooseTextures(object, index, manager, report);
      // Last, so an explicit choice always beats a guess.
      applyReplacements(object, index, manager, choice?.replacements, report);
    }
    await idle();

    // Read off what each material ended up using, while the blob URLs that
    // make that traceable are still alive.
    const seen = new Set();
    eachMaterial(object, (material, key) => {
      if (!material.map || seen.has(key)) return;
      seen.add(key);
      report.materials.push({ key, name: material.name, texture: pathFor(material.map) });
    });
  } finally {
    revoke();
  }

  repairMaterials(object);
  return { object, stats: describe(object, ext), report };
}

/**
 * Load a model out of a .zip, textures and all.
 *
 * With no explicit choice this walks the ranked models until one parses:
 * ripped bundles frequently ship a Collada file that no parser will touch
 * beside an OBJ that loads perfectly, and trying the next one is the
 * difference between a model and an error message. Once the user *has*
 * chosen, only that model is tried — silently loading a different one would
 * make the choice a lie.
 */
async function loadArchive(file, { creaseAngle = 40, choice = null } = {}) {
  const { index, models, warnings, listing } = await openArchiveCached(file);
  // Re-opened or reused, every load starts from a clean slate of what has
  // been handed out, or a second pass would think its textures were spoken for.
  index.used = new Set();

  if (!models.length) {
    const kinds = [...new Set(listing.map((e) => e.ext).filter(Boolean))].slice(0, 6);
    const saw = kinds.length ? ` It holds: ${kinds.map((k) => '.' + k).join(', ')}.` : '';
    throw new Error(
      `No 3D model found in that zip.${saw}${warnings.length ? ' ' + warnings[0] + '.' : ''}`);
  }

  const wanted = choice?.model && models.find((m) => m.path === choice.model);
  const order = wanted ? [wanted] : models;
  const failures = [];

  for (const candidate of order) {
    // A failed attempt still marks textures as used, which would starve the
    // next candidate's guessing pass, so the index is wound back each time.
    const usedBefore = new Set(index.used);
    try {
      const loaded = await loadFromArchive(index, candidate, { creaseAngle, choice, warnings });
      loaded.report.archive = file.name;
      loaded.report.options = buildOptions(
        index, models, candidate.path, loaded.report.materials);
      loaded.report.models = models.map((m) => m.path);
      loaded.report.chosen = {
        model: candidate.path,
        coords: loaded.report.coords ?? (extOf(candidate.path) === 'obj' ? NONE : BUILTIN),
        texture: report_texture(loaded.report),
      };
      for (const f of failures) {
        loaded.report.warnings.push(`${baseName(f.path)} would not load — ${f.message}`);
      }
      return loaded;
    } catch (err) {
      index.used = usedBefore;
      failures.push({ path: candidate.path, message: err.message });
    }
  }

  // Nothing parsed. The options still travel with the error so the Advanced
  // panel can be filled in and a different combination tried.
  const err = new Error(failures.length === 1
    ? `${baseName(failures[0].path)} would not load — ${failures[0].message}`
    : `No model in that zip would load. ${failures.map(
        (f) => `${baseName(f.path)}: ${f.message}`).join('; ')}`);
  const attempted = order[0]?.path ?? null;
  err.report = {
    archive: file.name, warnings,
    options: buildOptions(index, models, attempted),
    materials: [],
    models: models.map((m) => m.path),
    chosen: { model: attempted, coords: choice?.coords ?? AUTO,
              texture: choice?.texture ?? AUTO },
    replacements: [],
    bound: new Set(), missing: [], guessed: [], failed: true,
  };
  throw err;
}

/** What the texture picker should show as selected after a load. */
function report_texture(report) {
  return report.textureOverride ?? AUTO;
}

/**
 * Remember the last archive opened, so changing one dropdown in the Advanced
 * panel does not re-inflate the whole zip. Only one is held, and only when it
 * is small enough that keeping it costs less than reading it again.
 */
const CACHE_LIMIT = 96 * 1024 * 1024;
let cached = null;

async function openArchiveCached(file) {
  if (cached?.file === file) return cached.bundle;
  const bundle = await openArchive(file);
  cached = bundle.bytes <= CACHE_LIMIT ? { file, bundle } : null;
  return bundle;
}

/**
 * Swap the textures on named materials.
 *
 * The narrow counterpart to applyTextureOverride(): the material data stays in
 * charge of everything else, and individual bindings are redirected. Swapping
 * one face for another out of the same folder is the case this exists for, and
 * taking a list rather than a single pair is what lets a face split across two
 * materials be changed as a whole.
 *
 * Each replacement inherits the outgoing texture's sampler settings rather than
 * taking three.js defaults. Wrap mode is the one that matters: these models
 * routinely rely on repeat or mirrored wrapping, and a replacement that quietly
 * reset it would tile or clamp wrongly — the same failure this project started
 * out chasing.
 */
function applyReplacements(object, index, manager, list, report) {
  const wanted = new Map();               // material key -> archive path
  for (const pair of Array.isArray(list) ? list : []) {
    const { material, texture } = pair ?? {};
    if (!material || !texture || material === NONE || texture === NONE) continue;
    if (!index.bytes(texture)) continue;
    wanted.set(material, texture);
  }
  if (!wanted.size) return;

  const loader = new THREE.TextureLoader(manager);
  const made = new Map();                 // one Texture per file + sampler
  const landed = new Set();

  eachMaterial(object, (material, key) => {
    const path = wanted.get(key);
    if (!path) return;

    const previous = material.map;
    const flipY = previous ? previous.flipY : true;
    const signature = `${path}|${flipY}|${previous?.wrapS ?? ''}|${previous?.wrapT ?? ''}`;

    let texture = made.get(signature);
    if (!texture) {
      texture = loader.load(path);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = flipY;
      if (previous) {
        texture.wrapS = previous.wrapS;
        texture.wrapT = previous.wrapT;
        texture.repeat.copy(previous.repeat);
        texture.offset.copy(previous.offset);
      }
      made.set(signature, texture);
    }
    material.map = texture;
    material.needsUpdate = true;
    landed.add(key);
  });

  // Reported in the order they were asked for, not the order the scene graph
  // happens to be walked in, so the picker can show them back unchanged.
  report.replacements = [...wanted]
    .filter(([key]) => landed.has(key))
    .map(([material, texture]) => ({ material, texture }));
}

/**
 * Force one texture onto every material.
 *
 * The blunt instrument, and sometimes the right one: a rip whose material data
 * is wrong is often a single atlas the whole model is meant to share, and
 * picking that file by hand beats any amount of guessing.
 */
function applyTextureOverride(object, index, manager, texturePath, report) {
  if (!index.bytes(texturePath)) return;
  const texture = new THREE.TextureLoader(manager).load(texturePath);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  object.traverse((child) => {
    if (!child.isMesh) return;
    for (const material of materialsOf(child)) {
      if (!material) continue;
      material.map = texture;
      material.needsUpdate = true;
    }
  });
  report.textureOverride = texturePath;
}

/**
 * Count what a LoadingManager has in flight, so the blob URLs backing an
 * archive can be revoked at the right moment and not a turn too early.
 *
 * LoadingManager keeps itemsLoaded/itemsTotal as closure variables and exposes
 * them only through onProgress, so there is nothing on the object to poll —
 * reading manager.itemsTotal gets undefined. itemStart/itemEnd *are* public
 * and every loader calls them, so wrapping that pair is the reliable hook.
 *
 * This matters more than it looks: parse() returns synchronously for FBX, OBJ
 * and Collada while their textures are still decoding, so revoking on the next
 * turn leaves every one of them holding an empty image.
 */
function trackLoads(manager) {
  let pending = 0;
  let waiting = [];
  const baseStart = manager.itemStart.bind(manager);
  const baseEnd = manager.itemEnd.bind(manager);

  manager.itemStart = (url) => { pending++; baseStart(url); };
  manager.itemEnd = (url) => {
    baseEnd(url);                 // itemError has already run on the failure path
    pending--;
    if (pending <= 0) { const woken = waiting; waiting = []; for (const r of woken) r(); }
  };

  return function idle() {
    return new Promise((resolve) => {
      // One macrotask first, so loads started by a parse() that has only just
      // returned have registered themselves before we decide we are idle.
      setTimeout(() => {
        if (pending <= 0) { resolve(); return; }
        waiting.push(resolve);
        // A texture that never settles must not strand the whole model.
        setTimeout(resolve, 30000);
      }, 0);
    });
  };
}

/* ------------------------------------------- guessing the leftover maps */

/**
 * Last resort: attach textures the model never asked for.
 *
 * Plenty of bundles ship a model whose texture references are simply gone —
 * an OBJ whose .mtl was left out of the zip, or a Collada file exported with
 * no <library_images> at all — next to a textures/ folder that plainly belongs
 * to it. Nothing in the file format connects the two, so the only way to
 * recover them is to match names, and the only honest thing to do afterwards
 * is to say that is what happened.
 *
 * Deliberately conservative: a mesh with no UVs cannot show a texture
 * meaningfully, and a guess is only made on a clear name match or when the
 * archive leaves exactly one possibility.
 */
function bindLooseTextures(object, index, manager, report) {
  const loose = index.looseImages()
    .filter((path) => ['colour', 'unknown'].includes(channelOf(path)));
  if (!loose.length) return;

  // A material instance is commonly shared by many meshes — the Pershing's one
  // Collada material covers 31 of them — so collect materials, not meshes, or
  // the same texture is loaded and reported once per mesh.
  const targets = new Set();
  object.traverse((child) => {
    if (!child.isMesh || !child.geometry?.attributes?.uv) return;
    for (const material of materialsOf(child)) {
      if (material && !material.map) targets.add(material);
    }
  });
  if (!targets.size) return;

  const loader = new THREE.TextureLoader(manager);
  const cache = new Map();
  const attach = (material, path) => {
    let texture = cache.get(path);
    if (!texture) {
      texture = loader.load(path);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = true;               // the convention everywhere but glTF
      cache.set(path, texture);
      report.guessed.push({ material: material.name || '(unnamed)', texture: path });
    }
    material.map = texture;
    material.needsUpdate = true;
  };

  // One texture, one material with nowhere else for it to go.
  if (loose.length === 1 && targets.size === 1) {
    attach([...targets][0], loose[0]);
    return;
  }

  for (const material of targets) {
    let best = null;
    let bestScore = 0;
    for (const path of loose) {
      const score = nameAffinity(material.name, path);
      if (score > bestScore) { bestScore = score; best = path; }
    }
    if (best && bestScore >= 60) attach(material, best);
  }
}

/**
 * Two corrections that every loaded model gets, whatever it arrived in.
 *
 * **Colour space.** A colour map holds sRGB data by definition, but only some
 * loaders say so — ColladaLoader sets none at all, which renders washed out.
 *
 * **Crushed tints.** The scene multiplies a material's colour by its texture,
 * which is what the format says to do, so a base colour of near-black hides
 * the texture completely. FBX exporters write exactly that: the Desert Eagle's
 * FBX declares 0c0c0c while the glTF build of the same model — same textures,
 * same author — declares white and expects the map to carry the colour. Only
 * tints dark enough to crush any texture to black are touched, and only where
 * there is a texture for them to crush, so a model that renders correctly
 * today cannot change.
 */
const CRUSHED_TINT = 0.15;

function repairMaterials(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    for (const material of materialsOf(child)) {
      const map = material?.map;
      if (!map) continue;

      if (map.colorSpace !== THREE.SRGBColorSpace) {
        map.colorSpace = THREE.SRGBColorSpace;
        material.needsUpdate = true;
      }

      const tint = material.color;
      if (tint && Math.max(tint.r, tint.g, tint.b) < CRUSHED_TINT) {
        tint.setScalar(1);
        material.needsUpdate = true;
      }
    }
    // Invisible materials, whatever the format they came from.
    for (const material of materialsOf(child)) if (material) unhide(material);
  });
}

/**
 * Bring back a material that would draw nothing at all.
 *
 * Nobody loads a model in order to look at nothing, so a material left fully
 * transparent is a defect in the file rather than an intention. Ripped models
 * are full of them — the .mtl case has its own precise fix in sanitiseMtl(),
 * but FBX and Collada arrive with the same damage and no comparable tell, so
 * this catches whatever gets through.
 *
 * The threshold is deliberately at the floor: real glass is authored somewhere
 * between 0.1 and 0.9 and keeps working untouched. Only materials that are
 * literally invisible are changed.
 */
const INVISIBLE = 0.02;

function unhide(material) {
  if (material.opacity > INVISIBLE) return;
  material.opacity = 1;
  material.transparent = false;
  material.needsUpdate = true;
}

/** Summary line for the UI, mirroring the desktop app's model info row. */
export function describe(object, ext) {
  let triangles = 0;
  let meshes = 0;
  let textured = false;
  let vertexColours = false;

  object.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    meshes++;
    const geometry = child.geometry;
    const count = geometry.index ? geometry.index.count : geometry.attributes.position?.count ?? 0;
    triangles += Math.floor(count / 3);
    if (geometry.attributes.color) vertexColours = true;
    const mats = materialsOf(child);
    if (mats.some((m) => m?.map)) textured = true;
  });

  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  return { triangles, meshes, textured, vertexColours, size, ext };
}
