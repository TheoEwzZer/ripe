"use node";

import { v } from "convex/values";
import { MAX_TRACKED, MIN_BILLED_FRAMES, SAM_USD_PER_FRAME, trackVideo, uploadVideo } from "../lib/meta/track";
import { DEFAULT_FPS, frameAt, readVideoInfo } from "../lib/video/mp4";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

/** Longest clip SAM may read, as in scans.startVideo, with the same half-second slack. */
const MAX_SECONDS = 15.5;
/** A clip whose boxes cannot be read is reserved as the longest one at 60 fps: the settle gives the rest back. */
const WORST_FRAMES = Math.ceil(MAX_SECONDS * 60);

/**
 * SAM 3.1 follows the most urgent items through the whole clip, each from the
 * frame it was boxed on: the first frame, or the later one where Muse Spark saw it.
 */
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
    await ctx.runMutation(internal.scans.setTracking, { scanId, tracking: "tracking" });
    // SAM bills every frame of the file, so the reserve comes from the file itself, never from the length the browser reported.
    const clip = await ctx.storage.get(video.storageId);
    const info = clip && readVideoInfo(await clip.arrayBuffer());
    if (!clip || (info && info.duration > MAX_SECONDS)) {
      console.error("tracking refused", scanId, clip ? `clip of ${info?.duration} s` : "the video is gone");
      await ctx.runMutation(internal.scans.setTracking, { scanId, tracking: "failed" });
      return null;
    }
    const reserve = Math.max(MIN_BILLED_FRAMES, info?.frames ?? WORST_FRAMES) * SAM_USD_PER_FRAME;
    let reserved = false;
    let cost = 0;
    try {
      await ctx.runMutation(internal.spend.reserve, { label: "track", usd: reserve });
      reserved = true;
      const fileId = await uploadVideo(clip, "fridge.mp4");
      // Every analysed frame keeps the video's aspect: grid boxes scale straight to video pixels.
      const items = data.items.slice(0, MAX_TRACKED);
      const prompts = items.map((item, i) => ({
        id: i + 1,
        frame: item.seenAt ? frameAt(item.seenAt, info?.fps ?? DEFAULT_FPS, info?.frames) : 0,
        box: {
          x1: (item.bbox.x_min / 1000) * video.width,
          y1: (item.bbox.y_min / 1000) * video.height,
          x2: (item.bbox.x_max / 1000) * video.width,
          y2: (item.bbox.y_max / 1000) * video.height,
        },
      }));
      // Once SAM has the clip, a failure may still be billed: keep the estimate unless a cost comes back.
      cost = reserve;
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
      // A reserve refused by the daily cap was never added: nothing to settle.
      if (reserved) await ctx.runMutation(internal.spend.settle, { estimateUsd: reserve, actualUsd: cost });
    }
    return null;
  },
});
