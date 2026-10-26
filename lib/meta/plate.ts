import { META_BASE_URL } from "./client";
import { MODELS } from "./models";

/**
 * Muse Image edit: turn the user's own fridge photo plus a recipe into the plated dish.
 * Uses Meta's JSON variant of /images/edits (an `images` array of URLs or data URLs).
 */
export async function plate(sourceImageUrl: string, recipeTitle: string, ingredients: string[]) {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("MODEL_API_KEY is not set.");
  const started = Date.now();

  const res = await fetch(`${META_BASE_URL}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODELS.plate,
      prompt: `Using the ingredients visible in this photo (${ingredients.join(", ")}), show the finished dish "${recipeTitle}" plated on a simple ceramic plate, overhead three-quarter view, soft daylight, home kitchen, photorealistic. No text.`,
      images: [{ image_url: sourceImageUrl }],
      n: 1,
      size: "1024x1024",
      output_format: "webp",
    }),
  });
  if (!res.ok) throw new Error(`Muse Image ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as { data: { b64_json?: string; url?: string }[] };
  const first = body.data[0];
  if (!first?.b64_json) throw new Error("Muse Image returned no b64_json image.");
  return { webp: Buffer.from(first.b64_json, "base64"), ms: Date.now() - started };
}
