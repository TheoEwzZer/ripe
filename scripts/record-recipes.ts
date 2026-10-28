/**
 * Cooks once with the real Muse Wonder on a recording's untouched inventory,
 * imagines each plate with Muse Image, and stores both in the recording so a
 * demo session replays them at $0. Runs the same checks and correction round
 * as the app. Spending is capped by META_BUDGET_USD (default $0.30).
 *
 *   npm run record:recipes -- --locale en
 *   npm run record:recipes -- --locale fr --plates
 *   npm run record:recipes -- --emergency --max 15     # another filter set
 *   META_BASE_URL=http://localhost:8787/v1 MODEL_API_KEY=fake npm run record:recipes -- --out /tmp/rec.json
 */
import { config as loadEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Budget } from "../lib/meta/budget";
import { hasMetaKey, metaBaseUrl } from "../lib/meta/client";
import { COOK_RESERVE_USD, FIX_RESERVE_USD, cook, fixRecipes, type CookRequest } from "../lib/meta/cook";
import { IMAGE_USD_PER_IMAGE } from "../lib/meta/models";
import { plate } from "../lib/meta/plate";
import { defaultFilters, filtersKey, type CookFilters, type TimeLimit } from "../lib/recipes/filters";
import { defaultPantry, pantryKey } from "../lib/recipes/pantry";
import { runCooking, type RecipeSource } from "../lib/recipes/run";
import { issueText } from "../lib/recipes/validate";
import { kitchenKey, replayPerception, type RecordedCooking, type Recording } from "../lib/replay/recording";

loadEnv({ path: ".env.local", override: false });

const { values } = parseArgs({
  options: {
    recording: { type: "string", default: "fridge-drawers.live" },
    locale: { type: "string", default: "en" },
    plates: { type: "boolean", default: false },
    emergency: { type: "boolean", default: false },
    max: { type: "string" },
    out: { type: "string" },
  },
});

async function main() {
  if (!hasMetaKey()) {
    console.error("MODEL_API_KEY is missing. Add it to .env.local. Nothing was called, nothing was spent.");
    process.exit(1);
  }
  const locale = values.locale === "fr" ? "fr" : "en";
  const file = path.join("fixtures", "recordings", `${values.recording}.json`);
  const recording = JSON.parse(await readFile(file, "utf8")) as Recording;
  const budget = Budget.fromEnv(0.3);

  // Exactly what Convex stores for an untouched demo scan (convex/scans.ts addIngredient).
  const kitchen = replayPerception(recording).ingredients.map((i, index) => ({
    id: `i${index}`,
    name: i.name,
    quantity: i.quantity,
    daysLeft: Math.max(0, Math.round(i.daysLeft)),
    category: i.category,
  }));
  const filters: CookFilters = {
    ...defaultFilters,
    emergency: values.emergency!,
    ...(values.max ? { maxMinutes: Number(values.max) as TimeLimit } : {}),
  };
  const req: CookRequest = { kitchen, pantry: defaultPantry, filters, locale };
  console.log(`API: ${metaBaseUrl()}  ·  cap $${budget.capUsd.toFixed(2)}  ·  ${values.recording}  ·  ${locale}  ·  ${filtersKey(filters)}`);

  const source: RecipeSource = {
    kind: "live",
    cook: async (r, handlers) => {
      budget.reserve("cook", COOK_RESERVE_USD);
      const result = await cook(r, handlers);
      budget.settle("cook", COOK_RESERVE_USD, result.costUsd);
      return result;
    },
    fix: async (r, broken, handlers) => {
      budget.reserve("fix", FIX_RESERVE_USD);
      const result = await fixRecipes(r, broken, handlers);
      budget.settle("fix", FIX_RESERVE_USD, result.costUsd);
      return result;
    },
  };

  const t0 = Date.now();
  const summary = await runCooking(source, req, {
    draft: (i, title) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} s  title ${i + 1}: ${title}`),
    recipe: (i, c) =>
      console.log(
        `  ${((Date.now() - t0) / 1000).toFixed(1)} s  recipe ${i + 1} ${c.fixed ? "(fixed) " : ""}score ${c.score}, ${c.recipe.minutes} min` +
          (c.issues.length ? `\n      ✗ ${c.issues.map(issueText).join("\n      ✗ ")}` : ""),
      ),
    fixing: (indexes) => console.log(`  correcting ${indexes.map((i) => i + 1).join(", ")}…`),
  });
  console.log(`✓ ${summary.cook.model}: ${summary.recipes.filter(Boolean).length} recipes in ${summary.cook.ms} ms, $${summary.cook.costUsd.toFixed(4)}`);
  if (summary.fix) console.log(`✓ correction in ${summary.fix.ms} ms, $${summary.fix.costUsd.toFixed(4)}`);

  const plates: RecordedCooking["plates"] = [];
  if (values.plates) {
    const photo = await readFile(path.join("public", recording.image.src));
    const dataUrl = `data:image/jpeg;base64,${photo.toString("base64")}`;
    await mkdir(path.join("public", "fixtures", "plates"), { recursive: true });
    for (const [i, checked] of summary.recipes.entries()) {
      if (!checked) {
        plates.push(null);
        continue;
      }
      budget.reserve("plate", IMAGE_USD_PER_IMAGE);
      const { webp, ms } = await plate(dataUrl, checked.recipe.title, checked.recipe.uses.map((u) => u.ingredient));
      budget.settle("plate", IMAGE_USD_PER_IMAGE, IMAGE_USD_PER_IMAGE);
      const name = `${values.recording}.${locale}.${filtersKey(filters)}.${i}.webp`;
      await writeFile(path.join("public", "fixtures", "plates", name), webp);
      plates.push({ src: `/fixtures/plates/${name}`, ms });
      console.log(`✓ plate ${i + 1} in ${ms} ms`);
    }
  }

  const entry: RecordedCooking = {
    locale,
    filtersKey: filtersKey(filters),
    pantryKey: pantryKey(defaultPantry),
    kitchenKey: kitchenKey(kitchen),
    model: summary.cook.model,
    rawText: summary.cook.rawText,
    ms: summary.cook.ms,
    costUsd: summary.cook.costUsd,
    ...(summary.fix ? { fix: { rawText: summary.fix.rawText, ms: summary.fix.ms, costUsd: summary.fix.costUsd } } : {}),
    plates,
  };
  const same = (c: RecordedCooking) => c.locale === entry.locale && c.filtersKey === entry.filtersKey && c.pantryKey === entry.pantryKey;
  recording.cooking = [...(recording.cooking ?? []).filter((c) => !same(c)), entry];
  recording.totalCostUsd += budget.totalUsd;
  const out = values.out ?? file;
  await writeFile(out, JSON.stringify(recording, null, 2));
  console.log(`\nSaved ${out}  ·  spent ≈ $${budget.totalUsd.toFixed(4)}`);
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
