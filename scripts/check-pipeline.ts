/**
 * Offline checks for the scan pipeline, $0: geometry, the SAM instance filter,
 * the box fallback, failure handling and mask contours; then the recipe
 * rules: streaming, checks, the correction round, the score and servings.
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
import type { CookRequest, CookResult } from "../lib/meta/cook";
import { defaultFilters } from "../lib/recipes/filters";
import { defaultPantry } from "../lib/recipes/pantry";
import { runCooking } from "../lib/recipes/run";
import { scaleAmount } from "../lib/recipes/scale";
import { clock, timersIn } from "../lib/recipes/timers";
import { downsample, encodeWav } from "../lib/client/voice";
import { daysUntil, parsePrintedDate } from "../lib/meta/dates";
import { parseReceipt } from "../lib/meta/receipt";
import { factorFor, impactOf, weightKg } from "../lib/impact";
import { cookCommand } from "../lib/voice/commands";
import { filtersFrom, parseKitchenIntent } from "../lib/voice/kitchen";
import type { CookedRecipe } from "../lib/recipes/schema";
import { readRecipeStream } from "../lib/recipes/stream";
import { antiWasteScore, checkRecipe, matchIngredient, type KitchenItem } from "../lib/recipes/validate";

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
      for (let i = 0; i < raw.length;) {
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

  // ——— Recipes ———

  const kitchen: KitchenItem[] = replayPerception(recording).ingredients.map((i, index) => ({
    id: `i${index}`,
    name: i.name,
    quantity: i.quantity,
    daysLeft: i.daysLeft,
    category: i.category,
  }));
  const req: CookRequest = { kitchen, pantry: defaultPantry, filters: defaultFilters, locale: "en" };
  const dish = (overrides: Partial<CookedRecipe> = {}): CookedRecipe => ({
    title: "Spinach soup",
    pitch: "",
    minutes: 25,
    servings: 2,
    equipment: ["hob"],
    dishes: 1,
    diet: ["vegetarian"],
    uses: [
      { ingredient: "spinach", amount: "1 box", share: 1 },
      { ingredient: "broccoli", amount: "1 head", share: 1 },
    ],
    staples: ["oil", "salt-pepper"],
    toBuy: [],
    steps: ["Cook.", "Blend."],
    ...overrides,
  });

  await check("recipes: names match exactly, then by plural, then inside each other, the most urgent first", () => {
    assert.equal(matchIngredient("Spinach", kitchen)?.name, "spinach");
    assert.equal(matchIngredient("zucchinis", kitchen)?.name, "zucchini");
    assert.equal(matchIngredient("carrot", kitchen)?.name, "baby carrot");
    assert.equal(matchIngredient("spaghetti", kitchen), null);
  });

  await check("recipes: a clean recipe passes; spaghetti, time, oven and diet are caught", () => {
    assert.deepEqual(checkRecipe(dish(), req).issues, []);
    const strict = {
      ...req,
      filters: { ...defaultFilters, maxMinutes: 15 as const, equipment: "one-pan" as const, diet: ["vegan" as const] },
    };
    const bad = dish({
      equipment: ["oven"],
      uses: [...dish().uses, { ingredient: "spaghetti", amount: "200 g", share: 1 }, { ingredient: "mozzarella", amount: "1", share: 1 }],
      staples: ["butter"],
    });
    const codes = checkRecipe(bad, strict).issues.map((i) => i.code);
    assert.deepEqual([...new Set(codes)].sort(), ["diet", "equipment", "time", "unknown"]);
  });

  await check("recipes: emergency mode needs two of the most urgent items, ties included", () => {
    const urgent = { ...req, filters: { ...defaultFilters, emergency: true } };
    assert.deepEqual(checkRecipe(dish(), urgent).issues, []);
    const lazy = dish({
      uses: [
        { ingredient: "lime", amount: "1", share: 1 },
        { ingredient: "spinach", amount: "1", share: 0.5 },
      ],
    });
    assert.deepEqual(checkRecipe(lazy, urgent).issues, [{ code: "urgent", used: 1 }]);
  });

  await check("recipes: the score rewards the most urgent items and caps at 100", () => {
    const soup = antiWasteScore(checkRecipe(dish(), req).uses, kitchen);
    const limes = antiWasteScore(checkRecipe(dish({ uses: [{ ingredient: "lime", amount: "3", share: 1 }] }), req).uses, kitchen);
    assert.ok(soup > limes && soup <= 100 && limes >= 0, `${soup} vs ${limes}`);
    const everything = kitchen.map((i) => ({ ingredient: i.name, amount: "all", share: 1 }));
    assert.equal(antiWasteScore(checkRecipe(dish({ uses: everything }), req).uses, kitchen), 100);
  });

  await check("recipes: servings scale numbers and fractions, and the words agree", () => {
    assert.equal(scaleAmount("200 g", 1.5), "300 g");
    assert.equal(scaleAmount("1 1/2 cups", 2), "3 cups");
    assert.equal(scaleAmount("½ lemon", 2), "1 lemon");
    assert.equal(scaleAmount("½ lemon", 4), "2 lemons");
    assert.equal(scaleAmount("2,5 dl", 2, "fr"), "5 dl");
    assert.equal(scaleAmount("a pinch", 3), "a pinch");
    assert.equal(scaleAmount("1 box", 2), "2 boxes");
    assert.equal(scaleAmount("1 large onion, diced", 2), "2 large onions, diced");
    assert.equal(scaleAmount("2 tomatoes", 0.5), "1 tomato");
    assert.equal(scaleAmount("1 tête entière", 2, "fr"), "2 têtes entières");
    assert.equal(scaleAmount("1 orange en quartiers, en dessert", 2, "fr"), "2 oranges en quartiers, en dessert");
    assert.equal(scaleAmount("2 entières", 0.5, "fr"), "1 entière");
    assert.equal(scaleAmount("1 c. à soupe", 2, "fr"), "2 c. à soupe");
    assert.equal(scaleAmount("un petit filet, environ 60 ml", 0.5, "fr"), "un petit filet, environ 30 ml");
    assert.equal(scaleAmount("2 radis", 0.5, "fr"), "1 radis");
  });

  await check("cooking mode: steps offer timers for the durations they mention", () => {
    assert.deepEqual(
      timersIn("Rôtissez 30 minutes en remuant à mi-cuisson.").map((t) => t.seconds),
      [1800],
    );
    assert.deepEqual(
      timersIn("Simmer for 10 to 12 min, then rest 5 minutes").map((t) => t.seconds),
      [600, 300],
    );
    assert.deepEqual(
      timersIn("Cuire 1 h à 180°C").map((t) => t.seconds),
      [3600],
    );
    assert.deepEqual(
      timersIn("Faites revenir 2 minutes, puis 30 sec de plus").map((t) => t.seconds),
      [120, 30],
    );
    assert.deepEqual(timersIn("Chauffez le four à 200°C. Coupez 2 tomates."), []);
    assert.equal(clock(90), "1:30");
    assert.equal(clock(3600), "1:00:00");
  });

  await check("voice: cooking mode hears its commands without a model, in French and English", () => {
    assert.deepEqual(cookCommand("next"), { kind: "next" });
    assert.deepEqual(cookCommand("Suivant !"), { kind: "next" });
    assert.deepEqual(cookCommand("timer five minutes"), { kind: "timer", seconds: 300 });
    assert.deepEqual(cookCommand("Lance un minuteur de 10 minutes"), { kind: "timer", seconds: 600 });
    assert.deepEqual(cookCommand("minuteur"), { kind: "timer", seconds: 0 });
    assert.deepEqual(cookCommand("Arrête le minuteur"), { kind: "stopTimer" });
    assert.deepEqual(cookCommand("can you repeat that?"), { kind: "repeat" });
    assert.deepEqual(cookCommand("Répète"), { kind: "repeat" });
    assert.deepEqual(cookCommand("On revient en arrière, précédent"), { kind: "previous" });
    assert.equal(cookCommand("le chat dort"), null);
  });

  await check("voice: a sentence's changes are read leniently and filters keep the chosen servings", () => {
    const intent = parseKitchenIntent(
      JSON.stringify({
        add: [{ name: " rice ", quantity: "a bowl", category: "leftover", daysLeft: 2.4 }, { name: "" }],
        remove: ["spinach", "spinach"],
        filters: null,
        reply: "Done.",
      }),
    );
    assert.deepEqual(intent.add, [{ name: "rice", quantity: "a bowl", category: "leftover", daysLeft: 2 }]);
    assert.deepEqual(intent.remove, ["spinach"]);
    assert.deepEqual(parseKitchenIntent("not json"), { add: [], remove: [], filters: null, reply: "" });
    const chosen = filtersFrom(
      { emergency: false, maxMinutes: 15, equipment: "one-pan", diet: ["vegetarian"], fewDishes: false, servings: null },
      defaultFilters,
    );
    assert.equal(chosen.servings, 2);
    assert.equal(chosen.maxMinutes, 15);
  });

  await check("dates: a printed use-by date becomes days left; packing dates and guesses do not", () => {
    const read = parsePrintedDate(JSON.stringify({ found: true, date: "2026-11-04", kind: "use_by", text: "04/11/2026" }));
    assert.equal(daysUntil(read, "2026-10-30"), 5);
    assert.equal(daysUntil({ ...read, date: "2026-10-20" }, "2026-10-30"), 0);
    assert.equal(daysUntil({ ...read, kind: "packed" }, "2026-10-30"), null);
    assert.equal(parsePrintedDate(JSON.stringify({ found: true, date: "04/11", kind: "use_by", text: "04/11" })).found, false);
    assert.equal(parsePrintedDate("{").found, false);
  });

  await check("receipts: food lines are read leniently, capped and cleaned", () => {
    const receipt = parseReceipt(
      JSON.stringify({
        date: "2026-10-28",
        store: "Marché",
        items: [
          { name: " tomato ", quantity: "1 kg", category: "produce", daysLeft: 5.4 },
          { name: "", quantity: "1" },
          { name: "yogurt", category: "nope", daysLeft: 99 },
        ],
      }),
    );
    assert.equal(receipt.date, "2026-10-28");
    assert.deepEqual(
      receipt.items.map((i) => [i.name, i.category, i.daysLeft]),
      [
        ["tomato", "produce", 5],
        ["yogurt", "other", 60],
      ],
    );
    assert.equal(parseReceipt(JSON.stringify({ date: "28/10", items: [] })).date, null);
    assert.deepEqual(parseReceipt("oops").items, []);
  });

  await check("impact: weights come from the quantity, carbon from Agribalyse by name then category", () => {
    assert.equal(weightKg({ name: "tomato", quantity: "4", category: "produce" }), 0.48);
    assert.equal(weightKg({ name: "natural yogurt", quantity: "4 x 125 g", category: "dairy" }), 0.5);
    assert.equal(weightKg({ name: "milk", quantity: "1 L", category: "dairy" }), 1);
    assert.equal(weightKg({ name: "red pepper", quantity: "half", category: "produce" }), 0.09);
    assert.equal(factorFor({ name: "mozzarella", category: "dairy" }).co2e, 5.14);
    assert.equal(factorFor({ name: "mystery stew", category: "leftover" }).co2e, 2);
    const beef = impactOf({ name: "beef steak", quantity: "250 g", category: "meat" }, 0.5);
    assert.ok(Math.abs(beef.kg - 0.125) < 1e-9 && Math.abs(beef.co2e - 0.125 * 28.01) < 1e-9);
  });

  await check("voice: clips are 16 kHz mono 16-bit WAV", async () => {
    const tone = new Float32Array(48_000).map((_, i) => Math.sin(i / 10) * 0.5);
    const down = downsample(tone, 48_000);
    assert.equal(down.length, 16_000);
    const wav = new Uint8Array(await encodeWav(down).arrayBuffer());
    const view = new DataView(wav.buffer);
    assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 16_000);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(wav.length, 44 + 16_000 * 2);
  });

  await check("recipes: the stream shows each title before its recipe, however the text is split", async () => {
    const text = JSON.stringify({ recipes: [dish(), dish({ title: 'Broccoli "gratin"' })] });
    for (const step of [1, 7, text.length]) {
      const log: string[] = [];
      const chunks = Array.from({ length: Math.ceil(text.length / step) }, (_, i) => text.slice(i * step, (i + 1) * step));
      await readRecipeStream(chunks, {
        onTitle: (i, title) => void log.push(`title ${i} ${title}`),
        onRecipe: (i) => void log.push(`recipe ${i}`),
      });
      assert.deepEqual(log, ["title 0 Spinach soup", "recipe 0", 'title 1 Broccoli "gratin"', "recipe 1"], `chunks of ${step}`);
    }
  });

  await check("recipes: one correction round, kept only when it breaks fewer rules", async () => {
    const feed = async (recipes: CookedRecipe[], handlers: Parameters<typeof readRecipeStream>[1]): Promise<CookResult> => {
      const rawText = await readRecipeStream([JSON.stringify({ recipes })], handlers);
      return { model: "fake", rawText, recipes, costUsd: 0, ms: 0 };
    };
    const pasta = dish({ title: "Pasta", uses: [{ ingredient: "spaghetti", amount: "200 g", share: 1 }, ...dish().uses] });
    const corrected: string[] = [];
    const summary = await runCooking(
      {
        kind: "live",
        cook: (_r, h) => feed([dish(), pasta], h),
        fix: (_r, broken, h) => {
          corrected.push(...broken.map((b) => b.recipe.title));
          return feed([dish({ title: "Pasta, fixed" })], h);
        },
      },
      req,
    );
    assert.deepEqual(corrected, ["Pasta"]);
    assert.equal(summary.recipes[1]?.recipe.title, "Pasta, fixed");
    assert.equal(summary.recipes[1]?.fixed, true);
    assert.equal(summary.recipes[0]?.fixed, false);
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
