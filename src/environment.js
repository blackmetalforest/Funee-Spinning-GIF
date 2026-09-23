/**
 * Image-based lighting: what a metal surface has to reflect.
 *
 * A physically based material splits its light into diffuse and specular, and
 * a fully metallic one has *no* diffuse at all — everything it shows is a
 * reflection. Lit by a few directional lights and nothing else, a metal
 * reflects three points and black everywhere between them, which is why the
 * Canon camera rendered nearly black. The fix is not a brighter light; it is
 * giving the surface a surrounding to reflect.
 *
 * Both surroundings here are ordinary three.js scenes baked through
 * PMREMGenerator, the library's own prefiltered-environment path. Nothing is
 * downloaded: an HDR file would be megabytes and would add the app's first
 * network request, and a small built scene gives the highlights that sell a
 * material just as well.
 *
 * The emissive panels are MeshBasicMaterial with colours well above 1. PMREM
 * renders into a half-float target, so those values survive as real HDR
 * brightness — which is what makes a softbox read as a light source in a
 * reflection instead of as a white card.
 */

import * as THREE from '../vendor/three/three.module.js';

export const ENVIRONMENTS = ['studio', 'soft', 'none'];

/** A room with softboxes: crisp reflections, the product-shot look. */
function studioScene() {
  const scene = new THREE.Scene();
  const add = (geometry, colour, position, rotation = [0, 0, 0], side = THREE.FrontSide) => {
    const material = new THREE.MeshBasicMaterial({ color: colour, side });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    scene.add(mesh);
    return mesh;
  };
  const grey = (v) => new THREE.Color().setScalar(v);

  // The room itself: light-grey walls, a darker floor, seen from inside.
  // Chrome shows almost nothing but these, so they set how bright bare metal
  // reads — a darker room made every metal part look like gunmetal.
  add(new THREE.BoxGeometry(20, 12, 20), grey(0.55), [0, 3, 0], [0, 0, 0], THREE.BackSide);
  add(new THREE.PlaneGeometry(20, 20), grey(0.22), [0, -2.95, 0], [-Math.PI / 2, 0, 0]);

  // Softboxes. Arranged around the default view, which looks down -Z from
  // +Z: a big key high and to the right of the camera, a fill to the left, a
  // strip behind for edge highlights, and a ceiling panel for the top faces.
  const panel = (w, h) => new THREE.PlaneGeometry(w, h);
  const lookAtCentre = (mesh) => { mesh.lookAt(0, 0, 0); return mesh; };
  lookAtCentre(add(panel(6, 4), grey(9), [6, 5, 7]));
  lookAtCentre(add(panel(4, 5), grey(3.5), [-8, 2, 5]));
  lookAtCentre(add(panel(10, 1.5), grey(6), [0, 4, -9]));
  add(panel(8, 8), grey(4), [0, 8.9, 0], [Math.PI / 2, 0, 0]);
  return scene;
}

/** A sky-to-ground gradient: even and gentle, with no hard highlights. */
function softScene() {
  const scene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(10, 48, 24);
  const position = geometry.attributes.position;
  const colours = new Float32Array(position.count * 3);
  const sky = new THREE.Color().setScalar(1.6);
  const ground = new THREE.Color().setScalar(0.18);
  const colour = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const t = THREE.MathUtils.smoothstep(position.getY(i) / 10, -0.35, 0.6);
    colour.copy(ground).lerp(sky, t);
    colour.toArray(colours, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide,
  })));
  return scene;
}

const BUILDERS = { studio: studioScene, soft: softScene };

/**
 * Bakes each environment the first time it is asked for, then keeps it. There
 * are only two and each is a small cube map, so holding both is cheaper than
 * re-baking whenever someone flicks between them.
 */
export class Environments {
  constructor(renderer) {
    this.renderer = renderer;
    this.baked = new Map();
  }

  get(kind) {
    if (!BUILDERS[kind]) return null;
    if (!this.baked.has(kind)) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const scene = BUILDERS[kind]();
      // A little blur: sharp enough that a softbox is still a shape in a
      // mirror finish, soft enough that the room's box edges never read.
      const target = pmrem.fromScene(scene, 0.04);
      pmrem.dispose();
      scene.traverse((child) => {
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      });
      this.baked.set(kind, target);
    }
    return this.baked.get(kind).texture;
  }

  dispose() {
    for (const target of this.baked.values()) target.dispose();
    this.baked.clear();
  }
}
