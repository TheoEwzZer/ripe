"use node";

import { v } from "convex/values";
import { MAX_TRACKED, MIN_BILLED_FRAMES, SAM_USD_PER_FRAME, trackVideo, uploadVideo } from "../lib/meta/track";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

/** Phones film at up to 30 frames a second; the estimate reserved before SAM reads the clip. */
const RESERVE_FPS = 30;

/** SAM 3.1 follows the most urgent items, boxed on the first frame, through the whole clip. */
export const track = internalAction({
  args: { scanId: v.id("scans") },
  returns: v.null(),
  handler: async (ctx, { scanId }) => {
    const data = await ctx.runQuery(internal.scans.forTracking, { scanId });
    if (!data || data.items.length === 0) {
      if (data) await ctx.runMutation(internal.scans.setTracking, { scanId, tracking: "failed" });
      return null;
    }
    const { video } = data;
    const reserve = Math.max(MIN_BILLED_FRAMES, Math.ceil(video.duration * RESERVE_FPS)) * SAM_USD_PER_FRAME;
    await ctx.runMutation(internal.scans.setTracking, { scanId, tracking: "tracking" });
    let cost = 0;
    try {
      await ctx.runMutation(internal.spend.reserve, { label: "track", usd: reserve });
      const clip = await ctx.storage.get(video.storageId);
      if (!clip) throw new Error("The video is gone");
      const fileId = await uploadVideo(clip, "fridge.mp4");
      // The first frame is the analysed photo, at the same aspect: grid boxes scale straight to video pixels.
      const items = data.items.slice(0, MAX_TRACKED);
      const prompts = items.map((item, i) => ({
        id: i + 1,
        box: {
          x1: (item.bbox.x_min / 1000) * video.width,
          y1: (item.bbox.y_min / 1000) * video.height,
          x2: (item.bbox.x_max / 1000) * video.width,
          y2: (item.bbox.y_max / 1000) * video.height,
        },
      }));
      const result = await trackVideo({ fileId }, prompts, { w: video.width, h: video.height });
      cost = result.costUsd;
      const size = result.size ?? { w: video.width, h: video.height };
      const tracks = [...result.tracks.entries()].flatMap(([id, boxes]) => {
        const item = items[id - 1];
        if (!item) return [];
        const grid = (n: number, total: number) => Math.round((Math.max(0, Math.min(total, n)) / total) * 1000);
        return [
          {
            ingredientId: item._id,
            boxes: boxes.flatMap(([frame, x1, y1, x2, y2]) => [
              frame,
              grid(x1, size.w),
              grid(y1, size.h),
              grid(x2, size.w),
              grid(y2, size.h),
            ]),
          },
        ];
      });
      await ctx.runMutation(internal.scans.setTracking, { scanId, tracking: "done", frames: result.frames, tracks, costUsd: cost });
    } catch (error) {
      console.error("tracking failed", scanId, error);
      await ctx.runMutation(internal.scans.setTracking, { scanId, tracking: "failed" });
    } finally {
      await ctx.runMutation(internal.spend.settle, { estimateUsd: reserve, actualUsd: cost });
    }
    return null;
  },
});
