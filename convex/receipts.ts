import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { listScan } from "./scans";
import { category } from "./schema";

const MAX_RECEIPTS_PER_SESSION = 10;

/** Checks the session and counts the receipt against its cap before Muse Spark is paid to read it. */
export const begin = internalMutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
    const reads = session.receiptReads ?? 0;
    if (reads >= MAX_RECEIPTS_PER_SESSION) throw new ConvexError({ code: "quota", message: "Too many receipts in this session" });
    await ctx.db.patch(sessionId, { receiptReads: reads + 1 });
    return null;
  },
});

/** The receipt's food lines join the inventory, on the session's receipt list. Duplicates are left for the merge prompt. */
export const add = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    items: v.array(v.object({ name: v.string(), quantity: v.string(), category, daysLeft: v.number() })),
  },
  returns: v.array(v.object({ id: v.id("ingredients"), name: v.string() })),
  handler: async (ctx, { sessionId, items }) => {
    if (items.length === 0) return [];
    const scanId = await listScan(ctx, sessionId, "receipt");
    const order = (
      await ctx.db
        .query("ingredients")
        .withIndex("by_scan", (q) => q.eq("scanId", scanId))
        .take(200)
    ).length;
    const added: { id: Id<"ingredients">; name: string }[] = [];
    for (const [i, item] of items.entries()) {
      const id = await ctx.db.insert("ingredients", {
        sessionId,
        scanId,
        order: order + i,
        name: item.name,
        samPrompt: item.name,
        category: item.category,
        quantity: item.quantity,
        daysLeft: item.daysLeft,
        freshnessCues: "",
        dateRead: null,
        bbox: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
        segmentation: "none",
        source: "manual",
        removed: false,
      });
      added.push({ id, name: item.name });
    }
    return added;
  },
});
