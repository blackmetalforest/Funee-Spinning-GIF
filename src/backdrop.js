/**
 * The background layer: nothing, a flat colour, or a picture.
 *
 * Where a picture goes is decided here and nowhere else. The export draws it
 * with drawBackdrop(); the preview places an <img> from the very same
 * placeBackdrop() answer, expressed as percentages of the frame. One rule for
 * both is what keeps what you see what you save. DOM-free, so the tests can
 * run it under Node.
 */

/**
 * Where the picture lands on a `width` × `height` render, in pixels.
 *
 * Everything is a fraction of the image being made, never an absolute pixel,
 * so changing the output size keeps the picture's relative size and place:
 *
 * - `size` is a percentage. At 100 the picture fits the render's *height*, so
 *   a wide photo on a square image loses its left and right sides, and a tall
 *   one leaves clear strips down either side.
 * - `x` and `y` run from -100 to 100, with 0 centred and positive meaning
 *   right and up. At ±100 the picture has just slid off the edge: the range
 *   is scaled by the picture's own size, so a zoomed-in picture can still be
 *   panned to either of its edges, and a small one can still reach the
 *   corners.
 */
export function placeBackdrop(imageWidth, imageHeight, width, height,
  { size = 100, x = 0, y = 0 } = {}) {
  const scale = (height / Math.max(1, imageHeight)) * (Math.max(0, size) / 100);
  const w = imageWidth * scale;
  const h = imageHeight * scale;
  const cx = width / 2 + (x / 100) * (width + w) / 2;
  const cy = height / 2 - (y / 100) * (height + h) / 2;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

/**
 * Paint the background layer into a 2D context.
 *
 * `backdrop` is null (leave it clear), `{ colour }`, or
 * `{ image, size, x, y }` where `image` is anything drawImage accepts and
 * knows its own width and height. `top` is where the render starts, which On
 * Top's band pushes down: a colour fills the whole frame as it always has,
 * but a picture belongs to the render and sits behind the render alone.
 * Wherever the picture does not reach stays clear.
 */
export function drawBackdrop(ctx, backdrop, { width, height, top = 0, total = height }) {
  if (!backdrop) return;
  if (backdrop.colour) {
    ctx.fillStyle = backdrop.colour;
    ctx.fillRect(0, 0, width, total);
    return;
  }
  const { image } = backdrop;
  if (!image?.width || !image?.height) return;
  const place = placeBackdrop(image.width, image.height, width, height, backdrop);
  if (!(place.width > 0 && place.height > 0)) return;
  ctx.save();
  // Clipped to the render, so a picture pushed upward cannot bleed into the
  // band above it.
  ctx.beginPath();
  ctx.rect(0, top, width, height);
  ctx.clip();
  ctx.drawImage(image, place.x, top + place.y, place.width, place.height);
  ctx.restore();
}
