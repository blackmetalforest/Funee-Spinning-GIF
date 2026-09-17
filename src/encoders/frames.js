/**
 * Frame-sequence export: a ZIP of the individual PNGs.
 *
 * Nearly free once the frame store exists — it is a straight copy of the
 * stored blobs with no re-encoding at all — and it is how frames get into
 * After Effects, Blender or a video editor.
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
