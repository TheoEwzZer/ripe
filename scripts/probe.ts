/**
 * Calls the real Meta models once on a test photo through the same pipeline
 * as the app, prints what the wire formats look like and saves everything as
 * a replayable recording. Spending is capped by META_BUDGET_USD (default
 * $0.25) before each call. Recipes and plates: scripts/record-recipes.ts.
 *
 *   npm run probe                                   # models list (free) + perceive + segment
 *   npm run probe -- --steps perceive                # stop after Muse Spark
 *   npm run probe -- --photo fridge-full.jpg
 *   npm run probe -- --contributor                  # muse-spark contributor variant, ~12x cheaper
 *   npm run probe -- --out /tmp/rec.json            # write somewhere else (tests against fake-meta)
 */
import { config as loadEnv } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Budget } from "../lib/meta/budget";
import { hasMetaKey, metaBaseUrl, metaClient } from "../lib/meta/client";
import { liveProvider } from "../lib/meta/live-provider";
import { runPipeline } from "../lib/pipeline/run";
import type { VisionProvider } from "../lib/pipeline/types";
import type { Recording } from "../lib/replay/recording";

loadEnv({ path: ".env.local", override: false });

const { values } = parseArgs({
  options: {
    photo: { type: "string", default: "fridge-drawers.jpg" },
    steps: { type: "string", default: "segment" },
    contributor: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const steps = new Set(values.steps!.split(","));
const photoPath = path.join("public", "fixtures", "photos", values.photo!);

function jpegSize(buffer: Buffer): { width: number; height: number } {
  // Baseline/progressive JPEG SOF scan: enough for our fixtures without an image library.
  for (let i = 2; i < buffer.length; ) {
    const marker = buffer.readUInt16BE(i);
    const length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffc3) return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  throw new Error("Not a JPEG");
}

/** Wraps a provider and keeps every raw answer for the recording. */
function recorder(inner: VisionProvider, recording: Recording): VisionProvider {
  return {
    kind: inner.kind,
    async perceive(onItem) {
      const result = await inner.perceive(onItem);
      recording.perception = { model: result.model, rawText: result.rawText, ms: result.ms, costUsd: result.costUsd };
      return result;
    },
    async segmentConcept(ingredientIndex, prompt) {
      const result = await inner.segmentConcept(ingredientIndex, prompt);
      recording.segments.push({ ingredientIndex, prompt, encoding: "one_bit", rawText: result.rawText, ms: result.ms });
      return result;
    },
    async segmentBoxes(prompt, ingredientIndexes) {
      const result = await inner.segmentBoxes(prompt, ingredientIndexes);
      recording.boxFallback = { ingredientIndexes, prompt, rawText: result.rawText, ms: result.ms };
      return result;
    },
  };
}

async function main() {
  if (!hasMetaKey()) {
    console.error("MODEL_API_KEY is missing. Add it to .env.local (see .env.example). Nothing was called, nothing was spent.");
    process.exit(1);
  }
  const budget = Budget.fromEnv();
  console.log(`API: ${metaBaseUrl()}  ·  budget cap $${budget.capUsd.toFixed(2)}  ·  photo ${values.photo}  ·  steps ${[...steps].join(", ")}`);

  const models = await metaClient().models.list();
  console.log(`✓ key works, ${models.data.length} models visible: ${models.data.map((m) => m.id).join(", ")}`);

  const jpeg = await readFile(photoPath);
  const size = jpegSize(jpeg);
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  const id = `${path.parse(values.photo!).name}.live`;

  const recording: Recording = {
    id,
    source: "live",
    createdAt: new Date().toISOString(),
    image: { src: `/fixtures/photos/${values.photo}`, ...size },
    perception: { model: "", rawText: "", ms: 0, costUsd: 0 },
    segments: [],
    totalCostUsd: 0,
  };

  const live = liveProvider(dataUrl, {
    contributor: values.contributor,
    reserve: (label, usd) => budget.reserve(label, usd),
    settle: (label, estimate, actual) => budget.settle(label, estimate, actual),
  });
  // Without the segment step, stop right after perception.
  const provider: VisionProvider = steps.has("segment")
    ? recorder(live, recording)
    : { ...recorder(live, recording), segmentConcept: async () => ({ rawText: "", ms: 0, costUsd: 0 }), segmentBoxes: async () => ({ rawText: "", ms: 0, costUsd: 0 }) };

  const t0 = Date.now();
  const summary = await runPipeline(provider, size, {
    perceivedItem: (item, index) => {
      if (index < 3) console.log(`  + streamed "${item.name}" at ${Date.now() - t0} ms`);
    },
    perceived: (p) => {
      console.log(`\n✓ ${p.model}: ${p.perception.ingredients.length} ingredients in ${p.ms} ms, $${p.costUsd.toFixed(4)}`);
      for (const i of p.perception.ingredients) {
        const b = i.bbox;
        const off = [b.x_min, b.y_min, b.x_max, b.y_max].some((v) => v < 0 || v > 1000) ? "  ⚠ outside 0–1000" : "";
        console.log(`  · ${i.name.padEnd(18)} D-${String(i.daysLeft).padEnd(3)} "${i.samPrompt}"  [${b.x_min},${b.y_min} → ${b.x_max},${b.y_max}]${off}`);
      }
    },
  });

  if (steps.has("segment")) {
    const name = (i: number) => summary.perception.ingredients[i].name;
    console.log(`\n✓ sam-3.1: ${summary.concept.length} by concept, ${summary.box.length} by box fallback, ${summary.none.length} unsegmented`);
    if (summary.box.length) console.log(`  box fallback: ${summary.box.map(name).join(", ")}`);
    if (summary.none.length) console.log(`  unsegmented: ${summary.none.map(name).join(", ")}`);
    const first = recording.segments.find((s) => s.rawText);
    if (first) console.log(`  first SAM line: ${first.rawText.slice(0, 160)}…`);
  }

  recording.totalCostUsd = budget.totalUsd;
  const file = values.out ?? path.join("fixtures", "recordings", `${id}.json`);
  await writeFile(file, JSON.stringify(recording, null, 2));
  console.log(`\nSaved ${file}  ·  total spent ≈ $${budget.totalUsd.toFixed(4)}`);
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
