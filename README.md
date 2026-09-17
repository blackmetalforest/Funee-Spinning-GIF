# Funee Spinning GIF Maker

Drop in a 3D model, get a perfectly looping spin animation. Export it as a GIF,
animated WebP, APNG, or a ZIP of frames.

Everything runs in your browser. Models are never uploaded, there's no account,
no build step and no backend — it's a static site.

**[Open the app →](https://blackmetalforest.github.io/Funee-Spinning-GIF/)**

## What it does

- Loads 11 model formats, including textured GLB and FBX
- Renders on the GPU with three.js
- Produces a **seamless loop** — frame *i* sits at exactly `i × 360/N` degrees,
  so the last frame steps into the first with no repeated pose
- Keeps **exact timing** — 48 frames at 0.25 rounds/s totals 4.000 s, not 3.97
- Exports with real transparency

## Running it locally

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. A static server is needed — ES modules don't
load over `file://`.

## Supported input

`.glb` `.gltf` `.fbx` `.obj` `.stl` `.ply` `.dae` `.3mf` `.usdz` `.vox` `.3ds`
— plus Draco- and Meshopt-compressed glTF.

**Single-file formats work best.** GLB, FBX, USDZ, VOX and 3MF carry their
textures inside the file. OBJ, DAE and 3DS usually reference textures as
separate files, which a browser file picker can't follow, so they load
untextured — converting to GLB fixes it. The app tells you when it spots this.

Not supported: `.off` (no three.js loader), VRML (needs a large extra parser),
and KTX2/Basis textures.

## Output formats

| Format | Colour | Transparency | Timing | Notes |
| --- | --- | --- | --- | --- |
| **GIF** | 256 colours, one shared palette | 1-bit, hard edges | 10 ms grid | Most compatible |
| **WebP** | Full | Smooth alpha | 1 ms | Smallest files |
| **APNG** | Full, lossless | Smooth alpha | 1 ms | Best quality |
| **ZIP** | Lossless PNGs | Smooth alpha | — | For After Effects, Blender, editors |

GIF uses a **single palette derived from all frames**. Quantising each frame
separately makes flat surfaces shimmer as the palette is re-derived per frame.
An optional **Dither GIF** checkbox adds Floyd–Steinberg error diffusion, which
smooths gradients across the 256-colour limit at the cost of a noisier, larger
file. gifenc has no dithering of its own, so it is implemented in
`src/encoders/gif.js`.

## How it works

### Render first, assemble on save

Frames are rendered once into a **frame store** of individual PNGs; the export
formats are built from that store only when you hit Save. This matters:

- **Memory.** 48 frames at 1000×1000 is ~192 MB as raw pixels and would crash a
  phone. As encoded PNGs it's single-digit MB.
- **One render, many formats.** Export a GIF *and* a WebP *and* an APNG without
  re-rendering.
- **Lossless intermediates.** Because the store is PNG, GIF quantisation sees
  exact pixels and APNG export needs no re-encoding at all.

### Two things are deliberately hand-written

**The PNG encoder** (`src/encoders/png.js`). Chrome's built-in canvas PNG
encoder measured **~1020 ms for a single 160×160 frame** — versus ~39 ms for
the same frame as WebP. At a second per frame the frame store would be
unusable, so PNG is written directly through fflate instead. Measured result:
about **83 ms per frame** at 480×480.

**The animated WebP and APNG muxers** (`src/encoders/webp.js`, `apng.js`).
Browsers encode *still* WebP natively but can't join stills into an animation,
and the npm options either only handle still images (`webp-wasm`) or depend on
Node's `fs` (`node-webpmux`). Both formats are pure container assembly, so the
muxers are hand-written — no WASM anywhere. That also sidesteps a GitHub Pages
limitation: Pages can't send COOP/COEP headers, so `SharedArrayBuffer` and
threaded WASM aren't available.

### Three details that make the loop work

- **Delay rounding** carries its error forward, so the revolution totals exactly
  `1000/rps` ms. This includes half-to-even rounding — `Math.round(12.5)` is 13
  where round-half-to-even gives 12, which would shift a frame by 10 ms.
- **Frame angles** put frame *i* at exactly `i × 360/N`, so there's no repeated
  pose at the wrap.
- **Bounding-sphere framing** takes camera distance from the model's true
  bounding sphere, not its box. Frame to the box and the model visibly pulses as
  it turns.

## Layout

Desktop puts the settings in a left column with the render view filling the
rest. On phones and tablets (`max-width: 860px` or `pointer: coarse`) it flips:
the render view sits on top and stays put while the settings scroll underneath,
so adjusting a slider always shows its effect.

Two touch conflicts are handled explicitly. The canvas uses
`touch-action: none` so dragging orbits the model instead of scrolling the page.
The sliders use `touch-action: pan-y` so a vertical swipe scrolls even when it
starts on a slider, and every control row leaves a 56 px strip clear down the
right-hand side as a guaranteed-safe place to put a thumb.

## Tests

```bash
node tests/run.mjs
```

Covers the logic that needs no DOM: delay rounding (including the half-to-even
edge case), loop angles, the PNG encoder and both muxers.

`tests/collect_server.py` is a static server that also accepts POSTs, so an
automated browser run can hand exported files back and have their frame counts
and timing verified.

## Deploying

`.github/workflows/pages.yml` runs the tests and publishes the repo to GitHub
Pages on every push to `main`. Enable it once under
**Settings → Pages → Source → GitHub Actions**.

## Project layout

```
index.html            markup and the import map
src/style.css         layout, including the mobile breakpoint
src/main.js           wiring: controls -> scene -> frame store -> exports
src/scene.js          three.js scene, framing, lights
src/loaders.js        format dispatch
src/capture.js        the frame store
src/encoders/
  timing.js           delay grid + loop angles
  png.js              fast PNG encoder + shared chunk helpers
  gif.js              gifenc with one global palette
  webp.js             animated WebP muxer
  apng.js             APNG muxer
  frames.js           ZIP of frames
vendor/               three.js r186, Draco, gifenc, fflate (all pinned)
sample.glb            small test model so the page has something to show
```

## Credits

Rendering by [three.js](https://threejs.org). GIF quantisation by
[gifenc](https://github.com/mattdesl/gifenc). Deflate by
[fflate](https://github.com/101arrowz/fflate).
