import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { recordImpact } from "./impact";
import { imageOf } from "./scans";
import { gridBox, locale } from "./schema";

const MAX_ITEMS = 10;
const MAX_OFFERS_PER_SESSION = 10;
const MAX_NOTE = 140;

/** "Take my courgettes": a link listing what won't be eaten in time, valid as long as the session. */
export const create = mutation({
  args: { sessionId: v.id("sessions"), ingredientIds: v.array(v.id("ingredients")), note: v.string(), locale },
  returns: v.id("offers"),
  handler: async (ctx, { sessionId, ingredientIds, note, locale }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
    const ids = [...new Set(ingredientIds)];
    if (ids.length === 0 || ids.length > MAX_ITEMS) throw new ConvexError({ code: "invalid", message: `Pick 1 to ${MAX_ITEMS} items` });
    const existing = await ctx.db
      .query("offers")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .take(MAX_OFFERS_PER_SESSION);
    if (existing.length >= MAX_OFFERS_PER_SESSION) throw new ConvexError({ code: "quota", message: "Too many offers in this session" });
    const items = [];
    for (const id of ids) {
      const item = await ctx.db.get(id);
      if (!item || item.sessionId !== sessionId || item.removed || !item.name.trim()) {
        throw new ConvexError({ code: "invalid", message: "An item is gone" });
      }
      items.push({
        ingredientId: item._id,
        name: item.name,
        quantity: item.quantity,
        daysLeft: item.daysLeft,
        scanId: item.scanId,
        bbox: item.bbox,
      });
    }
    return await ctx.db.insert("offers", {
      sessionId,
      items,
      note: note.trim().replace(/\s+/g, " ").slice(0, MAX_NOTE),
      locale,
      expiresAt: session.expiresAt,
    });
  },
});

/** The public page of an offer: what is given and a crop of the photo, never who gives it. */
export const get = query({
  args: { offerId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      items: v.array(v.object({ name: v.string(), quantity: v.string(), daysLeft: v.number(), bbox: gridBox, scanId: v.id("scans") })),
      photos: v.array(v.object({ scanId: v.id("scans"), src: v.union(v.string(), v.null()), width: v.number(), height: v.number() })),
      note: v.string(),
      claimed: v.boolean(),
      ageDays: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const offerId = ctx.db.normalizeId("offers", args.offerId);
    const offer = offerId && (await ctx.db.get(offerId));
    if (!offer || offer.expiresAt < Date.now()) return null;
    const photos = [];
    for (const scanId of new Set(offer.items.map((i) => i.scanId))) {
      const scan = await ctx.db.get(scanId);
      if (!scan) continue;
      const src = await imageOf(ctx, scan.source);
      if (src) photos.push({ scanId, src, width: scan.width, height: scan.height });
    }
    return {
      items: offer.items.map(({ name, quantity, daysLeft, bbox, scanId }) => ({ name, quantity, daysLeft, bbox, scanId })),
      photos,
      note: offer.note,
      claimed: offer.claimedAt !== undefined,
      // Freshness was judged when the link was made; the page counts the days since.
      ageDays: Math.floor((Date.now() - offer._creationTime) / 86_400_000),
    };
  },
});

/** A neighbour says "I'll take it"; the first one wins and the giver sees it live. */
export const claim = mutation({
  args: { offerId: v.id("offers") },
  returns: v.boolean(),
  handler: async (ctx, { offerId }) => {
    const offer = await ctx.db.get(offerId);
    if (!offer || offer.expiresAt < Date.now()) throw new ConvexError({ code: "gone", message: "This offer has ended" });
    if (offer.claimedAt !== undefined) return false;
    await ctx.db.patch(offerId, { claimedAt: Date.now() });
    // Given away is saved too: the items count for the giver's household.
    const session = await ctx.db.get(offer.sessionId);
    if (session) {
      // The item itself knows its category and any receipt price; the offer keeps only what the neighbour sees.
      const saved = [];
      for (const i of offer.items) {
        const item = await ctx.db.get(i.ingredientId);
        saved.push({ item: { name: i.name, quantity: i.quantity, category: item?.category ?? "other", priceEur: item?.priceEur }, share: 1 });
      }
      await recordImpact(ctx, session, "offered", saved, { offerId });
    }
    return true;
  },
});

/** The giver's view: every link made in this session and whether someone took it. */
export const forSession = query({
  args: { sessionId: v.string() },
  returns: v.array(v.object({ _id: v.id("offers"), names: v.array(v.string()), claimed: v.boolean() })),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    if (!sessionId) return [];
    const offers = await ctx.db
      .query("offers")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .take(MAX_OFFERS_PER_SESSION);
    return offers.map((o) => ({ _id: o._id, names: o.items.map((i) => i.name), claimed: o.claimedAt !== undefined }));
  },
});
