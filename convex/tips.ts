import { ConvexError, v } from "convex/values";
import { pickUrgent, tipsKey } from "../lib/meta/tips";
import { recordings } from "../lib/replay/catalog";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { activeScans } from "./scans";
import { locale, storageTip } from "./schema";

const MAX_TIP_REQUESTS = 12;
const WATCHDOG_MS = 90_000;

const status = v.union(v.literal("writing"), v.literal("ready"), v.literal("error"));
const source = v.union(v.literal("live"), v.literal("replay"));

async function urgentOf(ctx: QueryCtx, sessionId: Id<"sessions">) {
  const scans = await activeScans(ctx, sessionId);
  const ids = new Set(scans.map((s) => s._id));
  const items = await ctx.db
    .query("ingredients")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(400);
  return {
    items: pickUrgent(items.filter((i) => ids.has(i.scanId) && !i.removed)).map((i) => ({
      name: i.name,
      quantity: i.quantity,
      daysLeft: i.daysLeft,
    })),
    recordingIds: scans.flatMap((s) => (s.source.kind === "replay" ? [s.source.recordingId] : [])),
  };
}

/** Tips for the most urgent items, written once per set of items and language. */
export const request = mutation({
  args: { sessionId: v.id("sessions"), locale },
  returns: v.null(),
  handler: async (ctx, { sessionId, locale }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
    const { items, recordingIds } = await urgentOf(ctx, sessionId);
    if (items.length === 0) throw new ConvexError({ code: "empty", message: "Nothing to keep" });
    const key = tipsKey(items.map((i) => i.name));
    const existing = await ctx.db
      .query("tips")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .take(MAX_TIP_REQUESTS);
    if (existing.some((t) => t.key === key && t.locale === locale && t.status !== "error")) return null;
    if (existing.length >= MAX_TIP_REQUESTS) throw new ConvexError({ code: "quota", message: "Too many tip requests" });
    const recorded = recordingIds.some((id) => recordings[id]?.tips?.some((t) => t.locale === locale && t.key === key));
    if (!recorded && !process.env.MODEL_API_KEY) throw new ConvexError({ code: "live_disabled", message: "Tips need the Meta API key" });
    const tipsId = await ctx.db.insert("tips", {
      sessionId,
      locale,
      key,
      status: "writing",
      source: recorded ? "replay" : "live",
      tips: [],
      costUsd: 0,
    });
    await ctx.scheduler.runAfter(0, internal.advice.write, { tipsId });
    await ctx.scheduler.runAfter(WATCHDOG_MS, internal.tips.fail, { tipsId });
    return null;
  },
});

/** The latest tips in this language, for the inventory panel. */
export const forSession = query({
  args: { sessionId: v.string(), locale },
  returns: v.union(v.null(), v.object({ status, source, key: v.string(), tips: v.array(storageTip) })),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    if (!sessionId) return null;
    const rows = await ctx.db
      .query("tips")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .take(MAX_TIP_REQUESTS);
    const row = rows.find((r) => r.locale === args.locale);
    return row ? { status: row.status, source: row.source, key: row.key, tips: row.tips } : null;
  },
});

export const forWriting = internalQuery({
  args: { tipsId: v.id("tips") },
  returns: v.union(
    v.null(),
    v.object({
      locale,
      key: v.string(),
      source,
      items: v.array(v.object({ name: v.string(), quantity: v.string(), daysLeft: v.number() })),
      recordingIds: v.array(v.string()),
    }),
  ),
  handler: async (ctx, { tipsId }) => {
    const row = await ctx.db.get(tipsId);
    if (!row || row.status !== "writing") return null;
    return { locale: row.locale, key: row.key, source: row.source, ...(await urgentOf(ctx, row.sessionId)) };
  },
});

export const save = internalMutation({
  args: { tipsId: v.id("tips"), tips: v.array(storageTip), costUsd: v.number() },
  returns: v.null(),
  handler: async (ctx, { tipsId, tips, costUsd }) => {
    const row = await ctx.db.get(tipsId);
    if (row?.status === "writing") await ctx.db.patch(tipsId, { status: tips.length > 0 ? "ready" : "error", tips, costUsd });
    return null;
  },
});

export const fail = internalMutation({
  args: { tipsId: v.id("tips") },
  returns: v.null(),
  handler: async (ctx, { tipsId }) => {
    const row = await ctx.db.get(tipsId);
    if (row?.status === "writing") await ctx.db.patch(tipsId, { status: "error" });
    return null;
  },
});
