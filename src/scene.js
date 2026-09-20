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
 */

import * as THREE from '../vendor/three/three.module.js';

export const UP_AXES = ['Y', 'Z', 'X'];

// Hoisted: setAngle() runs once per frame of the live preview, and allocating a
// vector per call is pure garbage for the collector to chase.
const WORLD_UP = new THREE.Vector3(0, 1, 0);

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
  shadeTexture: true,
  ambient: 0.30,
  keyLight: 0.95,
  fillLight: 0.32,
  rimLight: 0.0,
  shininess: 40,
  specular: 0.0,
  smoothAngle: 40,
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
    this.rimUniforms = [];
    this.buildLights();
    this.buildAxisArrow();
  }

  /**
   * Lights that ride with the camera, matching Python's _shade().
   *
   * Python: ambient * (0.65 + 0.35 * (0.5 + 0.5*ny)). A HemisphereLight
   * computes mix(ground, sky, 0.5 + 0.5*ny) * intensity, so ground = 0.65 and
   * sky = 1.0 reproduces it exactly.
   */
  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    this.hemi.groundColor.setScalar(0.65);
    this.scene.add(this.hemi);

    // Directions from Python, expressed in camera space: the camera looks down
    // -Z, so +Z is toward the viewer, +X is right and +Y is up.
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1);
    this.keyLight.position.set(0.55, 0.62, 1).normalize();
    this.camera.add(this.keyLight);
    this.camera.add(this.keyLight.target);
    this.keyLight.target.position.set(0, 0, 0);

    this.fillLight = new THREE.DirectionalLight(0xffffff, 1);
    this.fillLight.position.set(-0.85, -0.10, 1).normalize();
    this.camera.add(this.fillLight);
    this.camera.add(this.fillLight.target);
    this.fillLight.target.position.set(0, 0, 0);
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
      disposeTree(this.model);
    }
    this.model = object;
    this.adjust.add(object);

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

    this.applyMaterials();
    this.applySettings(this.settings);

    // Fixed for the lifetime of this model: sized after applySettings so the
    // camera (and therefore the frame clamp) is up to date, but measured from
    // the model alone so user position offsets never feed into it.
    this.sizeAxisArrow();
    this.axisArrow.visible = this.axisRequested;
  }

  /**
   * Override materials with MeshPhongMaterial so the desktop app's lighting
   * controls keep their meaning (Phong *is* Blinn-Phong), and inject the rim
   * term three.js has no equivalent for.
   *
   * A mesh may carry an *array* of materials, one per geometry group, and that
   * has to survive: OBJLoader builds exactly that shape whenever a file uses
   * more than one `usemtl`, which is most of the time for a ripped game model.
   * Collapsing the array to its first entry paints every group with the first
   * texture — the whole model wearing one patch of its atlas, which is what
   * "the textures are in the wrong spot" looks like.
   */
  applyMaterials() {
    if (!this.model) return;
    this.rimUniforms = [];
    this.model.traverse((child) => {
      if (!child.isMesh) return;
      const sources = materialsOf(child);
      const converted = sources.map((source) => this.toPhong(source, child));
      child.material = Array.isArray(child.material) ? converted : converted[0];
      if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals();
      child.castShadow = false;
      child.receiveShadow = false;
    });
  }

  /** One source material, restated as the Phong the lighting controls drive. */
  toPhong(source, mesh) {
    const phong = new THREE.MeshPhongMaterial({
      name: source?.name ?? '',
      color: source?.color?.clone?.() ?? new THREE.Color(0xffffff),
      map: source?.map ?? null,
      vertexColors: !!mesh.geometry?.attributes?.color,
      transparent: !!source?.transparent,
      opacity: source?.opacity ?? 1,
      alphaTest: source?.alphaTest ?? 0,
      side: THREE.FrontSide,
      shininess: this.settings.shininess,
      specular: new THREE.Color().setScalar(this.settings.specular),
    });
    this.attachRim(phong);
    return phong;
  }

  /**
   * Python adds rim_light * (1 - N·V)^3 * (0.4 + 0.6*albedo) after lighting.
   * There is no three.js light that does this, so patch it into the shader.
   */
  attachRim(material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRim = { value: this.settings.rimLight };
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
      this.rimUniforms.push(shader.uniforms.uRim);
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
    this.hemi.intensity = s.ambient * Math.PI;
    this.keyLight.intensity = s.keyLight * Math.PI;
    this.fillLight.intensity = s.fillLight * Math.PI;
    for (const u of this.rimUniforms) u.value = s.rimLight;

    if (this.model) {
      this.model.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        for (const material of materialsOf(child)) {
          if (!material) continue;
          material.shininess = s.shininess;
          material.specular.setScalar(s.specular);
          material.side = THREE.DoubleSide;
          if (!s.shadeTexture && material.map) {
            material.userData.savedMap = material.map;
            material.map = null;
            material.needsUpdate = true;
          } else if (s.shadeTexture && !material.map && material.userData.savedMap) {
            material.map = material.userData.savedMap;
            material.needsUpdate = true;
          }
        }
      });
    }

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

  render() {
    const s = this.settings;
    const colour = new THREE.Color(s.background);
    this.renderer.setClearColor(colour, s.transparent ? 0 : 1);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.model) disposeTree(this.model);
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

function disposeTree(root) {
  root.traverse((child) => {
    if (child.isMesh) {
      child.geometry?.dispose?.();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        m?.map?.dispose?.();
        m?.dispose?.();
      }
    }
  });
}
