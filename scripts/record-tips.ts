/**
 * Writes storage tips once with the real Muse Spark for a recording's most
 * urgent items, in English and French, and stores them in the recording so
 * a demo session shows them at $0.
 *
 *   npm run record:tips
 *   npm run record:tips -- --recording fridge-full.live
 */
import { config as loadEnv } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { hasMetaKey } from "../lib/meta/client";
import { pickUrgent, tipsKey, writeTips } from "../lib/meta/tips";
import { replayPerception, type Recording } from "../lib/replay/recording";

loadEnv({ path: ".env.local", override: false });

const { values } = parseArgs({ options: { recording: { type: "string", default: "fridge-drawers.live" } } });

async function main() {
  if (!hasMetaKey()) throw new Error("MODEL_API_KEY is not set");
  const file = path.join("fixtures", "recordings", `${values.recording}.json`);
  const recording = JSON.parse(await readFile(file, "utf8")) as Recording;
  const items = pickUrgent(replayPerception(recording).ingredients).map((i) => ({
    name: i.name,
    quantity: i.quantity,
    daysLeft: i.daysLeft,
  }));
  const key = tipsKey(items.map((i) => i.name));
  console.log(`urgent: ${items.map((i) => `${i.name} D-${i.daysLeft}`).join(", ")}`);
  const tips = [];
  for (const locale of ["en", "fr"] as const) {
    const result = await writeTips(items, locale);
    console.log(`\n${locale}: ${result.tips.length} tips in ${result.ms} ms, $${result.costUsd.toFixed(4)}`);
    for (const tip of result.tips)
      console.log(`  · ${tip.item} → ${tip.where}, +${tip.extraDays} d: ${tip.how} | ${tip.tooLate.action}: ${tip.tooLate.how}`);
    tips.push({ locale, key, rawText: result.rawText, ms: result.ms, costUsd: result.costUsd });
  }
  recording.tips = tips;
  await writeFile(file, JSON.stringify(recording, null, 2));
  console.log(`\nSaved ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
