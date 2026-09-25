/**
 * The three.js scene — mirrors spin3d/render.py.
 *
 * Two things here are ports rather than fresh decisions, and both matter:
 *
 *  - **Bounding-sphere framing.** The camera distance is derived from the
 *    model's bounding *sphere*, not its box, so the framing is identical at
 *    every angle. Frame to the box and the model visibly pulses as it turns.
 *  - **The lighting model.** Python's _shade() is Blinn-Phong with a hemisphere
 *    ambient and a fresnel rim term. MeshPhongMaterial *is* Blinn-Phong, and
 *    the hemisphere maths line up exactly (see buildLights), so the desktop
 *    app's six sliders keep meaning what they meant. The rim is the one part
 *    three.js has no equivalent for, so it is injected into the shader.
 *
 * That Phong path is now one of two. Models that ship physically based
 * materials are drawn with them instead, lit by an environment as well as the
 * same lights — see src/materials.js for which model gets which, and why the
 * Phong path is kept exactly as it was.
 */

import * as THREE from '../vendor/three/three.module.js';
import {
  ALL_LAYERS_ON, TEXTURE_SLOTS, wantsPhysical, toClassic, toPhysical,
  applyLayers, layersOf, debugMaterial, applyFiltering, LAYERS,
} from './materials.js';
import { Environments } from './environment.js';

export const UP_AXES = ['Y', 'Z', 'X'];

// Hoisted: setAngle() runs once per frame of the live preview, and allocating a
// vector per call is pure garbage for the collector to chase.
const WORLD_UP = new THREE.Vector3(0, 1, 0);
/* The clear colour. Only its alpha of 0 matters — see render(). */
const BLACK = new THREE.Color(0x000000);
const scratch = new THREE.Vector3();

/**
 * A direction in camera space, from an angle around the view (positive is to
 * the right) and a height above it. Camera space has +Z toward the viewer.
 */
function cameraDirection(azimuth, height, out = new THREE.Vector3()) {
  const az = THREE.MathUtils.degToRad(azimuth);
  const h = THREE.MathUtils.degToRad(height);
  return out.set(Math.sin(az) * Math.cos(h), Math.sin(h), Math.cos(az) * Math.cos(h));
}

/**
 * The two lights' long-standing directions, from Python's _shade(), restated
 * as angles. Computed rather than typed so that the defaults reproduce the old
 * vectors exactly — (0.55, 0.62, 1) and (-0.85, -0.10, 1), normalised — and a
 * model lit with the default settings is lit precisely as it always was.
 */
function anglesOf(x, y, z) {
  return {
    azimuth: THREE.MathUtils.radToDeg(Math.atan2(x, z)),
    height: THREE.MathUtils.radToDeg(Math.asin(y / Math.hypot(x, y, z))),
  };
}
const KEY_DEFAULT = anglesOf(0.55, 0.62, 1);
const FILL_DEFAULT = anglesOf(-0.85, -0.10, 1);

export const TONE_MAPPINGS = {
  none: THREE.NoToneMapping,
  neutral: THREE.NeutralToneMapping,
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
};

export const DEFAULT_SETTINGS = {
  width: 480,
  height: 480,
  supersample: 1,          // MSAA handles most of it; 2-3 for extra smoothing
  elevation: 20,
  startAngle: 0,
  upAxis: 'Y',
  // Position adjustments, applied around the rotation point. Translation is in
  // bounding-sphere radii (the model is normalised to radius 1), so 1.0 shifts
  // it by its own radius regardless of the model's real-world scale.
  posX: 0,
  posY: 0,
  posZ: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  fov: 35,
  zoom: 1.0,
  background: '#181a20',
  transparent: true,
  ambient: 0.30,
  keyLight: 0.95,
  fillLight: 0.32,
  rimLight: 0.0,
  shininess: 40,
  specular: 0.0,
  smoothAngle: 40,

  // Materials: 'auto' | 'physical' | 'classic'. See src/materials.js.
  shading: 'auto',
  // Image-based lighting, used by physical materials only.
  environment: 'studio',
  // Measured, not guessed: with the hemisphere standing down (see
  // applySettings), 0.7 puts a painted surface within a few levels of its
  // Classic brightness while bare metal still reads as bright chrome.
  envIntensity: 0.7,
  envRotation: 0,
  // 'auto' is Neutral for physical materials and none for Classic, which is
  // what keeps a Classic render identical to the old renderer's.
  toneMapping: 'auto',
  exposure: 1.0,
  // Overall brightness: a multiplier on every light at once — key, fill,
  // rim, ambient and environment — so the balance a preset set up survives
  // turning it all up or down. Works on both paths, where exposure needs tone
  // mapping to do anything.
  brightness: 1.0,
  // Light placement and colour. The angles are measured around the view, so
  // the lights keep riding with the camera as they always have.
  keyAzimuth: KEY_DEFAULT.azimuth,
  keyHeight: KEY_DEFAULT.height,
  keyColor: '#ffffff',
  fillAzimuth: FILL_DEFAULT.azimuth,
  fillHeight: FILL_DEFAULT.height,
  fillColor: '#ffffff',
  ambientColor: '#ffffff',
  // 'off' | 'model' (self-shadowing) | 'ground' (plus a shadow underneath).
  shadows: 'off',
  shadowDarkness: 0.5,
  // Debugging: which material layers draw, and which single channel to show.
  view: 'final',
  layers: { ...ALL_LAYERS_ON },
  normalStrength: 1.0,
  emissionStrength: 1.0,
  textureFilter: 'smooth',
  doubleSided: true,
};

export class SpinScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      // Needed so a frame can be read back with toBlob after rendering.
      preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Always enabled; nothing is drawn into a shadow map until a light is
    // actually asked to cast one, so with Shadows off this costs nothing and
    // compiles the same shaders as before.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.environments = new Environments(this.renderer);
    // What this graphics card can do, measured once. The environments are
    // baked into half-float targets, so without that support there is none.
    this.caps = this.capabilities();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.scene.add(this.camera);

    // The model hangs off a pivot so spinning is a single rotation.
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    // User position/rotation lives *inside* the pivot, so the rotation point
    // stays at the origin: translating displaces the model relative to that
    // point (it then orbits as it spins) and rotating pivots it about that
    // point rather than about its own centre.
    this.adjust = new THREE.Group();
    this.adjust.rotation.order = 'YXZ';        // yaw, then pitch, then roll
    this.pivot.add(this.adjust);

    this.model = null;
    this.settings = { ...DEFAULT_SETTINGS };
    // One uniform object shared by every material's rim patch, so a slider
    // move is a single assignment however many materials there are.
    this.rim = { value: DEFAULT_SETTINGS.rimLight };
    this.converted = new Map();     // source material -> Map(key -> render material)
    this.debugCache = new Map();    // render material -> debug-view material
    this.renderMaterials = new Set();
    this.materialKey = null;
    this.shadowKey = null;
    this.shadingInUse = 'classic';
    this.buildLights();
    this.buildGround();
    this.buildAxisArrow();
  }

  /**
   * Lights that ride with the camera, matching Python's _shade().
   *
   * Python: ambient * (0.65 + 0.35 * (0.5 + 0.5*ny)). A HemisphereLight
   * computes mix(ground, sky, 0.5 + 0.5*ny) * intensity, so ground = 0.65 and
   * sky = 1.0 reproduces it exactly.
   *
   * The key and fill used to be children of the camera. They are now placed
   * in the scene, aimed at the origin, by placeLights() whenever the camera
   * moves — the same directions, so the shading is unchanged, but a light
   * that looks at the model is one whose shadow camera can be fitted to it.
   */
  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    this.hemi.groundColor.setScalar(0.65);
    this.scene.add(this.hemi);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 1);
    this.fillLight = new THREE.DirectionalLight(0xffffff, 1);
    for (const light of [this.keyLight, this.fillLight]) {
      this.scene.add(light, light.target);          // target stays at the origin
    }

    // Only the key casts. Sized for a unit-radius model; see fitShadow().
    const shadow = this.keyLight.shadow;
    shadow.mapSize.set(2048, 2048);
    shadow.bias = -0.0004;
    shadow.normalBias = 0.02;
    shadow.radius = 3;
  }

  /**
   * Aim the key and fill from their camera-space angles.
   *
   * A directional light shades by direction alone, so where along that line
   * it stands only matters to its shadow camera, which is why it is parked a
   * fixed distance out from the origin rather than at the lens.
   */
  placeLights() {
    const s = this.settings;
    const distance = this.lightDistance();
    const pairs = [
      [this.keyLight, s.keyAzimuth, s.keyHeight],
      [this.fillLight, s.fillAzimuth, s.fillHeight],
    ];
    for (const [light, azimuth, height] of pairs) {
      cameraDirection(azimuth, height, scratch).applyQuaternion(this.camera.quaternion);
      light.position.copy(scratch).multiplyScalar(distance);
      light.updateMatrixWorld();
    }
    this.fitShadow();
  }

  /** How far out the lights stand: clear of the model however it is offset. */
  lightDistance() {
    const s = this.settings;
    return 10 + 2 * Math.hypot(s.posX, s.posY, s.posZ);
  }

  /**
   * Fit the key light's shadow camera around the model.
   *
   * The model is normalised into a unit sphere about the adjust group, which
   * sits at most `reach` from the origin, so a box of that half-size catches
   * every caster at any spin angle. Depth is given extra room behind the model
   * for the ground, which a grazing light reaches well past the sphere.
   */
  fitShadow() {
    const s = this.settings;
    const half = 1.1 + Math.hypot(s.posX, s.posY, s.posZ);
    const distance = this.lightDistance();
    const camera = this.keyLight.shadow.camera;
    camera.left = -half * 1.6;
    camera.right = half * 1.6;
    camera.top = half * 1.6;
    camera.bottom = -half * 1.6;
    camera.near = Math.max(0.01, distance - half * 2);
    camera.far = distance + half * 6;
    camera.updateProjectionMatrix();
  }

  /**
   * A floor that shows nothing but the shadow falling on it.
   *
   * ShadowMaterial is transparent everywhere the light reaches, so the floor
   * itself never appears — on a transparent export the shadow is the only
   * thing it adds, and it sits correctly over any background layer.
   */
  buildGround() {
    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.ShadowMaterial({ opacity: DEFAULT_SETTINGS.shadowDarkness }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.visible = false;
    this.scene.add(this.ground);
  }

  /**
   * Put the floor under the model's lowest point.
   *
   * The spin is always about world Y, and turning about a vertical axis never
   * changes a point's height, so the lowest point is the same at every frame
   * and the floor can be placed once rather than chasing the spin.
   *
   * Measured precisely (vertex by vertex): a floor placed from the loose box
   * floats visibly below a model whose extremes are curved.
   */
  placeGround() {
    const s = this.settings;
    const wanted = s.shadows === 'ground' && !!this.model;
    this.ground.visible = wanted;
    if (!wanted) return;
    const key = [s.upAxis, s.posX, s.posY, s.posZ, s.pitch, s.yaw, s.roll].join();
    if (key !== this.groundKey) {
      this.groundKey = key;
      this.pivot.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(this.model, true);
      this.groundY = box.isEmpty() ? -1 : box.min.y;
    }
    const reach = Math.hypot(s.posX, s.posY, s.posZ);
    this.ground.position.set(0, this.groundY - 1e-3, 0);
    this.ground.scale.setScalar(4 + 2 * reach);
    this.ground.material.opacity = s.shadowDarkness;
  }

  /**
   * A red arrow marking the rotation axis.
   *
   * Built from a cylinder plus a cone rather than three.js's ArrowHelper,
   * which draws a one-pixel line for the shaft. MeshBasicMaterial keeps it
   * unlit so it reads the same at any lighting setting.
   *
   * It is a sibling of the pivot, not a child, so it stays put while the model
   * turns around it — that is what makes it useful for judging whether the
   * model actually sits on the axis. setAngle() always spins about world Y
   * regardless of the up-axis setting, so world Y is the axis to mark.
   */
  buildAxisArrow() {
    const material = new THREE.MeshBasicMaterial({ color: 0xe02020 });
    // Unit-height primitives; sizeAxisArrow() scales and places them.
    this.axisShaft = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 20), material);
    this.axisHead = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 20), material);
    this.axisArrow = new THREE.Group();
    this.axisArrow.add(this.axisShaft, this.axisHead);
    this.axisArrow.visible = false;              // off by default
    this.axisRequested = false;                  // what the checkbox asked for
    this.scene.add(this.axisArrow);
  }

  /**
   * Show or hide the guide. Always forced off while frames are captured.
   *
   * The request is remembered separately from the actual visibility so that
   * ticking the box before loading a model still shows the arrow once one
   * arrives — there is nothing to size it against until then.
   */
  setAxisVisible(visible) {
    this.axisRequested = !!visible;
    this.axisArrow.visible = this.axisRequested && !!this.model;
  }

  /**
   * Fade the guide. Used for the brief flash when a Position control moves.
   *
   * `transparent` is switched on only while it is actually needed: a fully
   * opaque material takes the cheaper opaque render pass, so at opacity 1 this
   * leaves the checkbox-pinned guide rendering exactly as it did before. The
   * flag is part of the material's program state, hence needsUpdate — but only
   * on the two frames where it changes, never per frame of the fade.
   */
  setAxisOpacity(opacity) {
    const material = this.axisShaft.material;   // shared with the head
    const blended = opacity < 1;
    if (material.transparent !== blended) {
      material.transparent = blended;
      material.needsUpdate = true;
    }
    material.opacity = opacity;
  }

  /**
   * Size the arrow so it brackets the model: tip clear of the top, base just
   * below the bottom.
   *
   * Computed **once, when a model is loaded**, and measured from the model
   * itself rather than from the adjusted group. Re-measuring on every change
   * made the arrow visibly shrink as the model was moved up: the tip stayed
   * pinned at the frame clamp while the rising bounding box pushed the base up
   * behind it. A fixed reference also makes it far more useful — the whole
   * point is to judge how the model has moved relative to a stationary axis.
   *
   * Normal depth testing means the shaft is hidden inside the model and only
   * the ends protrude, which is precisely why the ends need that clearance.
   */
  sizeAxisArrow() {
    if (!this.model) return;

    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;

    const height = Math.max(1e-3, box.max.y - box.min.y);
    const pad = Math.max(0.02, height * 0.05);
    const headLength = Math.max(0.06, height * 0.12);
    const shaftRadius = Math.max(0.005, height * 0.006);

    // Keep the whole arrow inside the frame. Rotating or moving the model
    // inflates its bounding box, which can push the tip off-screen — and a
    // clipped cone reads as a blunt red bar rather than an arrow, which looks
    // broken. Clamping keeps the head visible; in the common case (centred,
    // unrotated) the limit is never reached and the tip clears the model as
    // intended.
    const limit = (this.frameHalfHeight || 1) * 0.95;
    let base = Math.max(box.min.y - pad, -limit);
    let tip = Math.min(box.max.y + pad + headLength, limit);
    if (tip - base < headLength * 1.5) {
      // Degenerate span (tiny frame or huge model): keep a recognisable arrow.
      base = tip - headLength * 1.5;
    }
    const shaftLength = Math.max(1e-3, tip - base - headLength);

    this.axisShaft.scale.set(shaftRadius, shaftLength, shaftRadius);
    this.axisShaft.position.set(0, base + shaftLength / 2, 0);

    this.axisHead.scale.set(shaftRadius * 3, headLength, shaftRadius * 3);
    this.axisHead.position.set(0, tip - headLength / 2, 0);
  }

  /**
   * Swap in a loaded model: normalise it to a unit bounding sphere at the
   * origin, so every downstream calculation can assume radius 1.
   */
  setModel(object) {
    if (this.model) {
      this.adjust.remove(this.model);
      this.disposeModel();
    }
    this.model = object;
    this.adjust.add(object);
    this.groundKey = null;

    // Measure with the adjustment group at identity. The normalisation below
    // reads world matrices, so leaving a user offset applied here would fold it
    // into the measured radius and mis-scale every subsequent model.
    this.adjust.position.set(0, 0, 0);
    this.adjust.rotation.set(0, 0, 0);

    // The pivot above it has to stand down for the same reason, and it is the
    // easier one to miss: Box3.setFromObject() reports a centre in *world*
    // space, but that centre is written straight back to object.position,
    // which is local. While the pivot carries the up-axis correction the two
    // frames differ by 90 degrees, so the correction lands on the wrong axis
    // and leaves the model off its own centre by as much as a full radius —
    // far enough that the spin swings it through the near plane and clips it.
    // Reachable by reloading a model (any Advanced choice does that) while Up
    // axis is X or Z, and it outlived the setting, because the damage is baked
    // into object.position rather than into the pivot.
    const spin = this.pivot.quaternion.clone();
    this.pivot.quaternion.identity();
    this.pivot.updateMatrixWorld(true);

    // Centre on the bounding-box centre, then scale by the *true* bounding
    // sphere radius. Box3.getBoundingSphere() returns the sphere around the
    // box (half the diagonal), which is larger than the real point sphere and
    // would frame the model noticeably smaller than the desktop app does.
    object.position.set(0, 0, 0);
    object.scale.setScalar(1);
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const centre = box.getCenter(new THREE.Vector3());
    const radius = maxRadiusFromPoint(object, centre) || 1;
    object.position.copy(centre).multiplyScalar(-1 / radius);
    object.scale.setScalar(1 / radius);

    this.pivot.quaternion.copy(spin);
    this.pivot.updateMatrixWorld(true);

    this.prepareMeshes();
    this.applySettings(this.settings);

    // Fixed for the lifetime of this model: sized after applySettings so the
    // camera (and therefore the frame clamp) is up to date, but measured from
    // the model alone so user position offsets never feed into it.
    this.sizeAxisArrow();
    this.axisArrow.visible = this.axisRequested;
  }

  /**
   * Walk every mesh in the model in a fixed order, handing each one its walk
   * position.
   *
   * Mirrors eachMaterial() in loaders.js, and for the same reason: the list
   * the user ticks and the mesh actually hidden both come from here, so the
   * two cannot drift and blank out the wrong part. Reloading the same file
   * rebuilds the same tree in the same order, which is what lets a hidden
   * mesh survive a texture change.
   *
   * The axis guide is a child of the scene rather than of the model, so it is
   * never enumerated and can never be switched off by mistake.
   */
  eachMesh(visit) {
    if (!this.model) return;
    let index = 0;
    this.model.traverse((child) => {
      if (child.isMesh) visit(child, index++);
    });
  }

  /** One entry per mesh, for the picker to render. */
  meshList() {
    const out = [];
    this.eachMesh((mesh, index) => {
      const geometry = mesh.geometry;
      const count = geometry?.index
        ? geometry.index.count
        : geometry?.attributes?.position?.count ?? 0;
      out.push({
        index,
        name: mesh.name ?? '',
        triangles: Math.floor(count / 3),
        visible: mesh.visible !== false,
      });
    });
    return out;
  }

  /**
   * Hide the meshes whose walk positions are in `hidden`, show the rest.
   *
   * Framing deliberately does not follow. setModel() measures with traverse(),
   * which visits invisible objects, so the model keeps the size and centre it
   * was given — ticking boxes to compare two overlapping versions holds the
   * camera still instead of jumping on every click.
   */
  setHiddenMeshes(hidden) {
    const set = hidden instanceof Set ? hidden : new Set(hidden ?? []);
    this.eachMesh((mesh, index) => { mesh.visible = !set.has(index); });
  }

  /**
   * Remember what the file said, once, before anything is swapped in.
   *
   * A mesh may carry an *array* of materials, one per geometry group, and that
   * has to survive: OBJLoader builds exactly that shape whenever a file uses
   * more than one `usemtl`, which is most of the time for a ripped game model.
   * Collapsing the array to its first entry paints every group with the first
   * texture — the whole model wearing one patch of its atlas, which is what
   * "the textures are in the wrong spot" looks like.
   *
   * Keeping the originals is also what lets the Materials choice and every
   * layer switch be changed back and forth without reloading the file.
   */
  prepareMeshes() {
    this.converted = new Map();
    this.debugCache = new Map();
    this.renderMaterials = new Set();
    this.materialKey = null;
    this.shadowKey = null;
    this.model.traverse((child) => {
      if (!child.isMesh) return;
      child.userData.sources = materialsOf(child);
      child.userData.multi = Array.isArray(child.material);
      if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals();
      child.castShadow = false;
      child.receiveShadow = false;
    });
  }

  /** Which path "auto" means for the model that is loaded. */
  resolveShading(mode) {
    if (mode === 'physical' || mode === 'classic') return mode;
    let physical = false;
    this.eachMesh((mesh) => {
      if ((mesh.userData.sources ?? []).some(wantsPhysical)) physical = true;
    });
    return physical ? 'physical' : 'classic';
  }

  /**
   * The material a source is drawn with on the given path, made once and
   * kept, so flicking between paths neither rebuilds nor leaks.
   */
  renderMaterial(source, mesh, shading) {
    let cache = this.converted.get(source);
    if (!cache) this.converted.set(source, cache = new Map());
    const vertexColours = !!mesh.geometry?.attributes?.color;
    const key = `${shading}|${vertexColours}`;
    let material = cache.get(key);
    if (!material) {
      material = shading === 'classic'
        ? toClassic(source, mesh, this.settings)
        : toPhysical(source, mesh);
      material.userData.fileSide ??= source?.side ?? THREE.FrontSide;
      // GLTFLoader turns depth writing off for every blended material, which
      // is right for a pane of glass and badly wrong for the common export
      // that marks a *whole model* as blended because one part of its atlas
      // is translucent: the inside of the Canon's viewfinder then draws over
      // its own housing. Classic has always kept depth writes on, and a model
      // should not fall apart for being switched to Physical.
      if (material.transparent && material.depthWrite === false) material.depthWrite = true;
      this.attachRim(material);
      cache.set(key, material);
    }
    return material;
  }

  /**
   * Put the right materials on every mesh for the current settings.
   *
   * The expensive part — choosing materials, switching layers that change the
   * shader, building debug views — runs only when something that needs it has
   * changed. Everything a slider drives is a uniform and is written every
   * call, which keeps a drag from recompiling shaders at every step.
   */
  syncMaterials(s) {
    if (!this.model) return;
    const shading = this.resolveShading(s.shading);
    const strengths = { normalStrength: s.normalStrength, emissionStrength: s.emissionStrength };
    const key = JSON.stringify([shading, s.view, s.layers, s.doubleSided, s.textureFilter,
      // Debug views copy their values when built, so they rebuild on these.
      s.view === 'final' ? null : strengths]);

    if (key !== this.materialKey) {
      this.materialKey = key;
      this.shadingInUse = shading;
      for (const material of this.debugCache.values()) material.dispose();
      this.debugCache.clear();

      const renders = new Set();
      const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.eachMesh((mesh) => {
        const sources = mesh.userData.sources ?? materialsOf(mesh);
        const drawn = sources.map((source) => {
          const material = this.renderMaterial(source, mesh, shading);
          if (!renders.has(material)) {
            renders.add(material);
            const side = s.doubleSided ? THREE.DoubleSide : material.userData.fileSide;
            if (material.side !== side) { material.side = side; material.needsUpdate = true; }
            applyLayers(material, s.layers, strengths);
            for (const slot of TEXTURE_SLOTS) {
              applyFiltering(material.userData.full?.[slot] ?? material[slot],
                s.textureFilter, maxAnisotropy);
            }
          }
          return s.view === 'final' ? material : this.debugView(material, s.view);
        });
        mesh.material = mesh.userData.multi ? drawn : drawn[0];
      });
      this.renderMaterials = renders;
    }

    for (const material of this.renderMaterials) {
      applyLayers(material, s.layers, strengths);
      if (material.isMeshPhongMaterial) {
        material.shininess = s.shininess;
        material.specular.setScalar(s.specular);
      }
    }
  }

  debugView(material, view) {
    let debug = this.debugCache.get(material);
    if (!debug) {
      debug = debugMaterial(material, view);
      this.debugCache.set(material, debug);
    }
    return debug;
  }

  /**
   * How many of the model's materials use each layer, for the panel: a switch
   * nothing uses is shown greyed out rather than silently doing nothing.
   */
  layerCounts() {
    const counts = Object.fromEntries(LAYERS.map((l) => [l.key, 0]));
    for (const material of this.renderMaterials) {
      for (const key of layersOf(material)) counts[key]++;
    }
    return { counts, total: this.renderMaterials.size, shading: this.shadingInUse };
  }

  /**
   * The graphics card's limits that decide whether a feature can work, read
   * from what three.js already measured. main.js turns these into notes and
   * disabled options rather than letting a feature fail silently.
   */
  capabilities() {
    const renderer = this.renderer;
    const extensions = renderer.extensions;
    const attributes = renderer.getContext().getContextAttributes?.() ?? {};
    return {
      halfFloat: extensions.has('EXT_color_buffer_half_float')
        || extensions.has('EXT_color_buffer_float'),
      maxTextureSize: renderer.capabilities.maxTextureSize,
      maxSamples: renderer.capabilities.maxSamples,
      maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
      antialias: !!attributes.antialias,
    };
  }

  /**
   * The largest texture side in the model, if it is more than the graphics
   * card accepts, else 0. three.js scales such textures down to fit without
   * a word, so this is the only way to say so. Checked on demand rather than
   * at load: some formats' textures finish arriving after the model does.
   */
  oversizedTexture() {
    if (!this.model) return 0;
    const limit = this.caps.maxTextureSize;
    let largest = 0;
    this.model.traverse((child) => {
      if (!child.isMesh) return;
      for (const material of child.userData.sources ?? []) {
        for (const slot of TEXTURE_SLOTS) {
          const image = material?.[slot]?.image;
          if (!image) continue;
          const side = Math.max(image.width ?? 0, image.height ?? 0);
          if (side > largest) largest = side;
        }
      }
    });
    return largest > limit ? largest : 0;
  }

  /**
   * Python adds rim_light * (1 - N·V)^3 * (0.4 + 0.6*albedo) after lighting.
   * There is no three.js light that does this, so patch it into the shader.
   * Every variable it reads exists in the Phong and the physical shaders
   * alike, so both paths get the same rim.
   */
  attachRim(material) {
    if (material.userData.rimAttached) return;
    material.userData.rimAttached = true;
    const rim = this.rim;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRim = rim;
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float uRim;\nvoid main() {')
        .replace(
          '#include <opaque_fragment>',
          `{
            float rimF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
            outgoingLight += uRim * pow(rimF, 3.0) * (0.4 + 0.6 * diffuseColor.rgb);
          }
          #include <opaque_fragment>`
        );
    };
    material.needsUpdate = true;
  }

  /** Push the full settings object through to the scene. */
  applySettings(settings) {
    this.settings = { ...this.settings, ...settings };
    const s = this.settings;

    // three.js uses physical units: its diffuse BRDF divides albedo by PI, so a
    // light of intensity 1 lands at 1/PI of what Python's non-physical shading
    // produces. Scaling by PI makes the two match. (The rim term is added
    // directly in the shader, so it is deliberately not scaled.)
    const bright = Math.max(0, s.brightness ?? 1);
    this.keyLight.intensity = s.keyLight * bright * Math.PI;
    this.fillLight.intensity = s.fillLight * bright * Math.PI;
    this.rim.value = s.rimLight * bright;

    // Colours. White is the old behaviour; the ground keeps its 0.65 ratio to
    // the sky so a tinted ambient is still Python's hemisphere, just tinted.
    this.keyLight.color.set(s.keyColor);
    this.fillLight.color.set(s.fillColor);
    this.hemi.color.set(s.ambientColor);
    this.hemi.groundColor.set(s.ambientColor).multiplyScalar(0.65);

    this.syncMaterials(s);

    // The environment is for physical materials only. three.js would hand it
    // to Phong materials too, as a mirror reflection mixed into their colour,
    // and every Classic model would change — so on that path there is none.
    const physical = this.shadingInUse === 'physical';
    const lit = physical && s.environment !== 'none' && this.caps.halfFloat;
    this.scene.environment = lit ? this.environments.get(s.environment) : null;

    // The hemisphere is Python's stand-in for light arriving from everywhere,
    // and an environment *is* light arriving from everywhere. Keeping both
    // counted the ambient twice and washed every painted surface out, so
    // while an environment lights the model it replaces the hemisphere.
    this.hemi.intensity = lit ? 0 : s.ambient * bright * Math.PI;
    this.scene.environmentIntensity = s.envIntensity * bright;
    this.scene.environmentRotation.set(0, THREE.MathUtils.degToRad(s.envRotation), 0);

    const tone = s.toneMapping === 'auto' ? (physical ? 'neutral' : 'none') : s.toneMapping;
    this.renderer.toneMapping = TONE_MAPPINGS[tone] ?? THREE.NoToneMapping;
    this.renderer.toneMappingExposure = s.exposure;

    this.applyShadows(s);

    // User position/rotation, applied around the rotation point.
    this.adjust.position.set(s.posX, s.posY, s.posZ);
    this.adjust.rotation.set(
      THREE.MathUtils.degToRad(s.pitch),
      THREE.MathUtils.degToRad(s.yaw),
      THREE.MathUtils.degToRad(s.roll),
    );

    // Up-axis correction: rotate the model so its own up points along world +Y.
    this.pivot.rotation.set(0, 0, 0);
    if (s.upAxis === 'Z') this.pivot.rotateX(-Math.PI / 2);
    else if (s.upAxis === 'X') this.pivot.rotateZ(Math.PI / 2);
    this.pivot.updateMatrix();

    this.resize();
    this.placeGround();
  }

  /**
   * Shadows from the key light: on the model itself, and optionally on a
   * floor. Casting and receiving are per-mesh flags, so they are only walked
   * when the choice changes.
   */
  applyShadows(s) {
    const casting = s.shadows === 'model' || s.shadows === 'ground';
    this.keyLight.castShadow = casting;
    const key = `${casting}`;
    if (key === this.shadowKey || !this.model) return;
    this.shadowKey = key;
    this.eachMesh((mesh) => {
      mesh.castShadow = casting;
      mesh.receiveShadow = casting;
    });
  }

  /** Size the drawing buffer to the output resolution times supersampling. */
  resize() {
    const s = this.settings;
    const ss = Math.max(1, Math.min(3, s.supersample | 0));
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(s.width * ss, s.height * ss, false);
    this.updateCamera();
  }

  /**
   * Frame the unit bounding sphere — a direct port of _camera() in render.py.
   * Distance comes from the sphere so framing never changes as the model spins.
   */
  updateCamera() {
    const s = this.settings;
    const aspect = s.width / s.height;
    const radius = 1.0;
    const margin = 1.06 / Math.max(0.01, s.zoom);
    // A typed field of view reaches 180, which the camera cannot use: at
    // exactly 180 the projection's tan(fov/2) is infinite and nothing draws.
    // A tenth of a degree short is indistinguishable and always finite.
    const fov = THREE.MathUtils.degToRad(Math.min(179.9, Math.max(1, s.fov)));
    // Fit the tighter of the two axes: a portrait frame needs more distance.
    const half = Math.atan(Math.min(Math.tan(fov / 2), Math.tan(fov / 2) * aspect));
    const dist = (radius * margin) / Math.sin(half);
    // The slider reaches a true 90, but the camera cannot: straight down the
    // up axis leaves lookAt() with no way to orient the horizon, and the view
    // flips or goes blank. A tenth of a degree short is invisible and safe.
    const elev = THREE.MathUtils.degToRad(Math.max(-89.9, Math.min(89.9, s.elevation)));

    // Half the visible height at the origin plane. Used to keep the axis guide
    // inside the frame; a vertical line foreshortens as the camera is raised,
    // so this is a conservative (safe) bound at any elevation.
    this.frameHalfHeight = Math.tan(fov / 2) * dist;

    // How far a vertex can travel toward or away from the lens once the user has
    // offset the model. setModel() normalises the model into a unit sphere about
    // the adjust group's origin, so every vertex stays within `radius` of that
    // point, and the group itself sits at most hypot(posX, posY, posZ) from the
    // pivot centre — a distance the spin and the up-axis correction can turn to
    // point straight at the camera. So this bound is exact, not a guess, and
    // rotations need no term of their own (a sphere is rotation-invariant).
    const reach = Math.hypot(s.posX, s.posY, s.posZ);

    this.camera.fov = THREE.MathUtils.radToDeg(fov);
    this.camera.aspect = aspect;
    // The depth planes must follow that offset. Fitted to the origin alone they
    // give a *fixed* 1.05 radii of clearance however the camera is placed, so
    // FOV and Zoom never clip (they move the near plane with the camera) while a
    // modest Move Z slices the model away and then loses it entirely.
    //
    // Widening is close to free: near/far feed nothing but the projection
    // matrix — no shadow maps, no fog, no depth-based shading — so this changes
    // what is clipped and nothing about how anything looks. It costs a little
    // depth precision, against which a 24-bit buffer has orders of magnitude of
    // headroom at these ranges. With every Position control at 0, `reach` is 0
    // and both planes come out exactly as they did before.
    //
    // The floor keeps the near:far ratio sane. Geometry nearer than that is
    // inside the lens, where no choice of plane can draw it sensibly — reachable
    // by combining a very wide FOV (which parks the camera close) with a large
    // offset, and cured by zooming out.
    this.camera.near = Math.max(dist * 0.01, dist - (radius * 1.05 + reach));
    this.camera.far = dist + radius * 2.0 + reach;
    this.camera.position.set(0, Math.sin(elev) * dist, Math.cos(elev) * dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.placeLights();
  }

  /** Point the model at a given spin angle, in degrees. */
  setAngle(degrees) {
    const total = THREE.MathUtils.degToRad(this.settings.startAngle + degrees);
    // Rebuild from scratch each time: apply the up-axis correction, then spin
    // about world Y. Accumulating rotations here would drift over a long loop.
    const s = this.settings;
    this.pivot.rotation.set(0, 0, 0);
    if (s.upAxis === 'Z') this.pivot.rotateX(-Math.PI / 2);
    else if (s.upAxis === 'X') this.pivot.rotateZ(Math.PI / 2);
    this.pivot.rotateOnWorldAxis(WORLD_UP, total);
  }

  /**
   * Draw the model, and only the model.
   *
   * The clear is always fully transparent, whatever `settings.background` and
   * `settings.transparent` say. The renderer used to paint the background
   * itself by clearing to the chosen colour, which made the background the
   * bottom-most thing in the image and left nothing that could ever be put
   * underneath it — the caption's "Behind" mode would have been buried by an
   * opaque background with no way out.
   *
   * So the background is a layer now, painted by whoever is composing the
   * frame: a div under the canvas in the preview, a fillRect in
   * makeResolver(). `settings.transparent` still decides *whether* that layer
   * is painted; it just no longer decides it here.
   *
   * Compositing the model over the colour afterwards is the same source-over
   * operation the GL clear was doing, one layer later, so the result is
   * unchanged down to the antialiased edge.
   */
  render() {
    this.renderer.setClearColor(BLACK, 0);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Free everything the current model owns on the GPU: its geometry, the
   * file's materials, every material made from them, and every texture any
   * of those hold — including maps a layer switch has taken off for now.
   */
  disposeModel() {
    if (!this.model) return;
    const materials = new Set(this.debugCache.values());
    for (const cache of this.converted.values()) for (const m of cache.values()) materials.add(m);
    this.model.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry?.dispose?.();
      for (const m of child.userData.sources ?? []) materials.add(m);
      for (const m of materialsOf(child)) materials.add(m);
    });
    const textures = new Set();
    for (const material of materials) {
      if (!material) continue;
      for (const slot of TEXTURE_SLOTS) {
        if (material[slot]?.isTexture) textures.add(material[slot]);
        if (material.userData?.full?.[slot]?.isTexture) textures.add(material.userData.full[slot]);
      }
      material.dispose();
    }
    for (const texture of textures) texture.dispose();
    this.converted = new Map();
    this.debugCache = new Map();
    this.renderMaterials = new Set();
  }

  dispose() {
    this.disposeModel();
    this.environments.dispose();
    this.renderer.dispose();
  }
}

/**
 * Largest distance from `centre` to any vertex, in world space.
 * This is the bounding sphere the desktop app uses, and framing to it is what
 * keeps the model the same size at every angle.
 */
function maxRadiusFromPoint(root, centre) {
  const vertex = new THREE.Vector3();
  let maxSq = 0;
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    const position = child.isMesh && child.geometry?.attributes?.position;
    if (!position) return;
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld);
      maxSq = Math.max(maxSq, vertex.distanceToSquared(centre));
    }
  });
  return Math.sqrt(maxSq);
}

/** Every material on a mesh, whether it holds one or an array of them. */
function materialsOf(mesh) {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}
