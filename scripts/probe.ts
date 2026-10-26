/**
 * Day 1 probe: calls the real Meta models once on a test photo, prints what the
 * wire formats look like and saves everything as a replayable recording.
 * Spending is capped by META_BUDGET_USD (default $0.25) before each call.
 *
 *   npm run probe                                  # models list (free) + perceive + segment
 *   npm run probe -- --steps perceive,segment,cook,plate
 *   npm run probe -- --photo fridge-full.jpg --segments 4
 *   npm run probe -- --contributor                 # muse-spark contributor variant, ~12x cheaper
 */
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { recordsOfKind } from "@meta-sam/parser";
import { Budget } from "../lib/meta/budget";
import { hasMetaKey, metaClient } from "../lib/meta/client";
import { cook } from "../lib/meta/cook";
import { IMAGE_USD_PER_IMAGE, SAM_USD_PER_IMAGE } from "../lib/meta/models";
import { perceive } from "../lib/meta/perceive";
import { plate } from "../lib/meta/plate";
import { segmentConcept, type MaskEncoding } from "../lib/meta/segment";
import { mostUrgent } from "../lib/pantry/freshness";
import type { Recording } from "../lib/replay/recording";

loadEnv({ path: ".env.local", override: false });

const { values } = parseArgs({
  options: {
    photo: { type: "string", default: "fridge-drawers.jpg" },
    steps: { type: "string", default: "perceive,segment" },
    segments: { type: "string", default: "6" },
    encoding: { type: "string", default: "lossless" },
    contributor: { type: "boolean", default: false },
  },
});

const steps = new Set(values.steps!.split(","));
const photoPath = path.join("public", "fixtures", "photos", values.photo!);

async function imageSize(buffer: Buffer): Promise<{ width: number; height: number }> {
  // JPEG SOF scan: enough for our fixtures without pulling in an image library.
  for (let i = 2; i < buffer.length; ) {
    const marker = buffer.readUInt16BE(i);
    const length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffc3) return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  throw new Error("Not a baseline JPEG");
}

async function main() {
  if (!hasMetaKey()) {
    console.error("MODEL_API_KEY is missing. Add it to .env.local (see .env.example). Nothing was called, nothing was spent.");
    process.exit(1);
  }
  const budget = Budget.fromEnv();
  console.log(`Budget cap: $${budget.capUsd.toFixed(2)}  ·  photo: ${values.photo}  ·  steps: ${[...steps].join(", ")}`);

  const models = await metaClient().models.list();
  console.log(`✓ key works, ${models.data.length} models visible: ${models.data.map((m) => m.id).join(", ")}`);

  const jpeg = await readFile(photoPath);
  const size = await imageSize(jpeg);
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

  // 1. Perceive
  budget.reserve("perceive", 0.03);
  const seen = await perceive(dataUrl, { contributor: values.contributor });
  budget.settle("perceive", 0.03, seen.usage.costUsd);
  recording.perception = { model: seen.model, rawText: seen.rawText, ms: seen.ms, costUsd: seen.usage.costUsd };
  const items = seen.perception.ingredients;
  console.log(`\n✓ ${seen.model}: ${items.length} ingredients in ${seen.ms} ms, ${seen.usage.inputTokens} in / ${seen.usage.outputTokens} out tokens, $${seen.usage.costUsd.toFixed(4)}`);
  for (const i of items) {
    const b = i.bbox;
    const outOfGrid = [b.x_min, b.y_min, b.x_max, b.y_max].some((v) => v < 0 || v > 1000) ? "  ⚠ outside 0–1000" : "";
    console.log(`  · ${i.name.padEnd(18)} D-${String(i.daysLeft).padEnd(3)} "${i.samPrompt}"  [${b.x_min},${b.y_min} → ${b.x_max},${b.y_max}]${outOfGrid}`);
  }

  // 2. Segment the most urgent items, one concept per request, in parallel
  if (steps.has("segment")) {
    const targets = mostUrgent(items, Number(values.segments)).map((item) => ({ item, index: items.indexOf(item) }));
    budget.reserve("segment", targets.length * SAM_USD_PER_IMAGE);
    const results = await Promise.all(
      targets.map(({ item }) => segmentConcept(dataUrl, item.samPrompt, values.encoding as MaskEncoding)),
    );
    budget.settle("segment", targets.length * SAM_USD_PER_IMAGE, targets.length * SAM_USD_PER_IMAGE);
    console.log(`\n✓ sam-3.1 × ${targets.length} (${values.encoding})`);
    results.forEach((r, n) => {
      const masks = recordsOfKind(r.result.records, "mask");
      const bytes = r.rawText.length;
      console.log(`  · "${r.prompt}": ${masks.length} mask(s), ${r.ms} ms, ${bytes} chars, ${r.result.outcome.status}, ${r.result.diagnostics.length} diagnostics`);
      recording.segments.push({ ingredientIndex: targets[n].index, prompt: r.prompt, encoding: values.encoding as MaskEncoding, rawText: r.rawText, ms: r.ms });
    });
    console.log(`  first line: ${results[0]?.rawText.slice(0, 160)}…`);
  }

  // 3. Cook
  if (steps.has("cook")) {
    budget.reserve("cook", 0.08);
    const inventory = mostUrgent(items, items.length).map((i) => ({ name: i.name, quantity: i.quantity, daysLeft: i.daysLeft }));
    const cooked = await cook(inventory, { emergency: true, maxMinutes: 30 }, "en");
    budget.settle("cook", 0.08, cooked.usage.costUsd);
    recording.recipes = { model: cooked.model, rawText: cooked.rawText, recipes: cooked.recipes, ms: cooked.ms, costUsd: cooked.usage.costUsd };
    console.log(`\n✓ ${cooked.model}: ${cooked.recipes.length} recipes in ${cooked.ms} ms, $${cooked.usage.costUsd.toFixed(4)}`);
    for (const r of cooked.recipes) console.log(`  · ${r.title} (${r.minutes} min) uses ${r.uses.map((u) => u.ingredient).join(", ")}`);
  }

  // 4. Plate
  if (steps.has("plate") && recording.recipes?.recipes[0]) {
    const first = recording.recipes.recipes[0];
    budget.reserve("plate", IMAGE_USD_PER_IMAGE);
    const plated = await plate(dataUrl, first.title, first.uses.map((u) => u.ingredient));
    budget.settle("plate", IMAGE_USD_PER_IMAGE, IMAGE_USD_PER_IMAGE);
    const out = path.join("public", "fixtures", "plates", `${id}.webp`);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, plated.webp);
    recording.plate = { src: `/fixtures/plates/${id}.webp`, recipeTitle: first.title, ms: plated.ms, costUsd: IMAGE_USD_PER_IMAGE };
    console.log(`\n✓ muse-image-1.0: ${out} in ${plated.ms} ms`);
  }

  recording.totalCostUsd = budget.totalUsd;
  const file = path.join("fixtures", "recordings", `${id}.json`);
  await writeFile(file, JSON.stringify(recording, null, 2));
  console.log(`\nSaved ${file}  ·  total spent ≈ $${budget.totalUsd.toFixed(4)}`);
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
