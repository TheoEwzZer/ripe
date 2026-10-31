import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { activeScans } from "./scans";
import { locale } from "./schema";

const DAY_MS = 86_400_000;
/** Reminders go out at 6 pm, the household's local time, when dinner is decided. */
const REMIND_HOUR = 18;
const HORIZON_DAYS = 7;
const MAX_SUBSCRIPTIONS = 10;

/** The server's public key, for the browser's push subscription; null when reminders are not set up. */
export const publicKey = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async () => process.env.VAPID_PUBLIC_KEY ?? null,
});

const subscription = v.object({ endpoint: v.string(), keys: v.object({ p256dh: v.string(), auth: v.string() }) });

async function householdOf(ctx: MutationCtx, sessionId: Id<"sessions">): Promise<Doc<"sessions"> & { household: string }> {
  const session = await ctx.db.get(sessionId);
  if (!session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
  if (!session.household) throw new ConvexError({ code: "household", message: "This session has no household" });
  return session as Doc<"sessions"> & { household: string };
}

/** 6 pm local on the day `days` from now; `tzOffset` is the browser's getTimezoneOffset() in minutes. */
export function localEvening(now: number, days: number, tzOffset: number): number {
  const local = new Date(now - tzOffset * 60_000);
  const evening = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, REMIND_HOUR) + tzOffset * 60_000;
  // Past 6 pm already: today's reminder goes out in a minute.
  return Math.max(evening, now + 60_000);
}

async function cancel(ctx: MutationCtx, sessionId: Id<"sessions">) {
  const pending = await ctx.db
    .query("reminders")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(50);
  for (const r of pending) {
    if (r.sent) continue;
    if (r.jobId) await ctx.scheduler.cancel(r.jobId);
    await ctx.db.delete(r._id);
  }
}

/**
 * Turns reminders on for this browser and plans them for the session's
 * items: one per evening, for what must be cooked that day or the next.
 */
export const subscribe = mutation({
  args: { sessionId: v.id("sessions"), subscription, locale, tzOffset: v.number() },
  returns: v.object({ count: v.number(), next: v.union(v.number(), v.null()) }),
  handler: async (ctx, { sessionId, subscription, locale, tzOffset }) => {
    if (!process.env.VAPID_PRIVATE_KEY) throw new ConvexError({ code: "live_disabled", message: "Reminders are not set up" });
    if (!/^https:\/\//.test(subscription.endpoint) || subscription.endpoint.length > 1000) {
      throw new ConvexError({ code: "invalid", message: "Bad push endpoint" });
    }
    if (!Number.isFinite(tzOffset) || Math.abs(tzOffset) > 14 * 60) throw new ConvexError({ code: "invalid", message: "Bad time zone" });
    const session = await householdOf(ctx, sessionId);
    const known = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", subscription.endpoint))
      .unique();
    const fields = { household: session.household, endpoint: subscription.endpoint, ...subscription.keys, locale };
    if (known) await ctx.db.patch(known._id, fields);
    else {
      const mine = await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_household", (q) => q.eq("household", session.household))
        .take(MAX_SUBSCRIPTIONS);
      if (mine.length >= MAX_SUBSCRIPTIONS) throw new ConvexError({ code: "quota", message: "Too many devices" });
      await ctx.db.insert("pushSubscriptions", fields);
    }

    await cancel(ctx, sessionId);
    const scans = new Set((await activeScans(ctx, sessionId)).map((s) => s._id));
    const items = (
      await ctx.db
        .query("ingredients")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .take(400)
    ).filter((i) => scans.has(i.scanId) && !i.removed && i.name.trim());
    // Remind on the eve of the last good day; what keeps a day or less is for tonight.
    const byDay = new Map<number, string[]>();
    for (const item of items) {
      const day = Math.max(0, item.daysLeft - 1);
      if (day > HORIZON_DAYS) continue;
      byDay.set(day, [...new Set([...(byDay.get(day) ?? []), item.name])]);
    }
    const now = Date.now();
    let next: number | null = null;
    for (const [day, names] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
      const dueAt = localEvening(now, day, tzOffset);
      const kind = items.some((i) => names.includes(i.name) && i.daysLeft <= 1) && day === 0 ? "today" : "tomorrow";
      const reminderId = await ctx.db.insert("reminders", {
        household: session.household,
        sessionId,
        dueAt,
        kind,
        items: names.slice(0, 6),
        locale,
        sent: false,
      });
      const jobId = await ctx.scheduler.runAt(dueAt, internal.notify.send, { reminderId });
      await ctx.db.patch(reminderId, { jobId });
      next ??= dueAt;
    }
    return { count: byDay.size, next };
  },
});

/** A notification right now, to check that reminders reach this device. */
export const test = mutation({
  args: { sessionId: v.id("sessions"), locale },
  returns: v.null(),
  handler: async (ctx, { sessionId, locale }) => {
    const session = await householdOf(ctx, sessionId);
    const reminderId = await ctx.db.insert("reminders", {
      household: session.household,
      sessionId,
      dueAt: Date.now(),
      kind: "test",
      items: [],
      locale,
      sent: false,
    });
    await ctx.scheduler.runAfter(0, internal.notify.send, { reminderId });
    return null;
  },
});

export const unsubscribe = mutation({
  args: { endpoint: v.string() },
  returns: v.null(),
  handler: async (ctx, { endpoint }) => {
    const known = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    if (known) await ctx.db.delete(known._id);
    return null;
  },
});

export const forSend = internalQuery({
  args: { reminderId: v.id("reminders") },
  returns: v.union(
    v.null(),
    v.object({
      kind: v.union(v.literal("today"), v.literal("tomorrow"), v.literal("test")),
      items: v.array(v.string()),
      locale,
      sessionId: v.id("sessions"),
      subscriptions: v.array(v.object({ _id: v.id("pushSubscriptions"), endpoint: v.string(), p256dh: v.string(), auth: v.string() })),
    }),
  ),
  handler: async (ctx, { reminderId }) => {
    const reminder = await ctx.db.get(reminderId);
    if (!reminder || reminder.sent) return null;
    // Items cooked or removed since then are not worth a notification.
    const remaining = new Set(
      (
        await ctx.db
          .query("ingredients")
          .withIndex("by_session", (q) => q.eq("sessionId", reminder.sessionId))
          .take(400)
      )
        .filter((i) => !i.removed)
        .map((i) => i.name),
    );
    const session = await ctx.db.get(reminder.sessionId);
    const items = session ? reminder.items.filter((name) => remaining.has(name)) : reminder.items;
    const subscriptions = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_household", (q) => q.eq("household", reminder.household))
      .take(MAX_SUBSCRIPTIONS);
    return {
      kind: reminder.kind,
      items,
      locale: reminder.locale,
      sessionId: reminder.sessionId,
      subscriptions: subscriptions.map(({ _id, endpoint, p256dh, auth }) => ({ _id, endpoint, p256dh, auth })),
    };
  },
});

export const markSent = internalMutation({
  args: { reminderId: v.id("reminders"), gone: v.array(v.id("pushSubscriptions")) },
  returns: v.null(),
  handler: async (ctx, { reminderId, gone }) => {
    const reminder = await ctx.db.get(reminderId);
    if (reminder) await ctx.db.patch(reminderId, { sent: true });
    for (const id of gone) if (await ctx.db.get(id)) await ctx.db.delete(id);
    return null;
  },
});

/** Sent reminders older than a week are forgotten. */
export const purgeOld = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query("reminders")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", Date.now() - HORIZON_DAYS * 2 * DAY_MS))
      .take(200);
    for (const r of old) await ctx.db.delete(r._id);
    return null;
  },
});
