<img src="content/Funee%20Spinning%20GIF%20Maker%20Big.webp" alt="Funee Spinning GIF Maker" width="826">

Drop in a 3D model, get a perfectly looping spin animation. Export it as a GIF,
animated WebP, APNG, or a ZIP of frames.

Everything runs in your browser. Models are never uploaded, there's no account,
no build step and no backend — it's a static site.

**[Open the app →](https://blackmetalforest.github.io/Funee-Spinning-GIF/)**

## What it does

- Loads 11 model formats, including textured GLB and FBX
- Opens **.zip bundles** — finds the model inside, textures and all, even
  when it is buried in a second archive
- Renders on the GPU with three.js
- Produces a **seamless loop** — frame *i* sits at exactly `i × 360/N` degrees,
  so the last frame steps into the first with no repeated pose
- Takes a spin speed and a frame rate and works out the frame count for you,
  flagging it when that count gets expensive. Either one at zero is a stopped
  spin, which exports as a single still
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
— plus Draco- and Meshopt-compressed glTF, and **`.zip`**.

A lone `.glb`, `.usdz`, `.fbx`, `.vox` or `.3mf` carries its textures inside the
file and always works. A lone `.obj`, `.gltf`, `.dae` or `.3ds` keeps them in
separate files a browser file picker cannot follow, so it loads untextured —
**drop the zip instead** and they come with it.

Not supported: `.off` (no three.js loader), VRML (needs a large extra parser),
KTX2/Basis textures, and `.rar` or `.7z` archives — the app says so when it
finds one rather than failing silently.

## Zipped models

Textured models are almost never one file. The usual shape, and the one every
model-sharing site produces, is a bundle:

```
source/Model.fbx          ← sometimes itself a nested .zip
textures/Model_BaseColor.png
license.txt
```

Drop that zip in and [`src/archive.js`](src/archive.js) flattens it — archives
inside archives included, up to four deep — picks the most promising model in
it, and answers every texture the model asks for out of the archive instead of
the network. Only files that could matter are decompressed, so a 59 MB camera
bundle loads without ever inflating the 14 MB `.blend` sitting next to the
model.

**Which model.** Where a bundle holds several, the format carrying the most
material information wins — glTF and FBX over OBJ, OBJ over STL — then the one
nearest the top, then the biggest. Files that are obviously not the deliverable
(`_LOD3`, `collision`, `backup`) go to the back. The info line names what was
chosen and how many models it chose from.

**Which texture.** Matching is tried strictest-first, and only gets loose once
the strict forms fail:

1. the exact path, relative to the model's own folder and then to the archive root
2. the longest matching path *suffix*, compared segment by segment — this is what
   tells a `Textures_4k/COL.png` apart from the `Textures_2k/COL.png` beside it
3. the filename alone: exact, then ignoring separators, then ignoring the extension

Step 3 is the one that earns its keep. Packagers rewrite names on the way into a
zip: one bundle here has an FBX asking for `DesertEagle_Desert Eagle_BaseColor.png`
while the zip actually contains `DesertEagle_Desert_Eagle_BaseColor.png`. Reducing
both to their alphanumerics makes them the same string. The same step absorbs
Windows authoring paths (`W:\3D Graphics\...\Textures\Foo.png`), `.tga` files
re-encoded as `.png`, and the `#` that several bundles start their filenames with
— which is why a fragment can never simply be stripped off a reference.

**When the model names nothing at all.** Some bundles ship a model whose texture
references are simply gone: an OBJ whose `.mtl` was left out of the zip, or a
Collada file exported with no `<library_images>`, sitting next to a `textures/`
folder that plainly belongs to it. Nothing in either file format connects the
two. As a last resort the leftover images are matched to material names, and
where that is what happened the info line says **"matched by name"** — because a
guess should look different from a fact. It stays conservative: textures whose
filenames mark them as normal, roughness, metalness, AO or opacity maps are
never offered as colour, a mesh with no UVs is skipped, and a match needs either
a clear name overlap or an archive that leaves exactly one possibility.

**When the first model will not parse.** Ripped bundles routinely ship a Collada
file no parser will touch beside an OBJ that loads perfectly. With no explicit
choice, the ranked models are tried in order until one works, and the info line
says what was skipped and why. Once you *have* chosen a model, only that one is
tried — quietly loading a different one would make the choice a lie.

**What still cannot work.** An OBJ whose `.mtl` is missing *and* whose material
names share nothing with the texture filenames (`Material__25` against
`Main_Defuse.jpg`) has no recoverable link, and loads untextured. A PLY cannot
reference a texture at all. A `.rar` inside a zip cannot be opened — there is no
small pure-JS unrar. Each of these is reported rather than passed off as success.

## Advanced: mixing and matching

Some bundles are genuinely ambiguous — ten models, five material files, a
hundred loose textures — and no amount of ranking makes that decision for you.
An **Advanced** disclosure at the foot of the 3D model section, under the info
line, lets you pick the combination by hand.

A row appears only where there is a real question:

| | |
| --- | --- |
| **Model** | which model in the zip to load |
| **Texture setup** | which material file positions the textures |
| **Texture** | force one texture onto the whole model |

Choosing a model re-derives the rest, which is what makes the two common cases
automatic. A `.dae`, `.fbx` or `.glb` describes its own materials, so the
Texture setup row collapses to "Built into *that file*" and disappears. An
`.obj` keeps them in a sidecar, so the row lists every `.mtl` in the archive and
pre-selects the one that matches — pick `Adeleine_High.obj` and you get
`Adeleine_High.mtl`, pick `Adeleine_Low.obj` and you get `Adeleine_Low.mtl`.

The **Texture** row is the blunt instrument, and sometimes the right one: a rip
whose material data is wrong is often a single atlas the whole model was meant
to share, and choosing that file by hand beats any amount of guessing.

### Replacing textures

While **Texture** is left on "From the material data", a numbered list of
replacers appears:

```
── TEXTURE REPLACER #1
   Replace   FaceSide1 — GoemonFace1.png   ▾
   With      GoemonFace4.png               ▾
── TEXTURE REPLACER #2
   Replace   Nothing                       ▾
   With      Nothing                       ▾
```

Both boxes start at *Nothing* and nothing happens until both are set. This is
the swap-a-face case: retro character folders routinely ship several
expressions side by side, and the material data picks one of them.

**Filling a replacer opens another below it**, so there is no limit — Goemon's
face is split across `FaceSide1` and `FaceSide2`, and changing his expression
means changing both. A material already spoken for is dropped from every other
replacer's list, so two of them can never fight over the same one. Setting a
Replace box back to *Nothing* removes that replacer and renumbers the rest.

Each entry in **Replace** is labelled with the material name *and the file it is
currently showing* — `FaceSide1 — GoemonFace1.png`. The filename is the half
that makes the list usable, because rip material names are cryptic
(`_153f42ee_dds`).

Every replacement **inherits the sampler settings of the texture it replaces** —
`flipY`, wrap mode, repeat and offset. Wrap mode is the one that matters: these
models lean on repeat and mirrored wrapping, and a replacement that quietly
reset it would tile or clamp wrongly.

Setting **Replace** on its own does not reload — it would throw away the box you
just set before you could reach the second one. Only a *complete* pair changes
what is on screen. Changing **Model** or **Texture setup** clears every
replacer, since the materials they named may not exist in the new one.

Labels come from mapping each loaded texture back to its archive entry through
the blob URL it was served on, which works for OBJ/MTL, Collada, FBX and 3DS.
glTF is the exception: it decodes to an `ImageBitmap`, which carries no URL, so
those entries show the material name alone. Replacing still works there.

## What gets repaired on the way in

Ripped game models arrive with a small set of recurring defects. Each of these
only ever touches a model that would otherwise render wrongly, so a file that is
already correct passes through untouched.

**Per-group materials.** A mesh can carry an *array* of materials, one per
geometry group, and OBJLoader builds exactly that whenever a file uses more than
one `usemtl` — which is most of the time for a ripped model. Collapsing that
array to its first entry paints every group with the first texture: the whole
model wearing one patch of its atlas. Keeping the array is the single change
that fixed the most models here.

**Crushed tints.** The scene multiplies a material's colour by its texture, so a
base colour of near-black hides the texture completely. FBX exporters write
exactly that. Only tints dark enough to crush any texture to black are touched,
and only where there is a texture for them to crush.

**Colour space.** A colour map holds sRGB data by definition, but ColladaLoader
sets no colour space at all, which renders washed out.

Two things are deliberately *not* repaired, because there is no honest rule for
them. **Vertex colours** are ambiguous in these exports — sometimes they carry
the model's actual colour, sometimes baked shading that double-darkens the
texture it multiplies — so they are applied as the file asks and noted in the
info line. And where a bundle ships several exports of the same model, only an
obvious derived variant (`_bake`, `_LOD3`, `collision`) is pushed down the
ranking; choosing between the rest is what the Advanced panel is for.

## Position

An optional **Position** section moves the model around the rotation point —
X/Y/Z translation plus pitch/yaw/roll. Most models need none of it, so every
control defaults to zero.

Translation is in **bounding-sphere radii**: the model is normalised to radius 1
on load, so 1.0 shifts it by its own radius whatever its real-world scale.
Rotations apply in YXZ order (yaw, then pitch, then roll).

The camera's depth planes follow the offset, so moving the model toward the lens
does not clip it. They used to be fitted to the origin alone, which gave a fixed
1.05 radii of clearance no matter where the camera was — Field of view and Zoom
never clipped, because they move the near plane along with the camera, but a
Move Z of much past 0.75 sliced the model apart and then lost it altogether.
Above roughly FOV 100 the camera itself sits close enough that a large Move Z
puts the model through the lens, which no clipping plane can render; **Zoom**
out pushes the camera back and gives the full range again.

The adjustment is applied *inside* the spin pivot, so the rotation point stays
at the origin: translating displaces the model relative to that point and it
orbits as it spins, rather than just sliding across the frame. Framing does not
follow the model, so a large offset will run outside the frame — the **Image
border** checkbox shows where the crop falls, and **Zoom** compensates. An
off-axis model also sweeps a wider circle when spinning than it appears to at
frame 0.

**Up axis** heads the section: it corrects a model authored Z-up or X-up before
any of the adjustments below it apply.

**Show center axis** draws a red arrow along the rotation axis so you can see
whether the model sits on it. It also flashes up on its own whenever a Position
control moves — two seconds at full strength, then a two-second fade — so the
reference is there exactly while it is being used and gone the rest of the time.
The checkbox pins it on permanently and overrides the flash.

Its length is fixed **once, when the model loads** — tip clear of the top, base
just below the bottom — and clamped to stay inside the frame, because a clipped
cone reads as a blunt bar rather than an arrow. Keeping it fixed is what makes
it a useful reference: a re-measured arrow changes size as the model moves,
which is exactly the comparison you are trying to make. It is preview-only and
is forced off while frames are rendered, so it can never appear in an export.

Note that **Yaw and Start rotation look identical while the model is centred** —
both turn it about Y. They diverge once X/Z is non-zero: yaw turns the model in
place, Start rotation carries it around the pivot.

## Preview

A **Preview** checkbox under the render view (off by default) spins the model
live while every other control stays adjustable. It sits with **Center axis**
and **Image border**: the three toggles that change what the preview shows
without changing a thing about the export.

It replays the encoder's own delay table rather than spinning smoothly, so what
you see is the cadence the file will have — including the judder GIF's 10 ms
grid introduces. At 0.25 rounds/s across 48 frames the ideal 83.33 ms per frame
is stored as an alternating 80/90 ms, and the preview shows that. It uses the
GIF grid because it is the coarsest, and it is already the one the loop summary
quotes.

The frame rate cannot be *set* — a browser paints at the display's refresh rate,
normally 60 Hz — so playback is driven from that delay table against
`performance.now()`. Two consequences:

- **Above ~60 fps not every frame can be shown.** Frames are dropped rather than
  the spin slowing down, so rotation speed and loop length stay correct and only
  smoothness suffers. The rate beside the checkbox is what was actually
  achieved, not what was asked for. (Past 50 fps a GIF will not play at the
  requested rate in most viewers either — hence the red warning on the loop
  summary — so a preview bounded by the display is closer to the truth.)
- **Frame changes land on a vsync boundary**, up to ~16.7 ms from the exact
  delay. That is inherent to animation in a browser and applies to real GIF
  playback too.

Playback is a lookup against the clock, not a frame counter, which is what keeps
it honest when it cannot keep up: a backgrounded tab (where the browser stops
animation callbacks outright), a target above the refresh rate, or one slow
frame all resolve to the pose belonging to the current time instead of falling
behind by whatever was missed. A single rendering loop serves both the spin and
the centre-axis fade, and draws only when something actually changed — at 1 fps
that is one draw per second, and a 1-frame still draws once and then stops.

## Output formats

| Format | Colour | Transparency | Timing | Notes |
| --- | --- | --- | --- | --- |
| **GIF** | 256 colours, one shared palette | 1-bit, hard edges | 10 ms grid | Most compatible |
| **WebP** | Full | Smooth alpha | 1 ms | Smallest files |
| **APNG** | Full, lossless | Smooth alpha | 1 ms | Best quality |
| **ZIP** | Lossless PNGs | Smooth alpha | — | For After Effects, Blender, editors |

GIF uses a **single palette derived from all frames**. Quantising each frame
separately makes flat surfaces shimmer as the palette is re-derived per frame.
**Dither GIF**, on by default, adds Floyd–Steinberg error diffusion, which
smooths gradients across the 256-colour limit at the cost of a noisier, larger
file. Turn it off for flat-shaded models, where the banding it fixes does not
arise and the added noise costs file size for nothing. gifenc has no dithering
of its own, so it is implemented in `src/encoders/gif.js`.

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

**In portrait the preview area is square**, sized from its own width rather than
being a fixed slice of screen height. A phone held upright gives a view area far
wider than it is tall, which cropped the top and bottom off a square render — and
renders are square by default. It is capped at 55vh so the settings list is still
visible below it on short screens.

The canvas itself also carries `min-width: 0; min-height: 0`. As a grid item it
otherwise takes an automatic minimum size equal to the full render resolution,
which outranks `max-height: 100%` and lets it overflow any stage shorter than the
render — the same crop, seen on landscape phones and small desktop windows.

Two touch conflicts are handled explicitly. The canvas uses
`touch-action: none` so dragging orbits the model instead of scrolling the page.
The sliders use `touch-action: pan-y` so a vertical swipe scrolls even when it
starts on a slider, and every control row leaves a 56 px strip clear down the
right-hand side as a guaranteed-safe place to put a thumb.

Clicking the wordmark plays a short theme.

## Tests

```bash
node tests/run.mjs
```

Covers the logic that needs no DOM: delay rounding (including the half-to-even
edge case), loop angles, the PNG encoder, both muxers, and the archive hunter —
path handling, texture-name classification, model ranking, the lookup chain and
the .mtl transparency repair, against zips built in memory.

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
src/archive.js        the zip hunter: flatten, pick a model, find its textures
src/mtl-fix.js        one .mtl repair, kept DOM-free so it can be tested
src/capture.js        the frame store
src/encoders/
  timing.js           delay grid + loop angles
  png.js              fast PNG encoder + shared chunk helpers
  gif.js              gifenc with one global palette
  webp.js             animated WebP muxer
  apng.js             APNG muxer
  frames.js           ZIP of frames
vendor/               three.js r186, Draco, gifenc, fflate (all pinned)
content/              wordmarks, the theme clip, and a small test model
```

## Credits

Rendering by [three.js](https://threejs.org). GIF quantisation by
[gifenc](https://github.com/mattdesl/gifenc). Deflate by
[fflate](https://github.com/101arrowz/fflate).
