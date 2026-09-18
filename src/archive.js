/**
 * The archive hunter — turns a .zip into a model plus the textures that go
 * with it.
 *
 * Textured models are almost never distributed as one file. The common shape,
 * which every sample in Test3D follows, is a Sketchfab-style bundle:
 *
 *     source/Model.fbx          (sometimes itself a nested .zip)
 *     textures/Foo_BaseColor.png
 *     license.txt
 *
 * Nothing about that is standardised, so this file is deliberately a *hunter*
 * rather than a parser: it flattens the archive (including archives inside
 * archives) into one virtual filesystem, picks the most promising model in it,
 * and then answers texture requests from the loaders with progressively
 * looser matching until something fits.
 *
 * The looseness is not laziness. Packagers rewrite names on the way in — the
 * Desert Eagle's FBX asks for "DesertEagle_Desert Eagle_BaseColor.png" while
 * the zip actually contains "DesertEagle_Desert_Eagle_BaseColor.png" — so
 * exact matching alone textures almost nothing.
 */

import { unzip, unzipSync } from '../vendor/fflate.module.js';

/* ----------------------------------------------------------- vocabulary */

/** Kept in step with SUPPORTED_EXTENSIONS in loaders.js. */
export const MODEL_EXTENSIONS = new Set([
  'glb', 'gltf', 'obj', 'stl', 'ply', 'dae', '3mf', 'fbx', 'usdz', 'vox', '3ds',
]);

/** Anything an <img> can decode, plus TGA, which three.js decodes itself. */
export const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga', 'avif',
]);

/** Not models and not images, but still referenced by one. */
const DATA_EXTENSIONS = new Set(['mtl', 'bin']);

/**
 * Archive formats we can see but not open. RAR in particular turns up inside
 * OBJ bundles, and there is no small pure-JS unrar — the format is patented
 * enough that the practical options are multi-megabyte WASM ports.
 */
const OPAQUE_ARCHIVES = new Set(['rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz']);

/**
 * Which model to prefer when an archive holds several. Higher wins. This is
 * ordered by how much of the material information survives the trip: glTF and
 * FBX carry real texture bindings, OBJ needs a sidecar .mtl that is often
 * missing, and STL/PLY cannot reference a texture at all.
 */
const FORMAT_RANK = {
  glb: 10, gltf: 10, fbx: 9, dae: 8, usdz: 8, '3mf': 7, obj: 6, '3ds': 5,
  vox: 4, ply: 3, stl: 2,
};

/** Depth of archive-inside-archive nesting to follow. */
const MAX_NESTING = 4;

/** Refuse to inflate more than this in total, so a zip bomb cannot OOM a phone. */
const MAX_TOTAL_BYTES = 768 * 1024 * 1024;

/* --------------------------------------------------------- path helpers */

/**
 * Normalise a path to forward slashes with . and .. resolved.
 * Windows separators matter here: FBX stores the authoring machine's absolute
 * path, e.g. "W:\3D Graphics\...\Textures\Foo.png".
 */
export function cleanPath(path) {
  const out = [];
  for (const segment of String(path ?? '').replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { out.pop(); continue; }
    out.push(segment);
  }
  return out.join('/');
}

export function baseName(path) {
  const clean = cleanPath(path);
  return clean.slice(clean.lastIndexOf('/') + 1);
}

export function dirName(path) {
  const clean = cleanPath(path);
  const cut = clean.lastIndexOf('/');
  return cut < 0 ? '' : clean.slice(0, cut);
}

export function extOf(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function stemOf(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(0, dot);
}

/**
 * Collapse a name to its alphanumerics, lowercased.
 *
 * This is the single most valuable trick in the file. It makes
 * "DesertEagle_Desert Eagle_BaseColor" and "DesertEagle_Desert_Eagle_BaseColor"
 * the same string, which is the difference between that model arriving
 * textured and arriving grey.
 */
export function normKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** decodeURIComponent that returns the input rather than throwing on bad escapes. */
function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

/* ------------------------------------------------------------ unzipping */

/**
 * Inflate an archive, preferring fflate's worker-backed path.
 *
 * fflate farms entries over 512 KB out to Web Workers, which keeps a 75 MB
 * bundle from freezing the page. Workers are not always available, though — a
 * strict CSP can block the blob: URL they are built from — so this falls back
 * to inflating in place rather than failing the load.
 *
 * `makeFilter` is a factory, not a filter, because the fallback runs the
 * filter a second time and each run needs its own byte budget.
 */
async function inflate(bytes, makeFilter) {
  try {
    return await new Promise((resolve, reject) => {
      unzip(bytes, { filter: makeFilter() }, (err, files) => (err ? reject(err) : resolve(files)));
    });
  } catch {
    // Any failure at all falls back, not just a missing Worker. The worker
    // pool is a shared, finite resource: loading a run of archives in one
    // session has been seen to fail here with errors that have nothing to do
    // with the archive, which then reads back as a corrupt file. Inflating in
    // place is slower but has no such failure mode, so it is always worth one
    // attempt before declaring a zip unreadable.
    return unzipSync(bytes, { filter: makeFilter() });
  }
}

/** True for entries that are noise in every archive we have seen. */
function isJunk(path) {
  if (!path) return true;
  if (path.startsWith('__MACOSX/') || path.includes('/__MACOSX/')) return true;
  // AppleDouble resource forks, and .DS_Store alongside them.
  return baseName(path).startsWith('.');
}

/**
 * Inflate one archive into `state`, recursing into any archives it contains.
 *
 * `prefix` keeps nested paths unique and readable, so a Collada file two
 * archives deep is addressed as "source/model.zip!/model/model.dae". The
 * loaders never see these strings — they exist so that a relative reference
 * inside a nested archive resolves within that archive first.
 */
async function readInto(bytes, prefix, depth, state) {
  const nested = [];

  // The filter runs for every entry *before* it is inflated, which is how a
  // 59 MB camera bundle is read without ever decompressing the 14 MB .blend
  // sitting next to the model. It is built fresh per attempt and writes only
  // to keyed collections, so running it twice changes nothing.
  const makeFilter = () => {
    let used = state.bytes;
    return (entry) => {
      const path = cleanPath(entry.name);
      if (entry.name.endsWith('/') || isJunk(path)) return false;

      const ext = extOf(path);
      const full = prefix + path;
      state.listing.set(full, { path: full, ext, size: entry.originalSize });

      if (OPAQUE_ARCHIVES.has(ext)) { state.opaque.add(full); return false; }

      const wanted = MODEL_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)
        || DATA_EXTENSIONS.has(ext) || ext === 'zip';
      if (!wanted) return false;

      if (used + entry.originalSize > MAX_TOTAL_BYTES) {
        state.truncated = true;
        return false;
      }
      used += entry.originalSize;
      return true;
    };
  };

  const files = await inflate(bytes, makeFilter);

  for (const [name, data] of Object.entries(files)) {
    const path = prefix + cleanPath(name);
    state.bytes += data.length;
    if (extOf(path) === 'zip') nested.push([path, data]);
    else state.entries.set(path, data);
  }

  if (depth >= MAX_NESTING) {
    for (const [path] of nested) state.opaque.add(path);
    return;
  }
  for (const [path, data] of nested) {
    // A corrupt inner archive should cost us that archive, not the whole load.
    try {
      await readInto(data, path + '!/', depth + 1, state);
    } catch {
      state.opaque.add(path);
    }
  }
}

/* --------------------------------------------------------- asset lookup */

/**
 * Everything pulled out of the archive, indexed for progressively looser
 * lookup. Built once per load; the maps are tiny because archives hold tens of
 * files, not thousands.
 */
export class AssetIndex {
  constructor(entries) {
    this.entries = entries;               // virtual path -> Uint8Array
    this.byPath = new Map();              // lowercased path -> path
    this.byName = new Map();              // lowercased basename -> [path]
    this.byNorm = new Map();              // normKey(basename) -> [path]
    this.byStem = new Map();              // normKey(stem) -> [path]
    this.used = new Set();                // paths handed out, for reporting

    for (const path of entries.keys()) {
      this.byPath.set(path.toLowerCase(), path);
      push(this.byName, baseName(path).toLowerCase(), path);
      push(this.byNorm, normKey(baseName(path)), path);
      push(this.byStem, normKey(stemOf(path)), path);
    }
  }

  /** Every image in the archive, shallowest first. */
  images() {
    return [...this.entries.keys()]
      .filter((path) => IMAGE_EXTENSIONS.has(extOf(path)))
      .sort(byDepthThenName);
  }

  /** Images no loader has asked for — candidates for the guessing pass. */
  looseImages() {
    return this.images().filter((path) => !this.used.has(path));
  }

  /**
   * Find the archive entry a loader is asking for.
   *
   * Ordered from strictest to loosest so that a bundle which *is* internally
   * consistent resolves exactly, and only genuinely broken references fall
   * through to guesswork.
   */
  find(uri, baseDir = '') {
    const raw = String(uri ?? '');
    if (!raw || /^(data|blob|https?):/i.test(raw)) return null;

    // Both the literal and percent-decoded forms are tried, and the literal
    // one comes first: '#' is a legal filename character and the Canon
    // camera's textures all start with one, so a fragment cannot simply be
    // stripped.
    const forms = [];
    for (const form of [raw, safeDecode(raw)]) {
      if (form && !forms.includes(form)) forms.push(form);
      const cut = form.replace(/[?#].*$/, '');
      if (cut && !forms.includes(cut)) forms.push(cut);
    }

    // 1. Exact path, relative to the model's own folder and then to the root.
    for (const form of forms) {
      const clean = cleanPath(form);
      if (!clean) continue;
      const rooted = baseDir ? cleanPath(baseDir + '/' + clean) : clean;
      const hit = this.byPath.get(rooted.toLowerCase())
        ?? this.byPath.get(clean.toLowerCase());
      if (hit) return this.take(hit);
    }

    // 2. Longest matching path suffix. This is what tells the Canon camera's
    //    Textures_4k/COL.png apart from the Textures_2k/COL.png beside it,
    //    which a basename match alone would coin-flip.
    for (const form of forms) {
      const hit = this.bySuffix(cleanPath(form));
      if (hit) return this.take(hit);
    }

    // 3. Basename: exact, then separator-insensitive, then ignoring the
    //    extension entirely, since packagers re-encode .tga as .png and .jpg
    //    as .jpeg without rewriting the reference.
    for (const form of forms) {
      const name = baseName(cleanPath(form));
      if (!name) continue;
      const hit = first(this.byName.get(name.toLowerCase()))
        ?? first(this.byNorm.get(normKey(name)))
        ?? first(this.byStem.get(normKey(stemOf(name))));
      if (hit) return this.take(hit);
    }

    return null;
  }

  /**
   * Match the trailing segments of a reference against the trailing segments
   * of an entry, comparing segments by their normalised form so that a
   * rewritten separator anywhere along the path does not break it.
   */
  bySuffix(clean) {
    if (!clean) return null;
    const wanted = clean.split('/').map(normKey).filter(Boolean);
    if (!wanted.length) return null;

    const rows = [...this.entries.keys()].map(
      (path) => [path, path.split(/[/!]+/).map(normKey).filter(Boolean)]);

    for (let take = Math.min(4, wanted.length); take >= 1; take--) {
      const tail = wanted.slice(-take).join('/');
      const hits = rows
        .filter(([, segs]) => segs.length >= take && segs.slice(-take).join('/') === tail)
        .map(([path]) => path)
        .sort(byDepthThenName);
      // A one-segment "match" is just the basename, which step 3 does better
      // with its extension fallback; only accept it here when unambiguous.
      if (hits.length === 1 || (hits.length > 1 && take > 1)) return hits[0];
    }
    return null;
  }

  take(path) {
    this.used.add(path);
    return path;
  }

  bytes(path) {
    return this.entries.get(path) ?? null;
  }
}

function push(map, key, value) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function first(list) {
  return list && list.length ? [...list].sort(byDepthThenName)[0] : null;
}

/** Shallow paths first, then alphabetical, so ties resolve the same way twice. */
function byDepthThenName(a, b) {
  const depth = a.split('/').length - b.split('/').length;
  return depth || (a < b ? -1 : a > b ? 1 : 0);
}

/* ------------------------------------------ reading a texture's purpose */

/**
 * What each texture in a bundle is for, read off its filename.
 *
 * Only the colour map is ever used: the scene replaces every material with
 * MeshPhongMaterial and keeps `map` alone, so hunting down a normal or
 * roughness map would be work thrown away. Classifying them is still needed —
 * to rule them *out* as colour candidates.
 *
 * Colour is tested last because its words are the least specific: a file
 * called "metallicRoughness" contains neither "albedo" nor "diffuse", but
 * "Body_baseColor" does contain "color".
 */
const CHANNEL_TESTS = [
  ['normal', /(normal|nrml|[_-]nrm|[_-]n[_-]|bump)/],
  ['roughness', /(rough|[_-]rgh|gloss)/],
  ['metalness', /(metal|metl|[_-]mtl)/],
  ['ao', /(occlusion|ambientocc|(^|[_-])ao([_-]|$))/],
  ['emissive', /(emissi|emission|illum|glow)/],
  ['opacity', /(opacity|opac|alpha|mask|transparen)/],
  ['specular', /(specular|[_-]spec|[_-]s$|[_-]f0)/],
  ['height', /(height|displace|[_-]disp|parallax)/],
  ['colour', /(basecolor|base[_-]color|albedo|diffuse|defuse|[_-]col|[_-]dif|[_-]d$|colou?r)/],
];

export function channelOf(path) {
  const stem = stemOf(path).toLowerCase();
  for (const [name, test] of CHANNEL_TESTS) if (test.test(stem)) return name;
  return 'unknown';
}

/**
 * Score how strongly a texture filename belongs to a material name.
 * Both sides are reduced to alphanumerics first, so "capelli.png" still scores
 * against a material called "capelliHI:lambert1SG".
 */
export function nameAffinity(materialName, path) {
  const material = normKey(materialName);
  const texture = normKey(stemOf(path));
  if (!material || !texture || material === 'null') return 0;
  if (material === texture) return 100;
  if (texture.startsWith(material) || material.startsWith(texture)) return 80;
  if (texture.includes(material) || material.includes(texture)) return 60;
  const shared = longestShared(material, texture);
  return shared >= 5 ? 20 + shared : 0;
}

function longestShared(a, b) {
  let best = 0;
  // Archive names are short, so the quadratic scan costs nothing measurable.
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let run = 0;
      while (i + run < a.length && j + run < b.length && a[i + run] === b[j + run]) run++;
      if (run > best) best = run;
    }
  }
  return best;
}

/* ------------------------------------------------------- model choosing */

/**
 * Rank the models found in an archive. The winner is the one a person would
 * have double-clicked: the richest format, nearest the top, and biggest — with
 * obvious non-deliverables pushed to the back.
 */
export function rankModels(listing) {
  return listing
    .filter((entry) => MODEL_EXTENSIONS.has(entry.ext))
    .map((entry) => ({ ...entry, score: scoreModel(entry) }))
    .sort((a, b) => b.score - a.score || byDepthThenName(a.path, b.path));
}

function scoreModel(entry) {
  const rank = FORMAT_RANK[entry.ext] ?? 1;
  const depth = entry.path.split(/[/!]+/).length - 1;
  const name = normKey(entry.path);

  let score = rank * 1000 - depth * 25;
  // Size breaks ties between same-format siblings without ever outweighing
  // format choice: a 300 MB OBJ should still lose to the GLB beside it.
  score += Math.min(120, Math.log10(Math.max(1, entry.size)) * 15);
  // Things that are in the bundle but are not the deliverable.
  if (/\b(lod[1-9]|collision|collider|proxy|backup|old|draft|test)\b/.test(name)) score -= 400;
  if (/(lod[1-9]|collision|proxy|backup)/.test(name)) score -= 150;
  // A bake is a derived export — lighting or colour flattened into the mesh —
  // and it is routinely the largest file in the bundle, so without this it
  // wins every size tiebreak against the model it was derived from.
  if (/bake/.test(name)) score -= 200;
  return score;
}

/* ---------------------------------------------------------- entry point */

/**
 * Open a zip and report what is inside it.
 *
 * Returns the flattened contents plus a ranked list of models. Choosing among
 * them, and loading one, is the caller's job — this file knows about files,
 * not about three.js.
 */
export async function openArchive(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const state = {
    entries: new Map(), listing: new Map(), opaque: new Set(),
    bytes: 0, truncated: false,
  };

  await readInto(bytes, '', 1, state);

  const index = new AssetIndex(state.entries);
  // Ranked from what was actually inflated, never from the listing: an entry
  // we saw but could not extract — a model inside an archive that failed to
  // open — must not be offered as a choice we cannot honour.
  const models = rankModels([...state.entries].map(([path, data]) => (
    { path, ext: extOf(path), size: data.length })));

  const warnings = [];
  if (state.truncated) {
    warnings.push('archive is very large — some files were skipped');
  }
  for (const path of state.opaque) {
    const ext = extOf(path);
    warnings.push(ext === 'zip'
      ? `${baseName(path)} could not be opened`
      : `${baseName(path)} is a .${ext}, which a browser cannot open`);
  }

  return {
    index, models, warnings, bytes: state.bytes,
    listing: [...state.listing.values()],
  };
}
