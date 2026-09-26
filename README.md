<img src="content/Funee%20Spinning%20GIF%20Maker%20Big.webp" alt="Funee Spinning GIF Maker" width="826">

**[Open the FSGM Webapp →](https://blackmetalforest.github.io/Funee-Spinning-GIF/)**

Drop in a 3D model, and configure a perfectly looping spinning animation. Export it as a GIF,
animated WebP, APNG, or a ZIP of frames.

Everything runs in your browser. Models are never uploaded, it's a static Webapp.

**[Open the FSGM Webapp →](https://blackmetalforest.github.io/Funee-Spinning-GIF/)**

## Where to get 3D models
**[Katamari Damacy Game Models](https://katamari.andrew-boylan.com/)** - the original website that inspired this FSGM Webapp.
Tip: change the Address → We Love Katamari

**[Sketchfab](https://sketchfab.com/feed)** - about 50% are free to download. choose the .glb version.

**[The Models Resource](https://models.spriters-resource.com/)** - Video Game Asset Rips. Some models struggle to load correctly in FSGM

**[Meshy.ai](https://www.meshy.ai/discover)** - AI Generated Models. Tip: Use a tool to download the .glb like **[this Browser Extension](https://github.com/efebaykaraa/meshy_downloader)** or **[this Tampermonkey Script](https://github.com/youssef02/meshy2glb)**

**[Mii Creator](https://mii.nxw.pw/)** - Create Miis online. Create animations or download the glb for use in FSGM.
.

.

.

.

.



## THE FOLLOWING IS LLM GENERATED

### What it does

- Loads 11 model formats, including textured GLB and FBX
- Opens **.zip bundles** — finds the model inside, textures and all, even
  when it is buried in a second archive
- Renders on the GPU with three.js — with the model's own **physically based
  materials** (normal, metal/roughness, emission, occlusion and the rest) lit
  by an environment, or with the flat Retro look older rips were made for
- **Eight one-click lighting presets** for each look, and one **Overall
  brightness** slider; every individual light is still there underneath
- Produces a **seamless loop** — frame *i* sits at exactly `i × 360/N` degrees,
  so the last frame steps into the first with no repeated pose
- Takes a spin speed and a frame rate and works out the frame count for you,
  flagging it when that count gets expensive. Either one at zero is a stopped
  spin, which exports as a single still
- Keeps **exact timing** — 48 frames at 0.25 rounds/s totals 4.000 s, not 3.97
- **Double-click any slider's number** to type a value, including values past
  the slider's own ends — a 250x zoom, a 0.001 rounds/s crawl
- Exports with real transparency

## Running it locally

```bash
python3 serve.py
```

Then open <http://localhost:8000>. A static server is needed — ES modules don't
load over `file://`.

[serve.py](serve.py) is `python3 -m http.server` plus a `Cache-Control:
no-cache` header. The stock server sends no caching instructions, so browsers
keep the app's modules for hours without asking; after an update that mixes new
files with stale ones and the app stops responding entirely. Any other static
server works too, as long as it does not let the browser cache blindly. If a
page ever seems dead after an update, a hard refresh (Ctrl+Shift+R) clears it.

## When the browser is missing something

The app used to go silently dead when a browser lacked something it needs:
buttons did nothing and drops were ignored, because the app is one script and
the failure stopped it before any button was wired up. Now a small classic
script, [src/preflight.js](src/preflight.js), runs first, needs nothing the app
might lack, and reports problems **under the file browser** — never as a
pop-up — as one line of plain coloured text each, like the app's other
errors: the headline and a **Browser check** link.

- **Red — the app cannot do its job.**
- **Orange — one feature is lost** (and switched off).

**Browser check** (that link, or the one at the bottom of the settings) is
where the explanation lives: each problem found with why it matters and what
to try, then every check with ✅ or ❌ coloured by how much a failure matters,
then a **Details for a bug report** block with the browser, the graphics card
where the browser reveals it, and every error caught, file and line included.
Minor problems appear there and nowhere else.

| | Level | Detected by |
| --- | --- | --- |
| Opened from disk in a browser that will not run it that way | red | the address starts with `file:` *and* the app did not start — Firefox runs it from disk happily, so there it is not reported |
| Browser too old for import maps | red | `HTMLScriptElement.supports('importmap')` |
| 3D graphics switched off or blocked | red | no WebGL context at all; the browser's own reason goes in the details |
| Only the older WebGL 1 | red | WebGL 1 opens, WebGL 2 does not |
| No OffscreenCanvas, or no createImageBitmap | red | the APIs are missing |
| Reading canvas pixels blocked | red | an exact test pattern comes back blank, randomised or not at all |
| **The app did not start**, for any other reason | red | the app never reports ready before the page's `load` event — which module scripts always precede — so a stale cached file, a missing file or a crash is caught with its real error |
| The graphics card dropped the page mid-use | red | a lost WebGL context; Browser check offers a Reload link, and frames already rendered can still be saved |
| No half-float rendering | orange | Environment is forced to None |
| Cannot encode WebP (Safari) | orange | Save WebP is disabled up front instead of failing after a click |
| 3D running in slow software mode | orange | the browser refuses a context flagged as slow |
| Any other unexpected error | orange | caught globally; one line however many, each message listed in Browser check |
| Pixels faintly altered on read-back (anti-fingerprinting) | Browser check only | an exact test pattern comes back slightly off; exports may differ from the preview by a shade |
| No MSAA, no anisotropic filtering, textures larger than the card allows | Browser check only | three.js copes with each by itself; nothing to act on |

Running out of memory during a render or a save is said in those words, next
to the button that was pressed, as every render and save error already was.

**Cannot be detected:** whether a model will fit in graphics memory before it
is loaded; whether a download was actually saved; slowness on a weak but real
graphics card; driver bugs that draw wrong pixels; *which* setting is
altering pixels; the real graphics card name where the browser masks it; a
stale cache that happens not to break anything (serve.py prevents that); and
anything about how a viewer's player will time the finished GIF.

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
line, lets you pick the combination by hand. It also holds the mesh list, so it
opens for a plain file with several meshes and not only for a zip.

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

### Choosing which meshes to draw

A ripped file often holds several versions of the same thing at once —
alternate heads, an older body, a collision proxy — stacked on top of each
other, and the mesh count in the info line is the first hint that something is
in there twice. **Meshes** lists one checkbox per mesh, with a single button
above it that hides or shows the lot.

The boxes are labelled by position — `1`, `2`, `3` — and wrap into a grid, so
twenty-one meshes are three lines you can take in at once. Names are not shown
because a rip does not really have them: exporters leave them empty as often
as not, and when one is there it is routinely a content hash
(`7e64c2fb718121ebd157b6e15f6c0059-v7.00`) or the same string repeated on
every mesh in the file. A column of those cannot be scanned, and clipping it
short just makes every row identical. Hover a box and the tooltip gives you
whatever the file does say, plus the triangle count.

**Point at a box and its mesh blinks** at 10 Hz, which is how you find out
which one it is without ticking it and comparing two renders by eye. The blink
alternates against whatever state the mesh is already in — a ticked mesh winks
out, an unticked one winks in — so the thing that moves is always the thing
that box controls. On a touch screen, hold the box instead. Nothing about the
blink is committed: it is a look, not a change, and the real state comes back
the moment you move away. It never reaches a render, and anyone who has asked
their system for reduced motion gets the same information held steady instead
of strobed.

Each phase of the blink is scheduled only after the previous one has finished
drawing. A plain interval would keep queueing frames on a machine where one
costs more than the gap between them — a heavy model on a phone, or anything
falling back to software GL — until the page stopped responding; draining
first turns that into a slower blink.

Unticking a mesh hides it from the preview and from every export — three.js
simply does not draw it, so there is nothing for the encoders to get wrong.
**Framing deliberately does not follow**: the model keeps the size and centre
it was given, so flicking two checkboxes to compare overlapping versions holds
the camera still instead of jumping on every click. If what remains sits small
in the frame, Zoom is the control for that.

The choice survives a texture or material-file change, since the geometry is
identical and the meshes are keyed by their position in the file. Loading a
different model, or a different file, starts over.

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

## Nothing goes out

After the page has loaded, the app makes no network requests at all. Every
dependency is vendored, so there is no CDN, no analytics, no fonts fetched at
runtime — and no model or image you open ever leaves the machine.

That needs enforcing rather than merely intending, because a model file can
ask for the network on your behalf. A `.gltf`, `.dae`, `.fbx` or `.3ds` can
name an absolute URL for a texture, and three.js will go and fetch it — at
which point whoever wrote that file learns your address, your user agent and
the moment you opened it. A tracking pixel wearing a 3D model.

Archives were always immune: their resolver answers out of the zip and
refuses anything carrying a scheme. Lone files were not, and used to fetch
whatever they asked for. They now go through a loading manager that answers
every external reference with a blank pixel, and the info line says so —
`1 external reference blocked`, with the filenames on hover — so a model that
arrives untextured explains itself instead of just looking broken.

One exception, and it has to be: the Draco decoder. `DRACOLoader` fetches its
decoder through a `FileLoader` built on whatever loading manager it is handed,
and `FileLoader` runs every URL through `manager.resolveURL()`. Given the
manager that answers the model's references, the decoder request goes through
the same redirect — the archive resolver hunts for `draco_wasm_wrapper.js`
inside the zip, fails, and returns the missing-texture pixel, which is then
parsed as JavaScript. The decoder belongs to the app rather than to the file
being opened, so it loads on the default manager and reaches the disk
untouched. This was quietly broken for Draco-compressed glTF in a zip before
the block existed.

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

**Contradictory transparency.** `d` is dissolve, where 1 is opaque; `Tr` is
transparency, where 1 is invisible. The 3ds Max Wavefront exporter behind most
ripped models writes *both*, with `Tr` carrying the same meaning as `d`:

```
d  1.0000
Tr 1.0000
```

Read to the letter that says "completely opaque, and also completely invisible",
and `Tr` comes second, so it wins. That is why a model could load, report its
meshes, and then be nowhere to be found in the scene. A `Tr` that *contradicts*
the `d` beside it is dropped; a consistent pair is left alone, which is why this
is not simply MTLLoader's `invertTrProperty` — that would turn every correct
`Tr 0` into an invisible material instead. Materials left fully transparent by
any other route are made opaque too, since nobody loads a model to look at
nothing.

**Crushed tints.** The scene multiplies a material's colour by its texture, so a
base colour of near-black hides the texture completely. FBX exporters write
exactly that. Only tints dark enough to crush any texture to black are touched,
and only where there is a texture for them to crush.

**Colour space.** A colour map holds sRGB data by definition, but ColladaLoader
sets no colour space at all, which renders washed out.

**Collada texture coordinates.** 3ds Max's ColladaMax exporter writes its map
channel as coordinate set 1. ColladaLoader files set 1 under `uv1`, but every
three.js map samples `uv` unless told otherwise, so each texture was drawn from
coordinates that did not exist and came out as a smear of one texel. That is
the whole of "the OBJ works but the DAE doesn't" for Shadow and Midna: the
.obj carries the same coordinates as plain `vt`. A mesh whose only coordinates
are set 1 now draws from them.

**Collada wrap modes.** A COLLADA sampler declares how its texture wraps —
`WRAP`, `MIRROR`, `CLAMP` — and ColladaLoader reads none of it, repeating every
texture regardless. Toad's spots are a quarter circle meant to be *mirrored*
into a whole one; repeated, they came out as a grid of quarters. Each sampler's
declared wrap is now applied, except where the loader already followed a MAYA
`<extra>` technique that says otherwise. Both Collada repairs are applied to
what the vendored loader returns, which is left unmodified.

**Blended models that draw their own insides.** GLTFLoader turns depth writing
off for every alpha-blended material. That is right for a pane of glass and
wrong for the common export that marks a *whole model* as blended because one
corner of its atlas is translucent — the inside of the Canon's viewfinder then
draws straight through its housing. Realistic lighting keeps depth writing on,
as Retro always has.

**Texture sets.** When a zip's colour map has to be matched to a material by
name, the rest of its set — normal, roughness, metalness, occlusion, emissive
maps sharing the same stem, `_COL_`/`_NRML_`/`_ROUGH_` and the like — is
attached with it, and the model then loads with Realistic lighting. Glossiness maps are
left out (they are roughness inverted), as are opacity and height maps.

Two things are deliberately *not* repaired, because there is no honest rule for
them. **Vertex colours** are ambiguous in these exports — sometimes they carry
the model's actual colour, sometimes baked shading that double-darkens the
texture it multiplies — so they are applied as the file asks and noted in the
info line. When they turn out to be wrong, the **Vertex colours** switch under
*Layers & debug* takes them out: the Canon's FBX carries a Blender ID mask of
pure red, yellow and blue that otherwise paints the whole camera. And where a bundle ships several exports of the same model, only an
obvious derived variant (`_bake`, `_LOD3`, `collision`) is pushed down the
ranking; choosing between the rest is what the Advanced panel is for.

## Position

An optional **Position** section moves the model around the rotation point —
X/Y/Z translation plus pitch/yaw/roll. Most models need none of it, so every
control defaults to zero.

Translation is in **bounding-sphere radii**: the model is normalised to radius 1
on load, so 1.0 shifts it by its own radius whatever its real-world scale.
Rotations apply in YXZ order (yaw, then pitch, then roll).

Each label names what a *positive* value does. The sliders cover ±2 radii,
which is all most framing needs; double-clicking the number takes a translation
out to ±100 for the rare model that arrives wildly off its own origin.

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

## Background

The Image section's **Background** is one of three:

- **Transparent** (the default) — nothing is painted under the render; the
  preview shows the checkerboard and the export keeps its alpha.
- **Solid colour** — a colour fills the whole frame, On Top's band included.
- **Image** — a JPEG, PNG, WebP or BMP under the render, with **Size**,
  **Up / down** and **Left / right** sliders that all start in the middle.

A picture is fitted to the image's **height** at 100%, so a wide photo on a
square image loses its left and right sides and a tall one leaves clear strips
down either side. Wherever the picture does not reach stays transparent. The
two position sliders run to ±100, where the picture has just slid off that
edge; the range scales with the picture's size, so a zoomed-in picture can
still be panned all the way to either of its own edges.

Everything is a fraction of the image, never a pixel count, so changing Width
and Height keeps the picture's relative size and place. One function,
`placeBackdrop()` in [src/backdrop.js](src/backdrop.js), decides where it goes:
the export draws from its answer, and the preview places an `<img>` in
percentages of the same answer, so the two cannot drift apart. The picture
belongs to the render: in On Top mode it sits under the render, not under the
white band above it. A GIF with a picture background keeps its transparency index,
since the picture may leave parts of the frame uncovered.

## Rendering

Tuning a model's lighting can take a lot of sliders, so the section shows only
four things until you ask for more:

1. **Lighting** — Realistic or Retro, picked for each model as it loads.
2. **Overall brightness** — every light up or down at once.
3. **Eight presets**, in two rows, for whichever Lighting is chosen.
4. Two disclosures, **Advanced lighting** and **Layers & debug**, which hold
   every individual control.

**Reset to defaults** under them puts all of it back, including the Lighting
the model picked.

### Realistic and Retro

The **Lighting** dropdown chooses between three.js's two lighting models.

| Choice | What it draws | Picked for |
| --- | --- | --- |
| **Realistic** | the file's own physically based materials, every layer intact, lit by an environment as well as the lights | glTF, USDZ, modern FBX: any model that ships physically based materials |
| **Retro** | colour and colour map only, Blinn-Phong, no environment | ripped game models, OBJ, Collada, and anything that does not say |

Each model picks one as it loads, and the note under the dropdown says which
and why; after you pick the other by hand, the note says what the model would
have chosen. Choosing a different texture or material file for the same model
keeps a choice made by hand. Retro is the renderer this app has always had,
kept exactly: a model that looked right before still looks the same. Realistic
is what fixes the models that did not:

- **Metal went black.** A fully metallic surface has no diffuse colour at all;
  everything it shows is a reflection. Lit by three lights and nothing else it
  reflects three points and black between them, which is why the Canon AT-1
  rendered nearly black. Realistic materials reflect an **environment** as well.
- **Colour that lived in emission went black.** The Mii's colours are all
  emissive, over a black base colour. Retro keeps the base colour and drops
  emission; Realistic keeps both.
- **Normal, roughness, metalness, occlusion and clearcoat maps were ignored.**
  Retro draws a colour map and nothing else.

Choosing Realistic for a Retro model upgrades each Phong or Lambert material to
a non-metallic `MeshStandardMaterial` with every map it carries and a roughness
matched to its shininess. Choosing Retro for a physically based model draws it
the old way, flat.

### Overall brightness

One slider, 0–300%, that multiplies every light together: key, fill, rim,
ambient and the environment. The balance a preset set up survives, and it works
the same on both paths; Exposure only does anything with tone mapping, and
Retro has none. It sits on top of the presets rather than being part of them,
so a brightness you have settled on stays while you try presets. Emissive and
unlit surfaces glow by themselves and are not affected.

### Presets

Each button sets **every** lighting control in Advanced lighting at once,
starting from the defaults, so a preset always gives the same picture whatever
was clicked before it. The button stays highlighted while the lighting still
matches it exactly, and goes dark the moment a slider moves. Presets never
touch the model's position, Overall brightness or anything in Layers & debug.

| Realistic | | Retro | |
| --- | --- | --- | --- |
| **Studio** | softboxes in a grey room; the default | **Standard** | the original lighting; the default |
| **Outdoors** | high sun and open sky, self-shadowing | **Flat** | painted colour, no light and shade: sprites and unlit games |
| **Indoors** | warm lamps overhead | **Viewport** | a light from the viewer, as in a modelling program |
| **Soft** | overcast: even light, gentle shadows | **Console** | strong ambient and one light from above, as 90s consoles did it |
| **Product** | bright product shot with edge highlights | **Sunlit** | warm sun, blue sky ambient |
| **Sunset** | low orange sun, blue sky behind | **Showcase** | character-select lighting, a bright edge all round |
| **Dramatic** | one hard light and deep shadows | **Glossy** | shiny plastic, like a toy |
| **Night** | cool moonlight | **Night** | cool moonlight |

Switching Lighting swaps a preset for the other path's default, since most
presets mean nothing on the other path: Glossy is Phong's highlight. Lighting you
tuned by hand is kept as it is. The presets live in
[src/presets.js](src/presets.js), and the tests check that each one's values
fit its controls and that no two are the same.

### Advanced lighting

Rows that would do nothing are hidden: the environment rows under Retro, Env.
strength and rotation with no environment, Exposure with no tone mapping,
Ambient while an environment stands in for it, Reflectivity and Highlight size
under Realistic, and Floor shadow without a floor.

**Environment** is what reflective surfaces reflect: **Studio**, a grey room
with softboxes, for crisp product-shot highlights; **Soft sky**, a plain
gradient with no hard reflections; or **None**. Both are small three.js scenes
baked through `PMREMGenerator` when first chosen — nothing is downloaded.
**Env. strength** scales it and **Env. rotation** turns it, which moves every
reflection across the model.

While an environment lights the model it also *replaces* the **Ambient**
slider's hemisphere light, and that slider is hidden. Both are light arriving
from every direction; counting it twice washed every painted surface out. The
default strength of 0.7 was measured rather than picked: with it, the shrimp's
average colour on its model pixels is within a few levels of its Retro render,
while the Canon's bare chrome still reads bright. The environment is used by
Realistic lighting only. three.js would hand it to Phong materials too, as a
mirror reflection mixed into their colour, and every Retro model would change,
so on that path there is none.

**Tone mapping** brings brightness beyond white back into range. **Auto** is
Khronos PBR **Neutral** for Realistic — chosen because it leaves colours below
about 80% brightness alone, so a base colour stays the colour it was authored —
and **None** for Retro, which is again what keeps Retro identical to the old
renderer. **AgX**, **ACES Filmic**, **Reinhard** and **Cineon** are there for a
filmic look. **Exposure** scales the light before tone mapping.

**Reflectivity** and **Highlight size** are Phong's own two knobs, so they
appear under Retro only; a physically based material carries its gloss in its
roughness instead.

The **Ambient**, **Key**, **Fill** and **Rim** sliders work on both paths. The
key and fill each have an **angle** around the view (0° is from the camera,
positive to the right) and a **height** above it. The lights ride with the
camera, as they always have, so the model turns under them. The defaults are
the long-standing directions to the last decimal, which is why they read 29°
and −40° rather than round numbers. Each light, and the ambient, also takes a
**colour**.

**Shadows** come from the key light: **On the model** for self-shadowing, or
**On the model and a floor**, which adds a floor that shows nothing *but* the
shadow — it is transparent everywhere the light reaches, so it works on a
transparent export and sits correctly over any background. The floor goes
under the model's lowest point, measured vertex by vertex; spinning about a
vertical axis never changes a point's height, so it is placed once rather than
chasing the spin. **Floor shadow** sets its darkness.

### Layers & debug

**Quality** (render supersampling) is the first row here: Fast, Good (2×) or
Best (3×), smoother edges for slower renders.

The rest is for looking at a material one part at a time. **Show** swaps the lit render
for a single channel, drawn unlit and without tone mapping:

| View | What it is |
| --- | --- |
| Base colour | colour × colour map × vertex colours |
| Normals | the surface normal after the normal or bump map, as colour |
| Metalness, Roughness, Ambient occlusion | the factor × its map's channel, as grey |
| Emission | emissive colour × emissive map |
| Opacity | the alpha the lit shader would use, as grey |
| Wireframe | every triangle's edges |

glTF packs occlusion, roughness and metalness into the red, green and blue of
one texture, and no stock three.js material can show one channel of a texture
— so those three views are `MeshBasicMaterial` with a one-line swizzle. Data
views show the stored number: a roughness of 0.5 is 50% grey, not the brighter
grey an sRGB output would otherwise make of it. Every other view is a stock
material handed the right map.

The checkboxes take a layer out of the ordinary render: **Base colour map**,
**Vertex colours**, **Normal & bump maps**, **Metalness & roughness maps**,
**Emission**, **Ambient occlusion**, **Light map**, **Transparency** and
**Clearcoat, sheen & transmission**. Each shows how many of the model's
materials use it, and one that nothing uses is greyed out. Switching a layer
back on is exact — every material's full state is recorded before the first
switch, and restored from that record rather than from wherever the last
change left it. Switches survive loading another model, and **Reset to
defaults** turns them all back on.

**Normal strength** and **Emission strength** scale those two layers.
**Texture filtering** is **Smooth** (the loader's choice), **Sharp**, which
adds anisotropic filtering for surfaces seen at a glancing angle, or
**Pixelated**, which samples the nearest texel — an 8×8 console texture drawn
as eight clear blocks. **Double-sided** draws the back of every face, as the
app always has; off, each material is drawn as its file says.

## Preview

With a model loaded, **dragging** the render view orbits it (Start rotation and
View angle), and **scrolling** over it zooms: one wheel notch is one step of
the Zoom slider, scrolling up to zoom in. The wheel stops at the slider's ends
but leaves a typed zoom beyond them alone, and Ctrl+scroll is still the
browser's own page zoom.

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

## Text

A **Text** section captions the animation. The Mode dropdown decides *where*
the caption goes, and it is **Disabled** by default, so a fresh page makes the
picture you asked for and nothing else.

| Mode | What it does |
| --- | --- |
| **Disabled** | no caption; nothing is drawn and nothing is measured |
| **In Front** | top / centre / bottom boxes drawn over the render |
| **On Top** | one caption in a white band grown *above* the image |
| **Behind** | the same three boxes as In Front, composited *under* the render |

In Front and Behind share one set of controls — Font, Stroke weight, Size, and
the three boxes — and differ only in what is drawn over what. Text is always
centred, and wraps on its own when a line runs out of room; press **Enter** to
break a line early, exactly where you want it, and two Enters leave a blank
line rather than being swallowed.

Every box holds up to **5,000 characters**. A caption that long runs off the
image, which is allowed; lines that fall entirely outside are skipped rather
than handed to the rasteriser once per frame.

### On Top changes the size of the exported image

This is the one mode that does. The band is however tall its own wrapped text
needs it to be — type a longer caption and the picture grows upward — so the
finished image is taller than the render that went into it.

**Width and Height keep describing the render.** Ask for 480x480 and the model
is still rendered at 480x480; nothing that reads those numbers learns the band
exists. Only two things know: the composed frame, and the readout under the
view, which says `480 × 480 · output 480 × 578` whenever the two differ.

The band is white with black text and no outline, so the Stroke control is
hidden there. The mode defaults to **Oswald at 50%** while In Front and Behind
default to Anton at 100% — each mode remembers its own pair, so switching back
and forth does not spend one mode's settings on the other. The smaller default
is not arbitrary: 100% means "ten capital Ms span the image", which is right
for a caption *over* a picture and much too big for a paragraph above one — a
single sentence at 100% grows a band taller than the image it captions.

### Behind

Behind draws the caption first and the render over it, so the model occludes
the text as it turns.

That is easy on a transparent background and was impossible on an opaque one,
where the render covered the caption completely with nothing the caption code
could do about it. It works because
[the background is a layer](#the-background-is-a-layer-not-a-clear-colour)
rather than the renderer's clear colour: Behind's text is imprinted on that
coloured layer (or picture), and the Background setting goes on meaning
exactly what it says.

In the preview it is one CSS class, which lifts the render above the caption
in the same grid cell.

The three blocks anchor differently, which is what makes them behave when the
text grows:

| | |
| --- | --- |
| **Top** | grows downward; the first line stays put |
| **Center** | stays centred on the image, so a second line pushes the first up by half a line |
| **Bottom** | grows *upward*, so extra lines make room for themselves instead of walking off the image |

Text is positioned by its **ink**, not by its em box, and that is the whole
reason the three blocks sit where they do. A line's em box is taller than the
letters in it, and by a different amount in every font — capitals ride high in
the box while the space reserved for descenders goes unused. Place by the box
and an all-caps caption reads high, by a different margin per font.

Placing by the box and then correcting for it got halfway: balanced top
against bottom within a font, but each face still ended up on its own margin,
because the correction differs from face to face by more than four to one.

| Font | ink offset at 480px |
| --- | --- |
| Anton | 8.9px |
| Oswald | 6.4px |
| Comic Neue | 3.0px |
| Arimo | 2.1px |
| Tinos | 3.5px |

So nothing is placed by the box now. A probe of flat capitals — `MHEX`, no O
to overshoot and no descender — reports where the ink actually starts and
ends via `actualBoundingBoxAscent` and `actualBoundingBoxDescent`, and the
top block's ink is put on the margin, the bottom block's ink on the margin
from the foot, and the middle block's ink on the centre of the image.

The result is **18px above and below on a 480px image, in every font**:
measured at 17–18 across all five, with every centre block landing on the
middle. It scales with the image, 36px at 960.

The probe is capitals rather than the actual text on purpose. Measuring the
real wording would pin any string exactly, but the block would then jump as
you typed, a `g` or a `y` shifting everything. A caption is nearly always
caps; text that does carry a descender hangs slightly below the line instead.

### Sized to the image, not to the pixel

Nothing about the caption is measured in pixels, so the same settings give the
same picture at 200x200, 480x480 and 1000x1000 — only the resolution changes.

Letter size follows the image **height**, which is the counterintuitive half
and the right one. Reading the width would tie how big a letter is to how wide
the frame is, so widening 480x480 to 1000x480 to fit a longer caption would
blow the text up instead and leave you no better off. Reading the height means
the size holds and the extra width does what you wanted: more characters on
the line. A 480x480 and a 1000x480 render are pixel-identical in the caption.

The size itself is set so that **about 10 capital Ms span a square image** —
on a square one that is literally how many fit, on a wider one the letters
stay that size and more of them fit. Stroke weight scales the same way, quoted
so the default of 5 means five pixels on a 480-tall image. **Stroke 0 draws no
outline at all.**

The M count is *measured* from the font rather than assumed, because the fonts
on offer differ by more than 2x in how wide an M is — Impact is far narrower
than Arial Black at the same point size, and one fixed pixel size would be
wrong for one of them. The same measurement sizes the stroke, so the outline
stays in proportion when the Size control moves rather than swallowing small
text and hairlining big text.

Two things here went wrong before they went right, and both are the same
shape — a measurement taken against the wrong span:

- The font was first sized to the **full** width while wrapping happened
  inside the side margins, so the promised count wrapped one character early.
  Both now measure the same span.
- Stroke 0 still drew a hairline. `ctx.lineWidth = 0` is *ignored* — the
  canvas spec requires a value greater than zero — so the context silently
  kept the 1 it already had, and the guard that read `ctx.lineWidth` back saw
  1 and stroked anyway. The width is now held in a local and never read off
  the context.

### Where it is drawn

The caption is painted in `makeResolver()` in [src/capture.js](src/capture.js),
onto each frame *after* the supersampled render has been downsampled — at the
true output size, so its edges stay sharp instead of being softened along with
the model. Because it goes into the frame store rather than into a save step,
one render feeds a GIF, a WebP, an APNG and a ZIP that all agree.

The preview draws the same thing onto a second canvas stacked over the WebGL
one, since text cannot be drawn into a WebGL context. Both canvases sit in one
grid inside `#frame`, which is sized to the *finished* picture: its rows are
set to the real pixel heights of the band and the render, as
`<band>fr <render>fr`, so the two always scale by the same factor with nothing
measured. With no band the rows resolve to `0fr 1fr` and it is the plain stack
it has always been. Behind mode is one class, which lifts the render over the
caption.

The band's height is the one number both halves must agree on, so both call
the same `layoutBand()` in [src/overlay-text.js](src/overlay-text.js) — and
both measure it **at the output size**, never at the preview's. The preview
canvas is supersampled, two or three times the output, and the band is rounded
to whole pixels; measure there and divide and the rounding lands in a different
place, leaving the preview a pixel or two out from the file you save. Measuring
what actually ships and scaling up is exact: the band is 98px of 480 at every
quality setting, in the preview and in the export alike.

### Fonts

The Font list offers five faces, all bundled with the app, so they are there
on every machine. System fonts used to be listed underneath and are not any
more: naming Impact in a menu promises a look the machine may well not have —
it is on no stock Linux or Android install — and a menu that quietly delivers
something else is worse than a shorter menu. Each stack still falls back to
its system counterpart if the font file itself fails to load.

| Included | stands in for | size |
| --- | --- | --- |
| Anton | Impact | 18.6 KB |
| Oswald | Futura Condensed Extra Bold | 12.7 KB |
| Comic Neue | Comic Sans MS | 19.2 KB |
| Arimo | Arial — metrically identical | 11.5 KB |
| Tinos | Times New Roman — metrically identical | 17.8 KB |

All five are SIL Open Font License 1.1, with their licences in
[vendor/fonts](vendor/fonts). 92 KB for the set, latin subset, WOFF2.

Bundling them is not a preference, it is the only lawful option. Impact,
Arial and Times New Roman are Monotype's; Comic Sans and Wingdings are
Microsoft's; Futura Condensed Extra Bold is Neufville's. The "Core fonts for
the Web" licence that once covered Arial, Impact and Comic Sans allowed
redistribution only as Microsoft's original installer, and that programme
ended in 2002 — serving the extracted `.ttf` from a public site is outside
all of it.

Two of those have no free equivalent and are simply absent: **Futura
Condensed Extra Bold**, where Oswald is close in weight and width but not in
construction, and **Wingdings**, whose glyph mapping nobody has cloned. Both
still work through the system group on a machine that has them.

The fonts are **self-hosted, not pulled from a CDN**. A `fonts.googleapis.com`
link would have been two lines, and would have broken the one property this
app actually promises — it makes no network requests — while reporting every
visitor's address to a third party.

Each bundled stack still names its system counterpart underneath
(`Anton, Impact, 'Arial Narrow Bold', sans-serif`), so a font file that fails
to load lands on something the right shape.

#### Why the loading is not just a `@font-face`

`measureText` and `fillText` fall back to a default face, silently, if a font
has not finished loading. Because the caption is *measured* from the font, a
fallback does not merely look wrong for a moment — it is measured, sized and
wrapped as though it were the real thing, so the first render after a reload
could disagree with every render after it.

Three things prevent that: the bundled families are warmed at startup and the
preview redraws on `document.fonts.ready`; changing the font awaits the new
one before redrawing; and the render handler awaits the selected family
before `captureFrames()` runs, which keeps the per-frame path synchronous
while still guaranteeing the whole capture agrees with itself.
`font-display: block` finishes the job, so a slow load shows nothing rather
than flashing a fallback into a frame.

Switching mode also re-waits: each mode remembers its own font, and a
remembered face may not have been fetched yet.

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

### The background is a layer, not a clear colour

`SpinScene.render()` always clears fully transparent, whatever Background is
set to. The colour is painted *underneath* the render by whoever composes the
frame — `drawBackdrop()` in `makeResolver()`, a `#backdrop` div under the
canvases in the preview. The Background setting still decides whether that
layer is painted; it just no longer decides it inside the renderer.

It used to clear to the colour, which made the background the bottom-most
thing in the image and left nothing that could ever be placed under it. Making
it a layer is what allows the caption's Behind mode to exist at all.

The change is invisible. Compositing the model over the colour with
source-over in the 2D canvas is the same operation the GL clear was doing, one
layer later — measured against the old build on the same model and settings,
**38 channels out of 921,600 differ, every one by ±1**, and every one on the
model's antialiased silhouette, where the two paths round a partly covered
pixel differently. Renders are otherwise bit-identical run to run.

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
edge case), loop angles, the PNG encoder, both muxers, the caption layout —
wrapping, ink placement and the band's height, which is the one figure the
preview and the export must agree on — and the archive hunter: path handling,
texture-name classification, model ranking, the lookup chain and the .mtl
transparency repair, against zips built in memory.

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
src/preflight.js      browser checks and error displays, run before the app
serve.py              local server that stops browsers caching stale modules
src/style.css         layout, including the mobile breakpoint
src/main.js           wiring: controls -> scene -> frame store -> exports
src/scene.js          three.js scene, framing, lights, shadows
src/loaders.js        format dispatch
src/archive.js        the zip hunter: flatten, pick a model, find its textures
src/materials.js      Retro and Realistic materials, layer switches, debug views
src/presets.js        the eight lighting presets for each path
src/environment.js    the Studio and Soft sky environments, baked with PMREM
src/mtl-fix.js        one .mtl repair, kept DOM-free so it can be tested
src/dae-fix.js        the two Collada repairs
src/capture.js        the frame store
src/backdrop.js       where a background picture goes, for preview and export
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

## Licence

This project's own work is under the **BSD Zero Clause License** — see
[LICENSE](LICENSE). It grants everything and asks for nothing: no attribution,
no notice, no conditions. Take it, change it, ship it, sell it, say nothing
about where it came from.

That covers everything outside `vendor/`. What is inside `vendor/` belongs to
other people and, permissive as it all is, **every piece of it requires its
notice be kept** — see [THIRD-PARTY.md](THIRD-PARTY.md), which lists each
component and points at its licence text.

## Credits

Rendering by [three.js](https://threejs.org). GIF quantisation by
[gifenc](https://github.com/mattdesl/gifenc). Deflate by
[fflate](https://github.com/101arrowz/fflate).

Caption fonts, all under the SIL Open Font License 1.1 and bundled in
[vendor/fonts](vendor/fonts) with their licences: **Anton**, **Oswald**,
**Comic Neue**, **Arimo** and **Tinos**.
