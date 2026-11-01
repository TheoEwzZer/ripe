"use node";

import { ConvexError, v } from "convex/values";
import { INTERPRET_RESERVE_USD, TRANSCRIBE_RESERVE_USD, interpretKitchen, transcribe } from "../lib/meta/voice";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import type { CookFilters } from "../lib/recipes/filters";
import type { Id } from "./_generated/dataModel";
import { cookFilters } from "./schema";
import { MAX_CLIP_BYTES } from "./voice";

const COOK_WORDS = ["suivant", "précédent", "répète", "minuteur", "stop", "ingrédients", "next", "back", "repeat", "timer", "ingredients"];
const FILTER_WORDS = ["air fryer", "micro-ondes", "microwave", "végétarien", "vegetarian", "vegan", "sans gluten", "gluten-free", "poêle"];

const changed = v.array(v.object({ id: v.id("ingredients"), name: v.string() }));

type Change = { id: Id<"ingredients">; name: string };
type Heard = {
  transcript: string;
  audioMs: number;
  reply: string;
  added: Change[];
  removed: Change[];
  filters: CookFilters | null;
  runStarted: boolean;
};

/**
 * One spoken sentence: Muse Voice Transcribe writes it down, then, in the
 * kitchen, Muse Spark turns it into list changes or recipe filters. In
 * cooking mode the phone reads the words itself ("suivant", "minuteur").
 */
export const hear = action({
  args: {
    sessionId: v.id("sessions"),
    storageId: v.id("_storage"),
    locale: v.union(v.literal("en"), v.literal("fr")),
    purpose: v.union(v.literal("kitchen"), v.literal("cook")),
  },
  returns: v.object({
    transcript: v.string(),
    audioMs: v.number(),
    reply: v.string(),
    added: changed,
    removed: changed,
    filters: v.union(v.null(), cookFilters),
    runStarted: v.boolean(),
  }),
  handler: async (ctx, { sessionId, storageId, locale, purpose }): Promise<Heard> => {
    const nothing = { reply: "", added: [], removed: [], filters: null, runStarted: false };
    const inventory: { name: string; quantity: string; daysLeft: number }[] | null = await ctx.runMutation(internal.voice.forHearing, {
      sessionId,
    });
    // The clip is only needed for this sentence.
    const clip = await ctx.storage.get(storageId);
    if (clip) await ctx.storage.delete(storageId);
    if (!inventory) throw new ConvexError({ code: "session", message: "Session expired" });
    if (!clip || clip.size > MAX_CLIP_BYTES) throw new ConvexError({ code: "voice", message: "Send one short sentence" });

    await ctx.runMutation(internal.spend.reserve, { label: "transcribe", usd: TRANSCRIBE_RESERVE_USD });
    let heard;
    try {
      heard = await transcribe(clip, {
        keywords: purpose === "cook" ? COOK_WORDS : [...inventory.map((i) => i.name), ...FILTER_WORDS],
        languages: locale === "fr" ? ["French", "English"] : ["English"],
      });
    } catch (error) {
      await ctx.runMutation(internal.spend.settle, { estimateUsd: TRANSCRIBE_RESERVE_USD, actualUsd: 0 });
      console.error("transcription failed", error);
      throw new ConvexError({ code: "voice", message: "Muse Voice could not transcribe this" });
    }
    await ctx.runMutation(internal.spend.settle, { estimateUsd: TRANSCRIBE_RESERVE_USD, actualUsd: heard.costUsd });
    if (purpose === "cook" || !heard.text) return { transcript: heard.text, audioMs: heard.audioMs, ...nothing };

    await ctx.runMutation(internal.spend.reserve, { label: "interpret", usd: INTERPRET_RESERVE_USD });
    let understood;
    try {
      understood = await interpretKitchen(heard.text, inventory, locale);
    } finally {
      await ctx.runMutation(internal.spend.settle, { estimateUsd: INTERPRET_RESERVE_USD, actualUsd: understood?.costUsd ?? 0 });
    }
    const { intent } = understood;
    const applied: Omit<Heard, "transcript" | "audioMs" | "reply"> = await ctx.runMutation(internal.voice.apply, {
      sessionId,
      add: intent.add,
      remove: intent.remove,
      filters: intent.filters,
      locale,
    });
    return { transcript: heard.text, audioMs: heard.audioMs, reply: intent.reply, ...applied };
  },
});
