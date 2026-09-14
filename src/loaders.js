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
 */

import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from '../vendor/three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from '../vendor/three/addons/loaders/OBJLoader.js';
import { STLLoader } from '../vendor/three/addons/loaders/STLLoader.js';
import { PLYLoader } from '../vendor/three/addons/loaders/PLYLoader.js';
import { ColladaLoader } from '../vendor/three/addons/loaders/ColladaLoader.js';
import { ThreeMFLoader } from '../vendor/three/addons/loaders/3MFLoader.js';
import { FBXLoader } from '../vendor/three/addons/loaders/FBXLoader.js';
import { USDZLoader } from '../vendor/three/addons/loaders/USDZLoader.js';
import { VOXLoader, VOXMesh } from '../vendor/three/addons/loaders/VOXLoader.js';
import { TDSLoader } from '../vendor/three/addons/loaders/TDSLoader.js';
import { toCreasedNormals } from '../vendor/three/addons/utils/BufferGeometryUtils.js';

export const SUPPORTED_EXTENSIONS = [
  'glb', 'gltf', 'obj', 'stl', 'ply', 'dae', '3mf', 'fbx', 'usdz', 'vox', '3ds',
];

export const FILE_ACCEPT = SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(',');

/** Formats that carry textures inside a single file — the friction-free ones. */
export const SELF_CONTAINED = new Set(['glb', 'usdz', 'fbx', 'vox', '3mf']);

export function extensionOf(name) {
  return (name.split('.').pop() || '').toLowerCase();
}

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

/**
 * Load a model from a File/Blob. Returns { object, stats }.
 * `creaseAngle` matches the desktop app's --smooth flag.
 */
export async function loadModel(file, { creaseAngle = 40 } = {}) {
  const ext = extensionOf(file.name);
  const buffer = await file.arrayBuffer();
  let result;

  switch (ext) {
    case 'glb':
    case 'gltf': {
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      // Vendored locally so the app still works offline and on Pages.
      draco.setDecoderPath('./vendor/three/addons/libs/draco/gltf/');
      loader.setDRACOLoader(draco);
      result = await loader.parseAsync(buffer, '');
      break;
    }
    case 'obj': {
      const text = new TextDecoder().decode(buffer);
      result = new OBJLoader().parse(text);
      break;
    }
    case 'stl':
      result = new STLLoader().parse(buffer);
      break;
    case 'ply':
      result = new PLYLoader().parse(buffer);
      break;
    case 'dae': {
      const text = new TextDecoder().decode(buffer);
      result = new ColladaLoader().parse(text, '');
      break;
    }
    case '3mf':
      result = new ThreeMFLoader().parse(buffer);
      break;
    case 'fbx':
      result = new FBXLoader().parse(buffer, '');
      break;
    case 'usdz':
      result = new USDZLoader().parse(buffer);
      break;
    case 'vox': {
      const chunks = new VOXLoader().parse(buffer);
      const group = new THREE.Group();
      for (const chunk of chunks) group.add(new VOXMesh(chunk));
      result = group;
      break;
    }
    case '3ds':
      result = new TDSLoader().parse(buffer, '');
      break;
    default:
      throw new Error(`Unsupported file type: .${ext}`);
  }

  const object = normalise(result, creaseAngle);
  if (!hasMesh(object)) {
    throw new Error('That file contains no meshes to render');
  }
  return { object, stats: describe(object, ext) };
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
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    if (mats.some((m) => m?.map)) textured = true;
  });

  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  return { triangles, meshes, textured, vertexColours, size, ext };
}
