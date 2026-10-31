"use node";

import { v } from "convex/values";
import { TIPS_RESERVE_USD, parseTips, writeTips } from "../lib/meta/tips";
import { recordings } from "../lib/replay/catalog";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Storage tips: recorded for the demo fridge, written live by Muse Spark otherwise. */
export const write = internalAction({
  args: { tipsId: v.id("tips") },
  returns: v.null(),
  handler: async (ctx, { tipsId }) => {
    const data = await ctx.runQuery(internal.tips.forWriting, { tipsId });
    if (!data) return null;
    const names = data.items.map((i: { name: string }) => i.name);
    try {
      if (data.source === "replay") {
        const recorded = data.recordingIds
          .flatMap((id: string) => recordings[id]?.tips ?? [])
          .find((t) => t.locale === data.locale && t.key === data.key);
        if (recorded) {
          await sleep(Math.min(recorded.ms, 1500));
          await ctx.runMutation(internal.tips.save, { tipsId, tips: parseTips(recorded.rawText, names), costUsd: 0 });
          return null;
        }
      }
      await ctx.runMutation(internal.spend.reserve, { label: "tips", usd: TIPS_RESERVE_USD });
      let result;
      try {
        result = await writeTips(data.items, data.locale);
      } finally {
        await ctx.runMutation(internal.spend.settle, { estimateUsd: TIPS_RESERVE_USD, actualUsd: result?.costUsd ?? 0 });
      }
      await ctx.runMutation(internal.tips.save, { tipsId, tips: result.tips, costUsd: result.costUsd });
    } catch (error) {
      console.error("tips failed", tipsId, error);
      await ctx.runMutation(internal.tips.fail, { tipsId });
    }
    return null;
  },
});
