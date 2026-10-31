import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { activeScans, imageOf } from "./scans";
import { scanSource } from "./schema";

const MAX_AFTERS_PER_SESSION = 3;
const WATCHDOG_MS = 2 * 60 * 1000;

/** Saved = cooked into a recipe, or given away and claimed; grouped by the photo they were seen on. */
async function savedByPhoto(ctx: Parameters<typeof imageOf>[0], sessionId: Id<"sessions">) {
  const scans = (await activeScans(ctx, sessionId)).filter((s) => s.source.kind !== "list");
  const offers = await ctx.db
    .query("offers")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(20);
  const given = new Set(offers.filter((o) => o.claimedAt !== undefined).flatMap((o) => o.items.map((i) => i.ingredientId as string)));
  const items = await ctx.db
    .query("ingredients")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(400);
  const byScan = new Map<Id<"scans">, string[]>();
  for (const item of items) {
    if (!(item.cookedIn || given.has(item._id))) continue;
    byScan.set(item.scanId, [...(byScan.get(item.scanId) ?? []), item.name]);
  }
  return scans
    .map((scan) => ({ scan, items: [...new Set(byScan.get(scan._id) ?? [])] }))
    .filter((s) => s.items.length > 0)
    .sort((a, b) => b.items.length - a.items.length);
}

/** Asks Muse Image for the "after" of the photo where the most food was saved. */
export const imagine = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    if (!process.env.MODEL_API_KEY) throw new ConvexError({ code: "live_disabled", message: "Muse Image needs the Meta API key" });
    const session = await ctx.db.get(sessionId);
    if (!session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
    const best = (await savedByPhoto(ctx, sessionId))[0];
    if (!best) throw new ConvexError({ code: "empty", message: "Nothing saved yet" });
    const afters = await ctx.db
      .query("afters")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .take(MAX_AFTERS_PER_SESSION);
    const key = [...best.items].sort().join("|");
    if (afters.some((a) => a.status !== "failed" && [...a.items].sort().join("|") === key)) return null;
    if (afters.length >= MAX_AFTERS_PER_SESSION) throw new ConvexError({ code: "quota", message: "Too many before/after images" });
    const afterId = await ctx.db.insert("afters", { sessionId, scanId: best.scan._id, items: best.items, status: "imagining" });
    await ctx.scheduler.runAfter(0, internal.imaging.after, { afterId });
    await ctx.scheduler.runAfter(WATCHDOG_MS, internal.afters.fail, { afterId });
    return null;
  },
});

/** The latest before/after, with both pictures. */
export const latest = query({
  args: { sessionId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(v.literal("imagining"), v.literal("ready"), v.literal("failed")),
      items: v.array(v.string()),
      before: v.union(v.string(), v.null()),
      after: v.union(v.string(), v.null()),
      width: v.number(),
      height: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    if (!sessionId) return null;
    const row = await ctx.db
      .query("afters")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .first();
    const scan = row && (await ctx.db.get(row.scanId));
    if (!row || !scan) return null;
    return {
      status: row.status,
      items: row.items,
      before: await imageOf(ctx, scan.source),
      after: row.storageId ? await ctx.storage.getUrl(row.storageId) : null,
      width: scan.width,
      height: scan.height,
    };
  },
});

export const forAfter = internalQuery({
  args: { afterId: v.id("afters") },
  returns: v.union(v.null(), v.object({ items: v.array(v.string()), source: scanSource })),
  handler: async (ctx, { afterId }) => {
    const row = await ctx.db.get(afterId);
    const scan = row && (await ctx.db.get(row.scanId));
    if (!row || !scan || row.status !== "imagining") return null;
    return { items: row.items, source: scan.source };
  },
});

export const save = internalMutation({
  args: { afterId: v.id("afters"), storageId: v.id("_storage"), ms: v.number() },
  returns: v.null(),
  handler: async (ctx, { afterId, storageId, ms }) => {
    const row = await ctx.db.get(afterId);
    if (row?.status !== "imagining") {
      await ctx.storage.delete(storageId);
      return null;
    }
    await ctx.db.patch(afterId, { status: "ready", storageId, ms });
    return null;
  },
});

export const fail = internalMutation({
  args: { afterId: v.id("afters") },
  returns: v.null(),
  handler: async (ctx, { afterId }) => {
    const row = await ctx.db.get(afterId);
    if (row?.status === "imagining") await ctx.db.patch(afterId, { status: "failed" });
    return null;
  },
});
