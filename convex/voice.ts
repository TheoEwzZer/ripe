import { ConvexError, v } from "convex/values";
import { filtersFrom } from "../lib/voice/kitchen";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { latestFilters, startRun } from "./recipes";
import { activeScans, listScan } from "./scans";
import { category, cookFilters, locale } from "./schema";

const MAX_CLIPS_PER_SESSION = 150;
/** A 12-second clip at 16 kHz is 384 KB; anything far bigger is not one sentence. */
export const MAX_CLIP_BYTES = 1_000_000;

const liveEnabled = () => Boolean(process.env.MODEL_API_KEY);

/** Where the browser sends one recorded sentence. Counted against the session's voice cap. */
export const uploadUrl = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.string(),
  handler: async (ctx, { sessionId }) => {
    if (!liveEnabled()) throw new ConvexError({ code: "live_disabled", message: "Voice needs the Meta API key" });
    const session = await ctx.db.get(sessionId);
    if (!session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
    const clips = session.voiceClips ?? 0;
    if (clips >= MAX_CLIPS_PER_SESSION) throw new ConvexError({ code: "quota", message: "Too many voice requests in this session" });
    await ctx.db.patch(sessionId, { voiceClips: clips + 1 });
    return await ctx.storage.generateUploadUrl();
  },
});

/** What a sentence can refer to: the session's items still on the list. */
export const forHearing = internalQuery({
  args: { sessionId: v.id("sessions") },
  returns: v.union(v.null(), v.array(v.object({ name: v.string(), quantity: v.string(), daysLeft: v.number() }))),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session.expiresAt < Date.now()) return null;
    const scans = new Set((await activeScans(ctx, sessionId)).map((s) => s._id));
    const items = await ctx.db
      .query("ingredients")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .take(400);
    return items
      .filter((i) => scans.has(i.scanId) && !i.removed && i.name.trim())
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 80)
      .map((i) => ({ name: i.name, quantity: i.quantity, daysLeft: i.daysLeft }));
  },
});

const changed = v.array(v.object({ id: v.id("ingredients"), name: v.string() }));

/** Applies what Muse Spark understood: new items on the spoken list, finished ones out, recipes if asked. */
export const apply = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    add: v.array(v.object({ name: v.string(), quantity: v.string(), category, daysLeft: v.number() })),
    remove: v.array(v.string()),
    filters: v.union(
      v.null(),
      v.object({
        emergency: v.boolean(),
        maxMinutes: v.union(v.literal(10), v.literal(15), v.literal(30), v.null()),
        equipment: v.union(v.literal("microwave"), v.literal("air-fryer"), v.literal("one-pan"), v.null()),
        diet: v.array(v.union(v.literal("vegetarian"), v.literal("vegan"), v.literal("gluten-free"))),
        fewDishes: v.boolean(),
        servings: v.union(v.number(), v.null()),
      }),
    ),
    locale,
  },
  returns: v.object({ added: changed, removed: changed, filters: v.union(v.null(), cookFilters), runStarted: v.boolean() }),
  handler: async (ctx, { sessionId, add, remove, filters, locale }) => {
    const scans = new Set((await activeScans(ctx, sessionId)).map((s) => s._id));
    const items = (
      await ctx.db
        .query("ingredients")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .take(400)
    ).filter((i) => scans.has(i.scanId) && !i.removed && i.name.trim());
    const fold = (name: string) => name.trim().toLowerCase();

    const removed: { id: Id<"ingredients">; name: string }[] = [];
    for (const name of new Set(remove)) {
      // The most urgent one first: "the spinach" means the box that goes off soonest.
      const item = items
        .filter((i) => fold(i.name) === fold(name) && !removed.some((r) => r.id === i._id))
        .sort((a, b) => a.daysLeft - b.daysLeft)[0];
      if (!item) continue;
      await ctx.db.patch(item._id, { removed: true });
      removed.push({ id: item._id, name: item.name });
    }

    const added: { id: Id<"ingredients">; name: string }[] = [];
    const fresh = add.filter((a) => !items.some((i) => fold(i.name) === fold(a.name)));
    if (fresh.length > 0) {
      const scanId = await listScan(ctx, sessionId, "voice");
      const order = (
        await ctx.db
          .query("ingredients")
          .withIndex("by_scan", (q) => q.eq("scanId", scanId))
          .take(200)
      ).length;
      for (const [i, item] of fresh.entries()) {
        const id = await ctx.db.insert("ingredients", {
          sessionId,
          scanId,
          order: order + i,
          name: item.name,
          samPrompt: item.name,
          category: item.category,
          quantity: item.quantity,
          daysLeft: Math.max(0, Math.min(60, Math.round(item.daysLeft))),
          freshnessCues: "",
          dateRead: null,
          bbox: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
          segmentation: "none",
          source: "manual",
          removed: false,
        });
        added.push({ id, name: item.name });
      }
    }

    let chosen = null;
    let runStarted = false;
    if (filters) {
      chosen = filtersFrom(filters, await latestFilters(ctx, sessionId));
      try {
        await startRun(ctx, sessionId, chosen, locale);
        runStarted = true;
      } catch {
        // Recipes already cooking, or nothing to cook: the list changes still stand.
      }
    }
    return { added, removed, filters: chosen, runStarted };
  },
});

/** The toast's undo: takes back what one sentence added and puts back what it removed. */
export const undo = mutation({
  args: { sessionId: v.id("sessions"), added: v.array(v.id("ingredients")), removed: v.array(v.id("ingredients")) },
  returns: v.null(),
  handler: async (ctx, { sessionId, added, removed }) => {
    for (const id of added.slice(0, 20)) {
      const item = await ctx.db.get(id);
      if (item?.sessionId === sessionId) await ctx.db.patch(id, { removed: true });
    }
    for (const id of removed.slice(0, 20)) {
      const item = await ctx.db.get(id);
      if (item?.sessionId === sessionId && !item.mergedInto) await ctx.db.patch(id, { removed: false });
    }
    return null;
  },
});
