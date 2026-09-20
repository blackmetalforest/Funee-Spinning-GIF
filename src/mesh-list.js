/**
 * Labels for the mesh checkboxes — kept DOM-free and three.js-free so the
 * fiddly half can be tested in Node, the same reason src/mtl-fix.js exists.
 *
 * The visible label is the mesh's position and nothing else. Naming a mesh in
 * a ripped model is a lost cause: exporters leave the name empty as often as
 * not, and when it is there it is routinely a content hash
 * ("7e64c2fb718121ebd157b6e15f6c0059-v7.00") or the same string repeated on
 * every mesh in the file. Twenty-one rows of that is a wall of noise you
 * cannot scan, and truncating it only produces twenty-one rows that all read
 * the same. A number is short, never ambiguous, and you find the mesh you
 * want by ticking boxes and watching the model anyway.
 *
 * Nothing is thrown away: whatever the file does say goes in the tooltip.
 */

/**
 * Turn raw mesh entries into a visible label and a hover title.
 *
 * Each entry is `{ index, name, triangles }`.
 */
export function labelMeshes(entries) {
  const list = Array.isArray(entries) ? entries : [];

  return list.map(({ index, name, triangles }) => {
    const trimmed = String(name ?? '').trim();
    const count = Number.isFinite(triangles) ? triangles : 0;
    // The detail the label no longer carries, kept where it costs no width.
    const detail = [
      `Mesh ${index + 1}`,
      trimmed || null,
      `${count.toLocaleString()} triangle${count === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · ');
    return { index, label: String(index + 1), title: detail };
  });
}

/**
 * What the one button above the list should say.
 *
 * It names the action it will perform, not the state it is in, so it reads as
 * a thing to press. Only a list with nothing left visible offers "All on".
 */
export function toggleLabel(total, hiddenCount) {
  return hiddenCount >= total && total > 0 ? 'All on' : 'All off';
}

/** "11 of 14 shown", the running count the summary carries. */
export function meshSummary(total, hiddenCount) {
  const shown = Math.max(0, total - hiddenCount);
  return `Meshes — ${shown} of ${total} shown`;
}
