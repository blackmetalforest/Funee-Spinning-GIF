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

export const DEFAULT_SETTINGS = {
  width: 480,
  height: 480,
  supersample: 1,          // MSAA handles most of it; 2-3 for extra smoothing
  elevation: 20,
  startAngle: 0,
  upAxis: 'Y',
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

    this.model = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.rimUniforms = [];
    this.buildLights();
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
   * Swap in a loaded model: normalise it to a unit bounding sphere at the
   * origin, so every downstream calculation can assume radius 1.
   */
  setModel(object) {
    if (this.model) {
      this.pivot.remove(this.model);
      disposeTree(this.model);
    }
    this.model = object;
    this.pivot.add(object);

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

    this.applyMaterials();
    this.applySettings(this.settings);
  }

  /**
   * Override materials with MeshPhongMaterial so the desktop app's lighting
   * controls keep their meaning (Phong *is* Blinn-Phong), and inject the rim
   * term three.js has no equivalent for.
   */
  applyMaterials() {
    if (!this.model) return;
    this.rimUniforms = [];
    this.model.traverse((child) => {
      if (!child.isMesh) return;
      const source = Array.isArray(child.material) ? child.material[0] : child.material;
      const phong = new THREE.MeshPhongMaterial({
        color: source?.color?.clone?.() ?? new THREE.Color(0xffffff),
        map: source?.map ?? null,
        vertexColors: !!child.geometry?.attributes?.color,
        transparent: !!source?.transparent,
        opacity: source?.opacity ?? 1,
        alphaTest: source?.alphaTest ?? 0,
        side: THREE.FrontSide,
        shininess: this.settings.shininess,
        specular: new THREE.Color().setScalar(this.settings.specular),
      });
      if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals();
      this.attachRim(phong);
      child.material = phong;
      child.castShadow = false;
      child.receiveShadow = false;
    });
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
        child.material.shininess = s.shininess;
        child.material.specular.setScalar(s.specular);
        child.material.side = THREE.DoubleSide;
        if (!s.shadeTexture && child.material.map) {
          child.material.userData.savedMap = child.material.map;
          child.material.map = null;
          child.material.needsUpdate = true;
        } else if (s.shadeTexture && !child.material.map && child.material.userData.savedMap) {
          child.material.map = child.material.userData.savedMap;
          child.material.needsUpdate = true;
        }
      });
    }

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
    const margin = 1.06 / Math.max(0.2, s.zoom);
    const fov = THREE.MathUtils.degToRad(Math.min(160, Math.max(5, s.fov)));
    // Fit the tighter of the two axes: a portrait frame needs more distance.
    const half = Math.atan(Math.min(Math.tan(fov / 2), Math.tan(fov / 2) * aspect));
    const dist = (radius * margin) / Math.sin(half);
    const elev = THREE.MathUtils.degToRad(Math.max(-89.5, Math.min(89.5, s.elevation)));

    this.camera.fov = THREE.MathUtils.radToDeg(fov);
    this.camera.aspect = aspect;
    this.camera.near = Math.max(1e-4, dist - radius * 1.05);
    this.camera.far = dist + radius * 2.0;
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
    this.pivot.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), total);
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
