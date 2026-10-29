import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { deviceKind } from "./schema";

const MAX_DEVICES_PER_SESSION = 12;

/**
 * "I'm here": each open screen calls this on load and every few seconds.
 * Presence is the last ping; screens decide who is online with their own clock.
 */
export const ping = mutation({
  args: { sessionId: v.id("sessions"), key: v.string(), kind: deviceKind },
  returns: v.id("devices"),
  handler: async (ctx, { sessionId, key, kind }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new ConvexError({ code: "invalid", message: "Bad device key" });
    const now = Date.now();
    const existing = await ctx.db
      .query("devices")
      .withIndex("by_session_and_key", (q) => q.eq("sessionId", sessionId).eq("key", key))
      .unique();
    if (existing) {
      // A resized window can switch kind; keep the number it had.
      await ctx.db.patch(existing._id, { lastSeen: now, ...(existing.kind === kind ? {} : { kind }) });
      return existing._id;
    }
    const all = await ctx.db
      .query("devices")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .take(MAX_DEVICES_PER_SESSION);
    if (all.length >= MAX_DEVICES_PER_SESSION) throw new ConvexError({ code: "quota", message: "Too many screens in this session" });
    const number = all.filter((d) => d.kind === kind).length + 1;
    if (kind === "phone" && session.phoneJoinedAt === undefined) await ctx.db.patch(sessionId, { phoneJoinedAt: now });
    return await ctx.db.insert("devices", { sessionId, key, kind, number, lastSeen: now });
  },
});

export const list = query({
  args: { sessionId: v.string() },
  returns: v.array(v.object({ _id: v.id("devices"), kind: deviceKind, number: v.number(), lastSeen: v.number() })),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    if (!sessionId) return [];
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .take(MAX_DEVICES_PER_SESSION);
    return devices.map(({ _id, kind, number, lastSeen }) => ({ _id, kind, number, lastSeen }));
  },
});
