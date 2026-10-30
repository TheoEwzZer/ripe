"use node";

import { ConvexError, v } from "convex/values";
import { DATE_RESERVE_USD, daysUntil, readPrintedDate } from "../lib/meta/dates";
import { RECEIPT_RESERVE_USD, readReceipt as readReceiptLines } from "../lib/meta/receipt";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { publicImageUrl } from "./pipeline";

type DateResult = { found: boolean; text: string; kind: string | null; daysLeft: number | null };

/**
 * Reads the date printed on one item: inside its box on the fridge photo, or
 * on a close-up of the label taken for it. A use-by or best-before date
 * replaces the freshness Muse Spark guessed from the look of the item.
 */
export const readDate = action({
  args: { ingredientId: v.id("ingredients"), storageId: v.optional(v.id("_storage")) },
  returns: v.object({ found: v.boolean(), text: v.string(), kind: v.union(v.string(), v.null()), daysLeft: v.union(v.number(), v.null()) }),
  handler: async (ctx, { ingredientId, storageId }): Promise<DateResult> => {
    try {
      if (!process.env.MODEL_API_KEY) throw new ConvexError({ code: "live_disabled", message: "Reading dates needs the Meta API key" });
      const item = await ctx.runMutation(internal.dates.forDate, { ingredientId });
      if (!item) throw new ConvexError({ code: "session", message: "This item is gone" });
      const imageUrl = storageId ? await ctx.storage.getUrl(storageId) : await publicImageUrl(ctx, item.source);
      if (!imageUrl) throw new ConvexError({ code: "upload", message: "No photo to read" });

      await ctx.runMutation(internal.spend.reserve, { label: "date", usd: DATE_RESERVE_USD });
      const today = new Date().toISOString().slice(0, 10);
      let result;
      try {
        result = await readPrintedDate(imageUrl, { name: item.name, today, box: storageId ? null : item.bbox });
      } finally {
        await ctx.runMutation(internal.spend.settle, { estimateUsd: DATE_RESERVE_USD, actualUsd: result?.costUsd ?? 0 });
      }
      const { read } = result;
      const daysLeft = daysUntil(read, today);
      if (read.found) await ctx.runMutation(internal.dates.setDate, { ingredientId, text: read.text || read.date || "", daysLeft });
      return { found: read.found, text: read.text || read.date || "", kind: read.kind, daysLeft };
    } finally {
      // The close-up was only needed for this read.
      if (storageId) await ctx.storage.delete(storageId);
    }
  },
});

type ReceiptResult = { added: { id: Id<"ingredients">; name: string }[]; date: string | null; store: string };

/** A receipt photo: its food lines join the inventory with the freshness left since the purchase. */
export const readReceipt = action({
  args: { sessionId: v.id("sessions"), storageId: v.id("_storage") },
  returns: v.object({
    added: v.array(v.object({ id: v.id("ingredients"), name: v.string() })),
    date: v.union(v.string(), v.null()),
    store: v.string(),
  }),
  handler: async (ctx, { sessionId, storageId }): Promise<ReceiptResult> => {
    try {
      if (!process.env.MODEL_API_KEY) throw new ConvexError({ code: "live_disabled", message: "Reading receipts needs the Meta API key" });
      await ctx.runMutation(internal.receipts.begin, { sessionId });
      const imageUrl = await ctx.storage.getUrl(storageId);
      if (!imageUrl) throw new ConvexError({ code: "upload", message: "The receipt photo is gone" });
      await ctx.runMutation(internal.spend.reserve, { label: "receipt", usd: RECEIPT_RESERVE_USD });
      let result;
      try {
        result = await readReceiptLines(imageUrl, new Date().toISOString().slice(0, 10));
      } finally {
        await ctx.runMutation(internal.spend.settle, { estimateUsd: RECEIPT_RESERVE_USD, actualUsd: result?.costUsd ?? 0 });
      }
      const added = await ctx.runMutation(internal.receipts.add, { sessionId, items: result.receipt.items });
      return { added, date: result.receipt.date, store: result.receipt.store };
    } finally {
      // Receipts carry personal details: the photo is not kept once read.
      await ctx.storage.delete(storageId);
    }
  },
});
