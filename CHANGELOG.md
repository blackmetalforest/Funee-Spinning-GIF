# Changelog

Every release of Funee Spinning GIF Maker, newest first. Version numbers are
**MAJOR.MINOR.PATCH** — see "Versions" in the [README](README.md#versions) for
what bumps which, and how a release is made.

## 1.0.0 — 2026-10-17

The first release.

**Models in**
- 3D models: glTF/GLB (including Draco and Meshopt), FBX, OBJ + MTL, Collada,
  STL, PLY, 3MF, USDZ, VOX and 3DS.
- Zips of ripped models: the best model is picked, its textures are found
  wherever they ended up, and the Advanced picker lets you choose the model,
  material file and textures, hide meshes, and swap textures by hand.
- Repairs for common faults in ripped models: broken `.mtl` files, transparent
  textures drawn black, Collada texture wrapping, tints that crush a texture to
  black.
- Pictures as models: PNG, JPEG, WebP, BMP and GIF, animated ones included,
  with Unflip Backside Image and Depth (a still picture cut to its outline and
  given thickness).

**Spin and view**
- Main spin axis (Y, Z or X) with up to two extra axes at ratios from 10:1 to
  1:10, speed, frame rate, direction and start angle.
- View up–down and left–right, field of view, zoom, and Position offsets with
  an axis guide.

**Look**
- Retro and Realistic lighting, eight presets each, shadows, sky environments,
  tone mapping, and layer switches and debug views for every material channel.
- Text captions on top of or behind the model, background and foreground
  pictures (animated ones synced to the loop), and the Console theme.

**Out**
- Animated GIF (optionally dithered), WebP (optionally lossless), APNG, and a
  ZIP of frames, square presets from 128 to 1000 pixels or any size up to
  2000 × 2000.
- A live Preview, and saving blocked after any change until the frames are
  rendered again, so a file never mixes old and new settings.
