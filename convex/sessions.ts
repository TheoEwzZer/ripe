import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { incomingPhoto, sessionStatus } from "./schema";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
// No 0/O, 1/I/L: the code is read aloud and typed on a phone.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

/** Desktop opens a session; the QR code and the 4-character code both point at it. */
export const create = mutation({
  args: { locale: v.union(v.literal("en"), v.literal("fr")), household: v.optional(v.string()) },
  returns: v.object({ sessionId: v.id("sessions"), code: v.string() }),
  handler: async (ctx, { locale, household }) => {
    const now = Date.now();
    let code = randomCode();
    for (let attempt = 0; attempt < 8; attempt++) {
      const clash = await ctx.db
        .query("sessions")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
      if (!clash || clash.expiresAt < now) break;
      code = randomCode();
    }
    const sessionId = await ctx.db.insert("sessions", {
      code,
      status: "waiting",
      locale,
      ...(household && /^[A-Za-z0-9_-]{8,64}$/.test(household) ? { household } : {}),
      expiresAt: now + SESSION_TTL_MS,
    });
    return { sessionId, code };
  },
});

/** Takes the raw URL segment: a malformed id reads as "no session" instead of throwing. */
export const get = query({
  args: { sessionId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("sessions"),
      _creationTime: v.number(),
      code: v.string(),
      status: sessionStatus,
      locale: v.union(v.literal("en"), v.literal("fr")),
      phoneJoinedAt: v.optional(v.number()),
      incoming: v.optional(incomingPhoto),
      cooking: v.optional(v.object({ recipeId: v.id("recipes"), at: v.number() })),
      pantry: v.optional(v.array(v.string())),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    const session = sessionId && (await ctx.db.get(sessionId));
    if (!session || session.expiresAt < Date.now()) return null;
    // Never expose the join token hash; the usage counters are server bookkeeping.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { joinTokenHash, voiceClips, labelReads, receiptReads, listenStreams, household, ...publicFields } = session;
    return publicFields;
  },
});

/** The phone just took a photo: its blurred thumbnail reaches the other screens before the upload ends. */
export const announcePhoto = mutation({
  args: { sessionId: v.id("sessions"), dataUrl: v.string(), width: v.number(), height: v.number() },
  returns: v.null(),
  handler: async (ctx, { sessionId, dataUrl, width, height }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
    if (!dataUrl.startsWith("data:image/jpeg;base64,") || dataUrl.length > 6000 || ![width, height].every((n) => Number.isFinite(n) && n > 0)) {
      throw new ConvexError({ code: "invalid", message: "Bad preview" });
    }
    await ctx.db.patch(sessionId, { incoming: { dataUrl, width, height, at: Date.now() } });
    return null;
  },
});

/** The upload failed or was cancelled: the other screens drop the thumbnail. */
export const clearIncoming = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (session?.incoming) await ctx.db.patch(sessionId, { incoming: undefined });
    return null;
  },
});

/** A phone typing the 4-character code shown on the desktop, when the QR code won't scan. */
export const findByCode = mutation({
  args: { code: v.string() },
  returns: v.union(v.null(), v.id("sessions")),
  handler: async (ctx, { code }) => {
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length !== 4) return null;
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_code", (q) => q.eq("code", clean))
      .order("desc")
      .take(5);
    return sessions.find((s) => s.expiresAt > Date.now())?._id ?? null;
  },
});

/** Removes expired sessions and everything hanging off them, in small batches. */
export const purgeExpired = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const expired = await ctx.db
      .query("sessions")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
      .take(20);
    for (const session of expired) {
      const scans = await ctx.db
        .query("scans")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .take(50);
      for (const scan of scans) {
        for (const mask of await ctx.db.query("masks").withIndex("by_scan", (q) => q.eq("scanId", scan._id)).take(200)) {
          await ctx.db.delete(mask._id);
        }
        if (scan.source.kind === "upload") await ctx.storage.delete(scan.source.storageId);
        await ctx.db.delete(scan._id);
      }
      for (const item of await ctx.db.query("ingredients").withIndex("by_session", (q) => q.eq("sessionId", session._id)).take(200)) {
        await ctx.db.delete(item._id);
      }
      for (const run of await ctx.db.query("recipeRuns").withIndex("by_session", (q) => q.eq("sessionId", session._id)).take(50)) {
        for (const recipe of await ctx.db.query("recipes").withIndex("by_run", (q) => q.eq("runId", run._id)).take(20)) {
          for (const p of [recipe.plate, recipe.previous?.plate]) if (p?.status === "ready" && p.storageId) await ctx.storage.delete(p.storageId);
          await ctx.db.delete(recipe._id);
        }
        await ctx.db.delete(run._id);
      }
      // The household history outlives the session (30 days); only its link to the session goes.
      for (const event of await ctx.db.query("impactEvents").withIndex("by_session", (q) => q.eq("sessionId", session._id)).take(200)) {
        if (!event.household) await ctx.db.delete(event._id);
      }
      for (const offer of await ctx.db.query("offers").withIndex("by_session", (q) => q.eq("sessionId", session._id)).take(20)) {
        await ctx.db.delete(offer._id);
      }
      for (const device of await ctx.db.query("devices").withIndex("by_session", (q) => q.eq("sessionId", session._id)).take(20)) {
        await ctx.db.delete(device._id);
      }
      await ctx.db.delete(session._id);
    }
    return null;
  },
});
