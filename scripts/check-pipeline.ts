/**
 * Offline checks for the scan pipeline, $0: geometry, the SAM instance filter,
 * the box fallback, failure handling and mask contours.
 *
 *   npm run check:pipeline
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeMaskToRaster } from "@meta-sam/parser";
import { contourInternals, rasterToPath } from "../lib/masks/contour";
import { belongsTo, gridToPixels } from "../lib/pipeline/geometry";
import { ArrayItemStream } from "../lib/pipeline/json-stream";
import { runPipeline } from "../lib/pipeline/run";
import { masksOf, parseSamText, toSegmentationMask, type MaskData } from "../lib/pipeline/sam";
import type { VisionProvider } from "../lib/pipeline/types";
import { replayProvider } from "../lib/replay/provider";
import { replayPerception, type Recording } from "../lib/replay/recording";

const recording = JSON.parse(readFileSync("fixtures/recordings/fridge-drawers.mock.json", "utf8")) as Recording;
const size = { width: recording.image.width, height: recording.image.height };
const names = replayPerception(recording).ingredients.map((i) => i.name);
let passed = 0;

async function check(label: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`✓ ${label}`);
}

async function main() {
  await check("grid boxes clamp to the image and never collapse", () => {
    assert.deepEqual(gridToPixels({ x_min: -5, y_min: 0, x_max: 1003, y_max: 500 }, size), {
      left: 0,
      top: 0,
      right: 1920,
      bottom: 640,
    });
    const flat = gridToPixels({ x_min: 1000, y_min: 1000, x_max: 1000, y_max: 1000 }, size);
    assert.ok(flat.right > flat.left && flat.bottom > flat.top && flat.right <= 1920);
  });

  await check("an instance belongs to the box it mostly sits in", () => {
    const spark = { left: 100, top: 100, right: 300, bottom: 300 };
    assert.equal(belongsTo({ left: 120, top: 120, right: 280, bottom: 310 }, spark, size), true);
    assert.equal(belongsTo({ left: 600, top: 100, right: 800, bottom: 300 }, spark, size), false);
  });

  const masks = new Map<number, { via: string; masks: MaskData[] }>();
  const summary = await runPipeline(replayProvider(recording, { speed: Infinity }), size, {
    masks: (index, list, via) => void masks.set(index, { via, masks: list }),
  });

  await check("replay: every ingredient ends with masks, kiwi through the box fallback", () => {
    assert.equal(masks.size, names.length);
    assert.equal(masks.get(names.indexOf("kiwi"))?.via, "box");
    assert.deepEqual(summary.none, []);
  });

  await check("replay: the concept filter drops the cherry tomatoes matched by 'tomato'", () => {
    assert.equal(masks.get(names.indexOf("tomato"))?.masks.length, 1);
    assert.equal(masks.get(names.indexOf("orange"))?.masks.length, 2);
  });

  await check("stream: objects come out of a JSON array however the text is split", () => {
    const raw = recording.perception.rawText;
    const expected = (JSON.parse(raw) as { ingredients: unknown[] }).ingredients;
    for (const seed of [1, 7, 42]) {
      const stream = new ArrayItemStream("ingredients");
      const got: unknown[] = [];
      let rng = seed;
      for (let i = 0; i < raw.length; ) {
        rng = (rng * 1103515245 + 12345) % 2147483648;
        const n = 1 + (rng % 37);
        got.push(...stream.push(raw.slice(i, i + n)));
        i += n;
      }
      assert.deepEqual(got, expected);
    }
    const tricky = new ArrayItemStream("ingredients");
    const items = tricky.push('{"scene":"fridge","ingredients":[{"name":"a \\"}\\" b","x":[1,{"y":"]"}]},{"name":"c"}]}');
    assert.deepEqual(items, [{ name: 'a "}" b', x: [1, { y: "]" }] }, { name: "c" }]);
    assert.deepEqual(tricky.push("{}"), []);
  });

  await check("stream: each item is saved before its masks, and SAM starts before Muse Spark finishes", async () => {
    const log: string[] = [];
    await runPipeline(replayProvider(recording, { speed: 4 }), size, {
      perceivedItem: (_item, index) => void log.push(`item ${index}`),
      perceived: () => void log.push("perceived"),
      masks: (index) => void log.push(`mask ${index}`),
    });
    for (const [at, entry] of log.entries()) {
      if (entry.startsWith("mask ")) assert.ok(log.indexOf(`item ${entry.slice(5)}`) < at, `${entry} before its item`);
    }
    assert.ok(log.findIndex((e) => e.startsWith("mask ")) < log.indexOf("perceived"), "no mask arrived during perception");
    assert.equal(log.filter((e) => e.startsWith("item ")).length, names.length);
  });

  await check("failures: a throwing concept request falls back to boxes, an empty box answer marks it unsegmented", async () => {
    const base = replayProvider(recording, { speed: Infinity });
    const broken: VisionProvider = {
      ...base,
      segmentConcept: async (index, prompt) => {
        if (index === 0) throw new Error("HTTP 500");
        return base.segmentConcept(index, prompt);
      },
      segmentBoxes: async () => ({ rawText: "", ms: 0, costUsd: 0 }),
    };
    const unsegmented: number[] = [];
    const result = await runPipeline(broken, size, { unsegmented: (i) => void unsegmented.push(i) });
    assert.deepEqual(result.none.sort(), [0, names.indexOf("kiwi")].sort());
    assert.deepEqual(unsegmented.sort(), result.none);
  });

  await check("failures: a perception error stops the run", async () => {
    const provider: VisionProvider = { ...replayProvider(recording), perceive: async () => Promise.reject(new Error("401")) };
    await assert.rejects(runPipeline(provider, size), /401/);
  });

  await check("contours: closed loops whose area matches the mask within 3%", async () => {
    for (const segment of recording.segments) {
      for (const mask of masksOf(await parseSamText(segment.rawText))) {
        const raster = decodeMaskToRaster(toSegmentationMask(mask));
        const { grid, gw, gh, step } = contourInternals.downsample(raster, mask.width, mask.height);
        const cells = grid.reduce((sum, v) => sum + v, 0);
        const traced = contourInternals.traceLoops(grid, gw, gh).reduce((sum, loop) => sum + contourInternals.loopArea(loop), 0);
        assert.ok(Math.abs(traced - cells) / cells < 0.03, `${segment.prompt}: ${traced} vs ${cells} cells (step ${step})`);
        const d = rasterToPath(raster, mask.width, mask.height);
        assert.match(d, /^M[\d.]+ [\d.]+Q/);
        assert.ok(d.length < 12_000, `${segment.prompt}: path is ${d.length} chars`);
      }
    }
  });

  await check("contours: a ring keeps its hole", () => {
    const n = 40;
    const ring = new Uint8Array(n * n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const r = Math.hypot(x - 19.5, y - 19.5);
        ring[y * n + x] = r < 18 && r > 8 ? 1 : 0;
      }
    assert.equal(rasterToPath(ring, n, n).split("M").length - 1, 2);
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
