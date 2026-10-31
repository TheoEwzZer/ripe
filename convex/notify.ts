"use node";

import { v } from "convex/values";
import webpush from "web-push";
import { en } from "../lib/i18n/dictionaries/en";
import { fr } from "../lib/i18n/dictionaries/fr";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** Sends one reminder to every device of the household (Web Push); forgets devices that unsubscribed. */
export const send = internalAction({
  args: { reminderId: v.id("reminders") },
  returns: v.null(),
  handler: async (ctx, { reminderId }) => {
    const data = await ctx.runQuery(internal.reminders.forSend, { reminderId });
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!data || !publicKey || !privateKey) return null;
    if (data.kind !== "test" && data.items.length === 0) {
      await ctx.runMutation(internal.reminders.markSent, { reminderId, gone: [] });
      return null;
    }
    const t = (data.locale === "fr" ? fr : en).reminders;
    const site = process.env.PUBLIC_SITE_URL ?? "https://ripe-six.vercel.app";
    webpush.setVapidDetails(site, publicKey, privateKey);
    const payload = JSON.stringify({
      title: data.kind === "test" ? t.testTitle : data.kind === "today" ? t.titleToday : t.titleTomorrow,
      body: data.kind === "test" ? t.testBody : fill(t.body, { items: data.items.join(", ") }),
      url: `/${data.locale}/s/${data.sessionId}`,
      tag: `ripe-${reminderId}`,
    });
    const gone: Id<"pushSubscriptions">[] = [];
    for (const sub of data.subscriptions) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
          TTL: 12 * 3600,
        });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) gone.push(sub._id);
        else console.error("push failed", status, (error as Error).message);
      }
    }
    await ctx.runMutation(internal.reminders.markSent, { reminderId, gone });
    return null;
  },
});
