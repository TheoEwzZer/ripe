import { decodeMaskToRaster, type SegmentationMask } from "@meta-sam/parser";

/**
 * Turns a SAM mask into a smooth SVG path in the mask's own pixel space
 * (translate it by the mask bounds to place it on the photo). Fill it with
 * `fill-rule="evenodd"`: holes wind opposite to the outlines around them.
 *
 * 1. Downsample the raster to at most MAX_CELLS cells per side (a 1,500 px mask
 *    shown at 600 px gains nothing from per-pixel contours).
 * 2. Marching squares on cell centres, every segment oriented with the filled
 *    region on its right, so chaining segments into loops is a walk.
 * 3. Drop collinear vertices, then emit each loop as a quadratic B-spline
 *    through edge midpoints: the 1-cell staircase becomes a smooth curve.
 */

const MAX_CELLS = 200;
/** Loops smaller than this many cells are noise. */
const MIN_LOOP_AREA = 1.5;

type Edge = "T" | "R" | "B" | "L";
type Segment = [from: number, to: number];

// Doubled lattice offsets inside a cell whose top-left cell centre is (0, 0).
const EDGE_OFFSET: Record<Edge, [number, number]> = { T: [1, 0], R: [2, 1], B: [1, 2], L: [0, 1] };
const CORNERS: [bit: number, x: number, y: number][] = [
  [1, 0, 0], // top-left
  [2, 2, 0], // top-right
  [4, 2, 2], // bottom-right
  [8, 0, 2], // bottom-left
];
// Edge pairs per corner case. Saddles (5, 10) read the centre as filled: eight-connected.
const CASE_EDGES: Record<number, [Edge, Edge][]> = {
  1: [["T", "L"]],
  2: [["T", "R"]],
  3: [["L", "R"]],
  4: [["R", "B"]],
  5: [["T", "R"], ["B", "L"]],
  6: [["T", "B"]],
  7: [["L", "B"]],
  8: [["L", "B"]],
  9: [["T", "B"]],
  10: [["T", "L"], ["R", "B"]],
  11: [["R", "B"]],
  12: [["L", "R"]],
  13: [["T", "R"]],
  14: [["T", "L"]],
};

/** Orients each edge pair so the filled side is on the right (y points down). */
const ORIENTED: [Edge, Edge][][] = Array.from({ length: 16 }, (_, corners) =>
  (CASE_EDGES[corners] ?? []).map(([a, b]) => {
    const [ax, ay] = EDGE_OFFSET[a];
    const [bx, by] = EDGE_OFFSET[b];
    const sides = CORNERS.map(([bit, cx, cy]) => ({
      filled: (corners & bit) !== 0,
      right: (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0,
    }));
    // The side holding a single corner decides: a lone corner is what the segment cuts off.
    const rightSide = sides.filter((s) => s.right);
    const decisive = rightSide.length <= sides.length - rightSide.length ? rightSide[0] : sides.find((s) => !s.right)!;
    const filledOnRight = decisive.right === decisive.filled;
    return filledOnRight ? ([a, b] as [Edge, Edge]) : ([b, a] as [Edge, Edge]);
  }),
);

function downsample(raster: Uint8Array, width: number, height: number) {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / MAX_CELLS));
  const gw = Math.ceil(width / step);
  const gh = Math.ceil(height / step);
  if (step === 1) return { grid: raster, gw, gh, step };

  const counts = new Uint32Array(gw * gh);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / step) * gw;
    for (let x = 0; x < width; x++) if (raster[y * width + x]) counts[row + Math.floor(x / step)]++;
  }
  const grid = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const cellH = Math.min(step, height - gy * step);
    for (let gx = 0; gx < gw; gx++) {
      const cellW = Math.min(step, width - gx * step);
      grid[gy * gw + gx] = counts[gy * gw + gx] * 2 >= cellW * cellH ? 1 : 0;
    }
  }
  return { grid, gw, gh, step };
}

function traceLoops(grid: Uint8Array, gw: number, gh: number): [number, number][][] {
  // Doubled coordinates shifted by 2 so the border cells (index -1) stay non-negative.
  const stride = 2 * gw + 5;
  const id = (x: number, y: number) => (y + 2) * stride + (x + 2);
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < gw && y < gh ? grid[y * gw + x] : 0);

  const next = new Map<number, number>();
  for (let cy = -1; cy < gh; cy++) {
    for (let cx = -1; cx < gw; cx++) {
      const corners = at(cx, cy) | (at(cx + 1, cy) << 1) | (at(cx + 1, cy + 1) << 2) | (at(cx, cy + 1) << 3);
      if (corners === 0 || corners === 15) continue;
      for (const [a, b] of ORIENTED[corners]) {
        const [ax, ay] = EDGE_OFFSET[a];
        const [bx, by] = EDGE_OFFSET[b];
        const segment: Segment = [id(2 * cx + ax, 2 * cy + ay), id(2 * cx + bx, 2 * cy + by)];
        next.set(segment[0], segment[1]);
      }
    }
  }

  const loops: [number, number][][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: [number, number][] = [];
    for (let v: number | undefined = start; v !== undefined && !seen.has(v); v = next.get(v)) {
      seen.add(v);
      loop.push([(v % stride) - 2, Math.floor(v / stride) - 2]);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function decimate(loop: [number, number][]): [number, number][] {
  return loop.filter((p, i) => {
    const prev = loop[(i - 1 + loop.length) % loop.length];
    const next = loop[(i + 1) % loop.length];
    return (p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0]) !== 0;
  });
}

/** Shoelace area in doubled units, converted to cells. */
function loopArea(loop: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 8;
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

export function rasterToPath(raster: Uint8Array, width: number, height: number): string {
  const { grid, gw, gh, step } = downsample(raster, width, height);
  // A lattice point (doubled cell coords) back to mask pixels: cell centres sit at step/2.
  const px = (doubled: number) => (doubled / 2) * step + step / 2;

  let d = "";
  for (const raw of traceLoops(grid, gw, gh)) {
    if (loopArea(raw) < MIN_LOOP_AREA) continue;
    const loop = decimate(raw);
    const n = loop.length;
    if (n < 3) continue;
    if (n <= 4) {
      d += `M${loop.map(([x, y]) => `${fmt(px(x))} ${fmt(px(y))}`).join("L")}Z`;
      continue;
    }
    const mid = (i: number) => {
      const [x1, y1] = loop[i % n];
      const [x2, y2] = loop[(i + 1) % n];
      return `${fmt(px((x1 + x2) / 2))} ${fmt(px((y1 + y2) / 2))}`;
    };
    d += `M${mid(0)}`;
    for (let i = 1; i <= n; i++) {
      const [x, y] = loop[i % n];
      d += `Q${fmt(px(x))} ${fmt(px(y))} ${mid(i)}`;
    }
    d += "Z";
  }
  return d;
}

export function maskToPath(mask: SegmentationMask): string {
  return rasterToPath(decodeMaskToRaster(mask), mask.width, mask.height);
}

/** Exposed for scripts/check-pipeline.ts. */
export const contourInternals = { downsample, traceLoops, loopArea };
