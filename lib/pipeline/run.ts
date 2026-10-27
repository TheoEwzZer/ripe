import { buildObjectPrompt } from "@meta-sam/parser";
import type { Perception } from "../pantry/schema";
import { belongsTo, gridToPixels, type PixelBox, type Size } from "./geometry";
import { masksOf, parseSamText, type MaskData } from "./sam";
import type { Perceived, VisionProvider } from "./types";

export type Segmentation = "concept" | "box";

export type PipelineEvents = {
  /** Muse Spark's inventory is ready; masks follow. */
  perceived?(result: Perceived): Promise<void> | void;
  /** Masks for one ingredient, emitted as soon as its request returns. */
  masks?(ingredientIndex: number, masks: MaskData[], via: Segmentation): Promise<void> | void;
  /** Neither the concept nor the box prompt produced a usable mask. */
  unsegmented?(ingredientIndex: number): Promise<void> | void;
};

export type PipelineSummary = {
  perception: Perception;
  concept: number[];
  box: number[];
  none: number[];
  costUsd: number;
  ms: number;
};

export type PipelineOptions = {
  /** Parallel SAM requests; the API allows 3,000 per minute. */
  concurrency?: number;
  /** Instances kept per ingredient, largest first. */
  maxInstances?: number;
};

/** SAM 3.1 accepts at most 16 objects per box/point prompt. */
const BOX_BATCH = 16;

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item);
  });
  await Promise.all(runners);
}

/** Muse Spark's phrase first, then its plain name when different. */
function conceptPhrases(item: { samPrompt: string; name: string }): string[] {
  const phrases = [item.samPrompt.trim(), item.name.trim()].filter(Boolean);
  return phrases.filter((p, i) => phrases.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
}

const areaOf = (m: MaskData) => (m.bounds.right - m.bounds.left) * (m.bounds.bottom - m.bounds.top);

/**
 * Perceive, then segment every ingredient in parallel, most urgent first, then
 * retry the misses with one batched box prompt built from Muse Spark's boxes.
 */
export async function runPipeline(
  provider: VisionProvider,
  size: Size,
  events: PipelineEvents = {},
  options: PipelineOptions = {},
): Promise<PipelineSummary> {
  const started = Date.now();
  const { concurrency = 8, maxInstances = 8 } = options;

  const perceived = await provider.perceive();
  await events.perceived?.(perceived);
  let costUsd = perceived.costUsd;

  const items = perceived.perception.ingredients;
  const sparkBoxes: PixelBox[] = items.map((item) => gridToPixels(item.bbox, size));
  const byUrgency = items.map((_, i) => i).sort((a, b) => items[a].daysLeft - items[b].daysLeft);

  const concept: number[] = [];
  const box: number[] = [];
  const none: number[] = [];
  const missed: number[] = [];

  const keep = (index: number, masks: MaskData[]) =>
    masks
      .filter((m) => belongsTo(m.bounds, sparkBoxes[index], size))
      .sort((a, b) => areaOf(b) - areaOf(a))
      .slice(0, maxInstances);

  await pool(byUrgency, concurrency, async (index) => {
    let kept: MaskData[] = [];
    // SAM finds nothing for some phrasings ("box of green spinach"); the plain name gets a second try.
    for (const phrase of conceptPhrases(items[index])) {
      try {
        const call = await provider.segmentConcept(index, phrase);
        costUsd += call.costUsd;
        kept = keep(index, masksOf(await parseSamText(call.rawText)));
      } catch {
        // A failed request is a miss; the next phrase or the box prompt gets another chance.
      }
      if (kept.length > 0) break;
    }
    if (kept.length === 0) {
      missed.push(index);
      return;
    }
    concept.push(index);
    await events.masks?.(index, kept, "concept");
  });

  for (let start = 0; start < missed.length; start += BOX_BATCH) {
    const batch = missed.slice(start, start + BOX_BATCH);
    const found = new Map<number, MaskData[]>();
    try {
      const prompt = buildObjectPrompt({
        size,
        objects: batch.map((index) => ({ id: index, prompts: [{ box: sparkBoxes[index] }] })),
      });
      const call = await provider.segmentBoxes(prompt, batch);
      costUsd += call.costUsd;
      for (const mask of masksOf(await parseSamText(call.rawText))) {
        const index = Number(mask.objectId);
        found.set(index, [...(found.get(index) ?? []), mask]);
      }
    } catch {
      // Leave the whole batch unsegmented; the UI falls back to Muse Spark's box.
    }
    for (const index of batch) {
      const masks = found.get(index) ?? [];
      if (masks.length > 0) {
        box.push(index);
        await events.masks?.(index, masks, "box");
      } else {
        none.push(index);
        await events.unsegmented?.(index);
      }
    }
  }

  return { perception: perceived.perception, concept, box, none, costUsd, ms: Date.now() - started };
}
