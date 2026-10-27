import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { sessionStatus } from "./schema";

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
  args: { locale: v.union(v.literal("en"), v.literal("fr")) },
  returns: v.object({ sessionId: v.id("sessions"), code: v.string() }),
  handler: async (ctx, { locale }) => {
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
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    const session = sessionId && (await ctx.db.get(sessionId));
    if (!session || session.expiresAt < Date.now()) return null;
    // Never expose the join token hash to clients.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { joinTokenHash, ...publicFields } = session;
    return publicFields;
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
          if (recipe.plateStorageId) await ctx.storage.delete(recipe.plateStorageId);
          await ctx.db.delete(recipe._id);
        }
        await ctx.db.delete(run._id);
      }
      await ctx.db.delete(session._id);
    }
    return null;
  },
});
