/** Boxes in source pixels, half-open on the right and bottom like @meta-sam/parser records. */
export type PixelBox = { left: number; top: number; right: number; bottom: number };
export type GridBox = { x_min: number; y_min: number; x_max: number; y_max: number };
export type Size = { width: number; height: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Muse Spark's 0–1000 grid to pixels of the exact image it saw; values may slightly overshoot 1000. */
export function gridToPixels(box: GridBox, { width, height }: Size): PixelBox {
  const x1 = clamp(Math.round((Math.min(box.x_min, box.x_max) / 1000) * width), 0, width - 1);
  const y1 = clamp(Math.round((Math.min(box.y_min, box.y_max) / 1000) * height), 0, height - 1);
  const x2 = clamp(Math.round((Math.max(box.x_min, box.x_max) / 1000) * width), x1 + 1, width);
  const y2 = clamp(Math.round((Math.max(box.y_min, box.y_max) / 1000) * height), y1 + 1, height);
  return { left: x1, top: y1, right: x2, bottom: y2 };
}

export function area(box: PixelBox): number {
  return Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
}

export function intersection(a: PixelBox, b: PixelBox): PixelBox {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

export function expand(box: PixelBox, ratio: number, size: Size): PixelBox {
  const padX = (box.right - box.left) * ratio;
  const padY = (box.bottom - box.top) * ratio;
  return {
    left: clamp(box.left - padX, 0, size.width),
    top: clamp(box.top - padY, 0, size.height),
    right: clamp(box.right + padX, 0, size.width),
    bottom: clamp(box.bottom + padY, 0, size.height),
  };
}

/**
 * Does a SAM instance belong to the item Muse Spark located? A concept prompt
 * returns every match in the photo ("tomato" also finds cherry tomatoes on
 * another shelf), so an instance is kept only when most of it sits inside the
 * item's box, padded for grounding error.
 */
export function belongsTo(instance: PixelBox, sparkBox: PixelBox, size: Size): boolean {
  const own = area(instance);
  if (own === 0) return false;
  return area(intersection(instance, expand(sparkBox, 0.15, size))) / own >= 0.6;
}

export function union(boxes: PixelBox[]): PixelBox | null {
  if (boxes.length === 0) return null;
  return boxes.reduce((acc, b) => ({
    left: Math.min(acc.left, b.left),
    top: Math.min(acc.top, b.top),
    right: Math.max(acc.right, b.right),
    bottom: Math.max(acc.bottom, b.bottom),
  }));
}
