"use node";

import { v } from "convex/values";
import { IMAGE_USD_PER_IMAGE } from "../lib/meta/models";
import { fridgeAfter } from "../lib/meta/plate";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { publicImageUrl } from "./pipeline";

/** Muse Image draws the fridge once the saved foods are gone. */
export const after = internalAction({
  args: { afterId: v.id("afters") },
  returns: v.null(),
  handler: async (ctx, { afterId }) => {
    const data = await ctx.runQuery(internal.afters.forAfter, { afterId });
    const imageUrl = data && (await publicImageUrl(ctx, data.source));
    if (!data || !imageUrl) {
      await ctx.runMutation(internal.afters.fail, { afterId });
      return null;
    }
    try {
      await ctx.runMutation(internal.spend.reserve, { label: "after", usd: IMAGE_USD_PER_IMAGE });
      const { webp, ms } = await fridgeAfter(imageUrl, data.items);
      const storageId = await ctx.storage.store(new Blob([new Uint8Array(webp)], { type: "image/webp" }));
      await ctx.runMutation(internal.afters.save, { afterId, storageId, ms });
    } catch (error) {
      console.error("after failed", afterId, error);
      await ctx.runMutation(internal.afters.fail, { afterId });
    }
    return null;
  },
});
