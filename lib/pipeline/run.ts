import { buildObjectPrompt } from "@meta-sam/parser";
import type { PerceivedIngredient, Perception } from "../pantry/schema";
import { belongsTo, gridToPixels, type PixelBox, type Size } from "./geometry";
import { masksOf, parseSamText, type MaskData } from "./sam";
import type { Perceived, VisionProvider } from "./types";

export type Segmentation = "concept" | "box";

export type PipelineEvents = {
  /** One ingredient, as soon as Muse Spark has described it; its segmentation starts right after. */
  perceivedItem?(item: PerceivedIngredient, index: number): Promise<void> | void;
  /** Muse Spark's answer is complete; every item has gone through perceivedItem first. */
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

/** Runs jobs as they are added, at most `limit` at a time. */
function workQueue(limit: number) {
  const waiting: (() => Promise<void>)[] = [];
  const all: Promise<void>[] = [];
  let running = 0;
  const next = () => {
    while (running < limit && waiting.length > 0) {
      const job = waiting.shift()!;
      running++;
      const done = job().finally(() => {
        running--;
        next();
      });
      // drain() rethrows; this handler only keeps Node from flagging the rejection before then.
      done.catch(() => {});
      all.push(done);
    }
  };
  return {
    add(job: () => Promise<void>) {
      waiting.push(job);
      next();
    },
    /** Resolves once every added job, including ones still queued, has finished. */
    async drain() {
      while (waiting.length > 0 || all.length > 0) {
        const batch = all.splice(0);
        await Promise.all(batch);
        if (batch.length === 0) await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

/** Muse Spark's phrase first, then its plain name when different. */
function conceptPhrases(item: { samPrompt: string; name: string }): string[] {
  const phrases = [item.samPrompt.trim(), item.name.trim()].filter(Boolean);
  return phrases.filter((p, i) => phrases.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
}

const areaOf = (m: MaskData) => (m.bounds.right - m.bounds.left) * (m.bounds.bottom - m.bounds.top);

/**
 * Perceive while segmenting: each ingredient Muse Spark finishes describing is
 * shown and sent to SAM right away (concept prompt, then its plain name). Once
 * the answer is complete and every concept request is back, the misses get one
 * batched box prompt built from Muse Spark's boxes.
 */
export async function runPipeline(
  provider: VisionProvider,
  size: Size,
  events: PipelineEvents = {},
  options: PipelineOptions = {},
): Promise<PipelineSummary> {
  const started = Date.now();
  const { concurrency = 8, maxInstances = 8 } = options;

  const items: PerceivedIngredient[] = [];
  const sparkBoxes: PixelBox[] = [];
  const concept: number[] = [];
  const box: number[] = [];
  const none: number[] = [];
  const missed: number[] = [];
  const queue = workQueue(concurrency);
  let costUsd = 0;

  const segment = async (index: number) => {
    let kept: MaskData[] = [];
    // SAM finds nothing for some phrasings ("box of green spinach"); the plain name gets a second try.
    for (const phrase of conceptPhrases(items[index])) {
      try {
        const call = await provider.segmentConcept(index, phrase);
        costUsd += call.costUsd;
        kept = masksOf(await parseSamText(call.rawText))
          .filter((m) => belongsTo(m.bounds, sparkBoxes[index], size))
          .sort((a, b) => areaOf(b) - areaOf(a))
          .slice(0, maxInstances);
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
  };

  const accept = async (item: PerceivedIngredient, index: number) => {
    if (index !== items.length) return; // Items arrive in answer order, each once.
    items.push(item);
    sparkBoxes.push(gridToPixels(item.bbox, size));
    await events.perceivedItem?.(item, index);
    queue.add(() => segment(index));
  };

  let perceived: Perceived;
  try {
    perceived = await provider.perceive(accept);
  } catch (error) {
    await queue.drain(); // Let started requests settle before the run fails.
    throw error;
  }
  costUsd += perceived.costUsd;

  // A provider that does not stream, or an item only the final parse recovered.
  for (const [index, item] of perceived.perception.ingredients.entries()) await accept(item, index);
  const perception: Perception = { ...perceived.perception, ingredients: items };
  await events.perceived?.({ ...perceived, perception });
  await queue.drain();

  missed.sort((a, b) => a - b);
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

  return { perception, concept, box, none, costUsd, ms: Date.now() - started };
}
