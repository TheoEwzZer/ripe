import { ConvexError, v } from "convex/values";
import { addImpact, impactOf, noImpact, type Impact } from "../lib/impact";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";

/** The household history keeps 30 days, then forgets. */
const HISTORY_DAYS = 30;
const DAY_MS = 86_400_000;

export const householdKey = v.string();
const isHouseholdKey = (key: string) => /^[A-Za-z0-9_-]{8,64}$/.test(key);

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

type Saved = { item: Pick<Doc<"ingredients">, "name" | "quantity" | "category">; share: number };

/** Writes one saved (or wasted) moment, valued from lib/impact.ts. */
export async function recordImpact(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  kind: "cooked" | "offered" | "wasted",
  saved: Saved[],
  extra: { recipeId?: Id<"recipes">; offerId?: Id<"offers">; ingredientId?: Id<"ingredients">; title?: string } = {},
) {
  if (saved.length === 0) return;
  const total = saved.reduce<Impact>((sum, s) => addImpact(sum, impactOf(s.item, s.share)), noImpact);
  const at = Date.now();
  await ctx.db.insert("impactEvents", {
    household: session.household,
    sessionId: session._id,
    day: dayOf(at),
    kind,
    ...total,
    items: saved.map((s) => s.item.name).slice(0, 20),
    ...extra,
  });
}

export async function forgetImpact(ctx: MutationCtx, sessionId: Id<"sessions">, match: (e: Doc<"impactEvents">) => boolean) {
  const events = await ctx.db
    .query("impactEvents")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(200);
  for (const e of events) if (match(e)) await ctx.db.delete(e._id);
}

const totals = v.object({ kg: v.number(), eur: v.number(), co2e: v.number() });

function sum(events: Doc<"impactEvents">[]): Impact {
  return events.reduce<Impact>((s, e) => addImpact(s, { kg: e.kg, eur: e.eur, co2e: e.co2e }), noImpact);
}

/** What this session has saved so far (cooked or given away). */
export const forSession = query({
  args: { sessionId: v.string() },
  returns: v.object({ saved: totals, wasted: totals, moments: v.number() }),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    if (!sessionId) return { saved: noImpact, wasted: noImpact, moments: 0 };
    const events = await ctx.db
      .query("impactEvents")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .take(200);
    const saved = events.filter((e) => e.kind !== "wasted");
    return { saved: sum(saved), wasted: sum(events.filter((e) => e.kind === "wasted")), moments: saved.length };
  },
});

/**
 * The household page: 30-day totals, the zero-waste streak (days in a row
 * with something saved and nothing thrown), the last 7 days and the latest moments.
 */
export const forHousehold = query({
  args: { household: householdKey, today: v.string() },
  returns: v.object({
    saved: totals,
    wasted: totals,
    streak: v.number(),
    week: v.array(v.object({ day: v.string(), kg: v.number(), wastedKg: v.number(), cooked: v.number() })),
    recent: v.array(
      v.object({
        kind: v.union(v.literal("cooked"), v.literal("offered"), v.literal("wasted")),
        day: v.string(),
        title: v.optional(v.string()),
        items: v.array(v.string()),
        kg: v.number(),
        co2e: v.number(),
      }),
    ),
    sessions: v.number(),
  }),
  handler: async (ctx, { household, today }) => {
    const empty = { saved: noImpact, wasted: noImpact, streak: 0, week: [], recent: [], sessions: 0 };
    if (!isHouseholdKey(household) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return empty;
    const since = dayOf(Date.parse(today) - HISTORY_DAYS * DAY_MS);
    const events = await ctx.db
      .query("impactEvents")
      .withIndex("by_household_and_day", (q) => q.eq("household", household).gte("day", since))
      .take(1000);
    const byDay = new Map<string, Doc<"impactEvents">[]>();
    for (const e of events) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);

    const days = (n: number) => Array.from({ length: n }, (_, i) => dayOf(Date.parse(today) - i * DAY_MS));
    // A day counts when something was saved and nothing thrown; today may still be empty.
    let streak = 0;
    for (const [i, day] of days(HISTORY_DAYS).entries()) {
      const list = byDay.get(day) ?? [];
      const good = list.some((e) => e.kind !== "wasted") && !list.some((e) => e.kind === "wasted");
      if (good) streak++;
      else if (i > 0 || list.some((e) => e.kind === "wasted")) break;
    }
    const week = days(7)
      .reverse()
      .map((day) => {
        const list = byDay.get(day) ?? [];
        return {
          day,
          kg: sum(list.filter((e) => e.kind !== "wasted")).kg,
          wastedKg: sum(list.filter((e) => e.kind === "wasted")).kg,
          cooked: list.filter((e) => e.kind === "cooked").length,
        };
      });
    const recent = [...events]
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, 12)
      .map((e) => ({ kind: e.kind, day: e.day, title: e.title, items: e.items, kg: e.kg, co2e: e.co2e }));
    return {
      saved: sum(events.filter((e) => e.kind !== "wasted")),
      wasted: sum(events.filter((e) => e.kind === "wasted")),
      streak,
      week,
      recent,
      sessions: new Set(events.map((e) => e.sessionId)).size,
    };
  },
});

/** "I threw it away": the item leaves the inventory and counts against the streak. Undo with `unwaste`. */
export const waste = mutation({
  args: { ingredientId: v.id("ingredients") },
  returns: v.null(),
  handler: async (ctx, { ingredientId }) => {
    const item = await ctx.db.get(ingredientId);
    const session = item && (await ctx.db.get(item.sessionId));
    if (!item || !session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
    if (item.removed) return null;
    await ctx.db.patch(ingredientId, { removed: true });
    await recordImpact(ctx, session, "wasted", [{ item, share: 1 }], { ingredientId });
    return null;
  },
});

export const unwaste = mutation({
  args: { ingredientId: v.id("ingredients") },
  returns: v.null(),
  handler: async (ctx, { ingredientId }) => {
    const item = await ctx.db.get(ingredientId);
    if (!item) return null;
    await ctx.db.patch(ingredientId, { removed: false });
    await forgetImpact(ctx, item.sessionId, (e) => e.kind === "wasted" && e.ingredientId === ingredientId);
    return null;
  },
});

/** Drops household history older than 30 days. */
export const purgeOld = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - HISTORY_DAYS * DAY_MS;
    const old = await ctx.db
      .query("impactEvents")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(200);
    for (const e of old) await ctx.db.delete(e._id);
    return null;
  },
});
