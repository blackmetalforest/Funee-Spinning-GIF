/**
 * Frame-sequence exports: a ZIP of the individual PNGs, and a sprite sheet.
 *
 * Both are nearly free once the frame store exists — the ZIP is a straight
 * copy of the stored blobs with no re-encoding at all — and both are genuinely
 * useful: the ZIP takes frames into After Effects or Blender, and the sprite
 * sheet is what CSS and game engines want.
 */

import { zipSync } from '../../vendor/fflate.module.js';

/** Zero-pad so frames sort correctly in a file browser. */
function frameName(index, total, ext = 'png') {
  const width = String(total - 1).length;
  return `frame_${String(index).padStart(width, '0')}.${ext}`;
}

/**
 * Bundle the stored PNGs into a ZIP, exactly as rendered.
 * Stored uncompressed: PNG is already deflated, so re-compressing costs time
 * and saves essentially nothing.
 */
export async function encodeZip(store, { name = 'spin' } = {}) {
  const entries = {};
  for (let i = 0; i < store.blobs.length; i++) {
    const bytes = new Uint8Array(await store.blobs[i].arrayBuffer());
    entries[`${name}/${frameName(i, store.blobs.length)}`] = [bytes, { level: 0 }];
  }
  return new Blob([zipSync(entries)], { type: 'application/zip' });
}

/**
 * Lay every frame onto one image.
 *
 * Columns default to something near-square, which keeps the sheet within
 * texture-size limits and is what sprite tooling generally expects.
 */
export async function encodeSpriteSheet(store, { columns = 0 } = {}) {
  const { blobs, width, height } = store;
  const count = blobs.length;
  const cols = columns > 0 ? columns : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);

  const sheet = new OffscreenCanvas(cols * width, rows * height);
  const ctx = sheet.getContext('2d');

  for (let i = 0; i < count; i++) {
    const bitmap = await createImageBitmap(blobs[i]);
    ctx.drawImage(bitmap, (i % cols) * width, Math.floor(i / cols) * height);
    bitmap.close();
  }

  return {
    blob: await sheet.convertToBlob({ type: 'image/png' }),
    columns: cols,
    rows,
    frameWidth: width,
    frameHeight: height,
  };
}
