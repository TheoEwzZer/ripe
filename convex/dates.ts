import { ConvexError, v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { gridBox, scanSource } from "./schema";

const MAX_READS_PER_SESSION = 40;

const liveEnabled = () => Boolean(process.env.MODEL_API_KEY);

/** Where a close-up of a label, or a receipt, goes before Muse Spark reads it. */
export const uploadUrl = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.string(),
  handler: async (ctx, { sessionId }) => {
    if (!liveEnabled()) throw new ConvexError({ code: "live_disabled", message: "Reading dates needs the Meta API key" });
    const session = await ctx.db.get(sessionId);
    if (!session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
    return await ctx.storage.generateUploadUrl();
  },
});

/** The item, where it sits on its photo, and the session's read counter (bumped here). */
export const forDate = internalMutation({
  args: { ingredientId: v.id("ingredients") },
  returns: v.union(v.null(), v.object({ name: v.string(), bbox: gridBox, source: scanSource })),
  handler: async (ctx, { ingredientId }) => {
    const item = await ctx.db.get(ingredientId);
    const scan = item && (await ctx.db.get(item.scanId));
    const session = scan && (await ctx.db.get(scan.sessionId));
    if (!item || !scan || !session || session.expiresAt < Date.now() || item.removed) return null;
    const reads = session.labelReads ?? 0;
    if (reads >= MAX_READS_PER_SESSION) throw new ConvexError({ code: "quota", message: "Too many dates read in this session" });
    await ctx.db.patch(session._id, { labelReads: reads + 1 });
    // An item seen on a later frame of the video sits on that frame, not on the photo.
    return { name: item.name, bbox: item.bbox, source: item.seenAt ? { kind: "upload" as const, storageId: item.seenAt.storageId } : scan.source };
  },
});

/** A legible date becomes the item's freshness; the printed text is kept to show where it came from. */
export const setDate = internalMutation({
  args: { ingredientId: v.id("ingredients"), text: v.string(), daysLeft: v.union(v.number(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { ingredientId, text, daysLeft }) => {
    const item = await ctx.db.get(ingredientId);
    if (!item) return null;
    await ctx.db.patch(ingredientId, { dateRead: text, ...(daysLeft === null ? {} : { daysLeft }) });
    return null;
  },
});
