import type { CookResult } from "../meta/cook";
import type { RecipeSource } from "../recipes/run";
import { parseCookedSet } from "../recipes/schema";
import { readRecipeStream, replayDeltas, type RecipeStreamHandlers } from "../recipes/stream";
import type { RecordedCooking, Recording } from "./recording";

export type CookingKey = Pick<RecordedCooking, "locale" | "filtersKey" | "pantryKey" | "kitchenKey">;

/** The recorded pass for exactly this kitchen, pantry, filters and language. */
export function findCooking(recording: Recording, key: CookingKey): RecordedCooking | undefined {
  return recording.cooking?.find(
    (c) => c.locale === key.locale && c.filtersKey === key.filtersKey && c.pantryKey === key.pantryKey && c.kitchenKey === key.kitchenKey,
  );
}

/** Something to show when live cooking is off or out of budget: same language first. */
export function closestCooking(recording: Recording, locale: "en" | "fr"): RecordedCooking | undefined {
  return recording.cooking?.find((c) => c.locale === locale) ?? recording.cooking?.[0];
}

async function replay(rawText: string, ms: number, model: string, handlers: RecipeStreamHandlers): Promise<CookResult> {
  const started = Date.now();
  const text = await readRecipeStream(replayDeltas(rawText, ms), handlers);
  return { model, rawText: text, recipes: parseCookedSet(text), costUsd: 0, ms: Date.now() - started };
}

/** Replays a recorded pass with its pacing, capped so the demo stays snappy. */
export function replayRecipeSource(recorded: RecordedCooking, maxMs = 7000): RecipeSource {
  const fix = recorded.fix;
  return {
    kind: "replay",
    cook: (_req, handlers) => replay(recorded.rawText, Math.min(recorded.ms, maxMs), recorded.model, handlers),
    fix: fix && ((_req, _broken, handlers) => replay(fix.rawText, Math.min(fix.ms, maxMs / 2), recorded.model, handlers)),
  };
}
