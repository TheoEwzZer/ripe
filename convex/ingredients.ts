import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";

const MAX_NAME = 60;
const MAX_DAYS = 60;
const MAX_MERGE = 10;

/** The item and its scan, if the session is still open; editing is how a person corrects the AI. */
async function editable(ctx: MutationCtx, ingredientId: Id<"ingredients">) {
  const item = await ctx.db.get(ingredientId);
  const scan = item && (await ctx.db.get(item.scanId));
  const session = scan && (await ctx.db.get(scan.sessionId));
  if (!item || !scan || !session || session.expiresAt < Date.now()) {
    throw new ConvexError({ code: "session", message: "Session expired" });
  }
  return { item, scan };
}

const settled = (scan: Doc<"scans">) => scan.status === "done" || scan.status === "error";

/** Correct the name or the freshness estimate. */
export const update = mutation({
  args: { ingredientId: v.id("ingredients"), name: v.optional(v.string()), daysLeft: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { ingredientId, name, daysLeft }) => {
    await editable(ctx, ingredientId);
    const patch: Partial<Doc<"ingredients">> = {};
    if (name !== undefined) {
      const clean = name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
      if (!clean) throw new ConvexError({ code: "invalid", message: "A name cannot be empty" });
      patch.name = clean;
    }
    if (daysLeft !== undefined) {
      if (!Number.isInteger(daysLeft) || daysLeft < 0 || daysLeft > MAX_DAYS) {
        throw new ConvexError({ code: "invalid", message: `Days left must be 0 to ${MAX_DAYS}` });
      }
      patch.daysLeft = daysLeft;
    }
    await ctx.db.patch(ingredientId, patch);
    return null;
  },
});

/** Hidden, not deleted, so the toast can undo it. */
export const remove = mutation({
  args: { ingredientId: v.id("ingredients") },
  returns: v.null(),
  handler: async (ctx, { ingredientId }) => {
    await editable(ctx, ingredientId);
    await ctx.db.patch(ingredientId, { removed: true });
    return null;
  },
});

export const restore = mutation({
  args: { ingredientId: v.id("ingredients") },
  returns: v.null(),
  handler: async (ctx, { ingredientId }) => {
    const { item } = await editable(ctx, ingredientId);
    if (item.mergedInto) throw new ConvexError({ code: "invalid", message: "Undo the merge instead" });
    await ctx.db.patch(ingredientId, { removed: false, cookedIn: undefined });
    return null;
  },
});

/**
 * Folds duplicates into one item, on the same photo or another one: outlines on the same photo move over, the most urgent
 * freshness wins and the quantities add up. Undo with `unmerge`.
 */
export const merge = mutation({
  args: { keepId: v.id("ingredients"), duplicateIds: v.array(v.id("ingredients")) },
  returns: v.null(),
  handler: async (ctx, { keepId, duplicateIds }) => {
    const { item: keep, scan } = await editable(ctx, keepId);
    if (!settled(scan)) throw new ConvexError({ code: "busy", message: "Wait for the analysis to finish" });
    if (keep.removed) throw new ConvexError({ code: "invalid", message: "This item was removed" });
    const ids = [...new Set(duplicateIds)].filter((id) => id !== keepId);
    if (ids.length === 0 || ids.length > MAX_MERGE) throw new ConvexError({ code: "invalid", message: "Pick 1 to 10 duplicates" });

    const duplicates: Doc<"ingredients">[] = [];
    for (const id of ids) {
      const dup = await ctx.db.get(id);
      if (!dup || dup.sessionId !== keep.sessionId || dup.removed) throw new ConvexError({ code: "invalid", message: "A duplicate is gone" });
      duplicates.push(dup);
    }

    const siblings = await ctx.db
      .query("ingredients")
      .withIndex("by_session", (q) => q.eq("sessionId", keep.sessionId))
      .take(400);
    for (const dup of duplicates) {
      // Outlines remember their first owner, so one undo puts every merge back.
      // A duplicate on another photo keeps its outline there.
      const masks =
        dup.scanId === keep.scanId
          ? await ctx.db
              .query("masks")
              .withIndex("by_ingredient", (q) => q.eq("ingredientId", dup._id))
              .take(100)
          : [];
      for (const mask of masks) await ctx.db.patch(mask._id, { ingredientId: keepId, mergedFrom: mask.mergedFrom ?? dup._id });
      // Items already folded into this duplicate now hang off the kept one.
      for (const child of siblings) if (child.mergedInto === dup._id) await ctx.db.patch(child._id, { mergedInto: keepId });
      await ctx.db.patch(dup._id, { removed: true, mergedInto: keepId });
    }

    const all = [keep, ...duplicates];
    const quantities = all.map((i) => i.quantity.trim()).filter(Boolean);
    const priced = all.every((i) => i.priceEur !== undefined);
    await ctx.db.patch(keepId, {
      beforeMerge: keep.beforeMerge ?? { daysLeft: keep.daysLeft, quantity: keep.quantity, priceEur: keep.priceEur },
      daysLeft: Math.min(keep.daysLeft, ...duplicates.map((d) => d.daysLeft)),
      quantity: [...new Set(quantities)].join(" + "),
      // A price for only part of the merged lines would undercount: estimate the whole instead.
      priceEur: priced ? Math.round(all.reduce((sum, i) => sum + (i.priceEur ?? 0), 0) * 100) / 100 : undefined,
    });
    return null;
  },
});

export const unmerge = mutation({
  args: { keepId: v.id("ingredients") },
  returns: v.null(),
  handler: async (ctx, { keepId }) => {
    const { item: keep } = await editable(ctx, keepId);
    if (!keep.beforeMerge) return null;

    const masks = await ctx.db
      .query("masks")
      .withIndex("by_ingredient", (q) => q.eq("ingredientId", keepId))
      .take(200);
    for (const mask of masks) {
      if (mask.mergedFrom) await ctx.db.patch(mask._id, { ingredientId: mask.mergedFrom, mergedFrom: undefined });
    }
    const siblings = await ctx.db
      .query("ingredients")
      .withIndex("by_session", (q) => q.eq("sessionId", keep.sessionId))
      .take(400);
    for (const dup of siblings) {
      if (dup.mergedInto !== keepId) continue;
      // A duplicate that had absorbed others gets its own values back too.
      await ctx.db.patch(dup._id, {
        removed: false,
        mergedInto: undefined,
        ...(dup.beforeMerge ? { ...dup.beforeMerge, beforeMerge: undefined } : {}),
      });
    }
    await ctx.db.patch(keepId, { ...keep.beforeMerge, beforeMerge: undefined });
    return null;
  },
});
