import { ArrayItemStream } from "../pipeline/json-stream";
import { parseCookedRecipe, parseCookedSet, type CookedRecipe } from "./schema";

export type RecipeStreamHandlers = {
  /** The title of recipe `index` is written: show its card. */
  onTitle?: (index: number, title: string) => Promise<void> | void;
  /** Recipe `index` is complete. */
  onRecipe?: (index: number, recipe: CookedRecipe) => Promise<void> | void;
  /** Recipe `index` closed but could not be read. */
  onDrop?: (index: number) => Promise<void> | void;
};

const TITLE = /^\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function unescape(json: string): string | null {
  try {
    return JSON.parse(`"${json}"`) as string;
  } catch {
    return null;
  }
}

/**
 * Reads Muse Wonder's JSON as it streams, live or replayed: each recipe's
 * title as soon as it is written, then the recipe once its object closes.
 * Returns the full text.
 */
export async function readRecipeStream(deltas: AsyncIterable<string> | Iterable<string>, handlers: RecipeStreamHandlers): Promise<string> {
  const items = new ArrayItemStream("recipes");
  let rawText = "";
  let titled = -1;
  let seen = 0;

  for await (const delta of deltas) {
    rawText += delta;
    const before = items.closed;
    const found = items.push(delta);
    for (const [k, candidate] of found.entries()) {
      const index = before + k;
      const recipe = parseCookedRecipe(candidate);
      if (recipe) {
        if (titled < index) await handlers.onTitle?.(index, recipe.title);
        titled = Math.max(titled, index);
        await handlers.onRecipe?.(index, recipe);
      } else {
        await handlers.onDrop?.(index);
      }
      seen = index + 1;
    }
    const partial = items.current();
    const match = partial && TITLE.exec(partial);
    const title = match && unescape(match[1]);
    if (title && titled < items.closed) {
      titled = items.closed;
      await handlers.onTitle?.(titled, title);
    }
  }

  // Nothing streamed (the API answered in one block): read it whole.
  if (seen === 0) {
    for (const [index, recipe] of parseCookedSet(rawText).entries()) {
      await handlers.onTitle?.(index, recipe.title);
      await handlers.onRecipe?.(index, recipe);
    }
  }
  return rawText;
}

/**
 * Replays a recorded answer as a stream spread over `ms`, through the same
 * reader as live calls. The first fifth is the model thinking before it writes.
 */
export async function* replayDeltas(rawText: string, ms: number, chunk = 48): AsyncGenerator<string> {
  const steps = Math.max(1, Math.ceil(rawText.length / chunk));
  if (ms > 0) await new Promise((r) => setTimeout(r, ms * 0.2));
  const pause = (ms * 0.8) / steps;
  for (let i = 0; i < rawText.length; i += chunk) {
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    yield rawText.slice(i, i + chunk);
  }
}
