# Third-party components

Everything in `vendor/` is somebody else's work, included here so the app runs
with no network and no build step. The project's own licence ([LICENSE](LICENSE),
0BSD) asks for nothing, but these do not all take the same view: **every one of
them requires its notice to travel with the copy.** That is what this file and
the licence texts beside the code are for.

If you reuse this project, keep `vendor/` intact — licences and all — or remove
the parts you do not need.

## Code

| Component | Licence | Text |
| --- | --- | --- |
| [three.js](https://threejs.org) — rendering and every model loader | MIT | [vendor/LICENSES/three.js-MIT.txt](vendor/LICENSES/three.js-MIT.txt) |
| [fflate](https://github.com/101arrowz/fflate) — zip reading and deflate | MIT | [vendor/LICENSES/fflate-MIT.txt](vendor/LICENSES/fflate-MIT.txt) |
| [gifenc](https://github.com/mattdesl/gifenc) — GIF quantisation | MIT | [vendor/LICENSES/gifenc-MIT.txt](vendor/LICENSES/gifenc-MIT.txt) |
| [Draco](https://google.github.io/draco/) — compressed-mesh decoder | Apache-2.0 | [vendor/LICENSES/draco-Apache-2.0.txt](vendor/LICENSES/draco-Apache-2.0.txt) |
| [meshoptimizer](https://github.com/zeux/meshoptimizer) — meshopt decoder | MIT | [vendor/LICENSES/meshoptimizer-MIT.txt](vendor/LICENSES/meshoptimizer-MIT.txt) |

Draco and meshoptimizer arrive as part of three.js's `addons/`, but they are
separate projects with their own terms, so they are listed separately.

`vendor/gifenc.esm.js` is a minified build that reached this repo with its
licence header stripped. The header has been restored, since MIT asks for the
notice to be kept in the copies you distribute.

## Fonts

The caption fonts, all under the **SIL Open Font License 1.1**, with their
licence texts in [vendor/fonts](vendor/fonts):

| Font | Stands in for | Text |
| --- | --- | --- |
| Anton | Impact | [OFL-Anton.txt](vendor/fonts/OFL-Anton.txt) |
| Oswald | Futura Condensed Extra Bold | [OFL-Oswald.txt](vendor/fonts/OFL-Oswald.txt) |
| Comic Neue | Comic Sans MS | [OFL-ComicNeue.txt](vendor/fonts/OFL-ComicNeue.txt) |
| Arimo | Arial (metrically identical) | [OFL-Arimo.txt](vendor/fonts/OFL-Arimo.txt) |
| Tinos | Times New Roman (metrically identical) | [OFL-Tinos.txt](vendor/fonts/OFL-Tinos.txt) |

The OFL has two conditions worth knowing beyond keeping the notice: the font
files may not be sold on their own, and a **modified** font may not keep its
Reserved Font Name. Shipping them unchanged inside an application, as here, is
squarely what the licence is for.

## What is deliberately *not* here

No copy of Impact, Arial, Times New Roman, Comic Sans or Wingdings. Those are
Monotype's and Microsoft's, and the "Core fonts for the Web" licence that once
covered some of them permitted redistribution only as Microsoft's original
installer — a programme that ended in 2002. They are offered in the Font
dropdown under "From your system", which uses the copy already on the viewer's
machine and redistributes nothing.

`content/sample.glb` was removed for the same reason: its provenance was not
the project's to give away.

Everything else in `content/` — the two wordmark images and the theme tune —
is the author's own work and is released under [LICENSE](LICENSE) along with
the code. There is nothing in this repository outside `vendor/` that you need
permission or attribution for.
