import { ConvexError, v } from "convex/values";
import { demoRecordingIds, recordings } from "../lib/replay/catalog";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { gridBox, maskFields, maskVia, perceivedFields, scanPlace, scanSource, scanStatus, segmentation } from "./schema";

const MAX_SCANS_PER_SESSION = 12;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** A scan still running after this is marked failed (scheduled actions are not retried). */
const WATCHDOG_MS = 4 * 60 * 1000;

const liveEnabled = () => Boolean(process.env.MODEL_API_KEY);

async function openSession(ctx: MutationCtx, sessionId: Id<"sessions">): Promise<Doc<"sessions">> {
  const session = await ctx.db.get(sessionId);
  if (!session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
  const scans = await ctx.db
    .query("scans")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(MAX_SCANS_PER_SESSION);
  if (scans.length >= MAX_SCANS_PER_SESSION) throw new ConvexError({ code: "quota", message: "Too many photos in this session" });
  return session;
}

/** A scan's picture as the browser loads it: a bundled file, Convex storage, or none for a list. */
export async function imageOf(ctx: QueryCtx, source: Doc<"scans">["source"]): Promise<string | null> {
  if (source.kind === "replay") return source.imageSrc;
  if (source.kind === "upload") return await ctx.storage.getUrl(source.storageId);
  return null;
}

/** The session's list of items without a photo (said aloud, or from receipts), made on first use. */
export async function listScan(ctx: MutationCtx, sessionId: Id<"sessions">, origin: "voice" | "receipt"): Promise<Id<"scans">> {
  const existing = (await activeScans(ctx, sessionId)).find((s) => s.source.kind === "list" && s.source.origin === origin);
  if (existing) return existing._id;
  return await ctx.db.insert("scans", {
    sessionId,
    source: { kind: "list", origin },
    width: 1000,
    height: 1000,
    status: "done",
    costUsd: 0,
    finishedAt: Date.now(),
  });
}

/** The photos that make up the session's inventory, oldest first. */
export async function activeScans(ctx: QueryCtx, sessionId: Id<"sessions">) {
  const scans = await ctx.db
    .query("scans")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(MAX_SCANS_PER_SESSION);
  return scans.filter((s) => !s.archived);
}

const analysing = (scans: Doc<"scans">[]) => scans.some((s) => s.status === "perceiving" || s.status === "segmenting");

async function launch(ctx: MutationCtx, sessionId: Id<"sessions">, scan: Pick<Doc<"scans">, "source" | "width" | "height" | "place">) {
  if (analysing(await activeScans(ctx, sessionId))) {
    throw new ConvexError({ code: "busy", message: "Wait for the current analysis to finish" });
  }
  const scanId = await ctx.db.insert("scans", { sessionId, ...scan, status: "perceiving", costUsd: 0 });
  await ctx.db.patch(sessionId, { status: "analyzing", incoming: undefined });
  await ctx.scheduler.runAfter(0, internal.pipeline.run, { scanId });
  await ctx.scheduler.runAfter(WATCHDOG_MS, internal.scans.watchdog, { scanId });
  return scanId;
}

/** What this deployment can do: live analysis needs MODEL_API_KEY in the Convex environment. */
export const capabilities = query({
  args: {},
  returns: v.object({ live: v.boolean(), demos: v.array(v.string()) }),
  handler: async () => ({ live: liveEnabled(), demos: demoRecordingIds }),
});

/**
 * Replays a bundled recording through the real pipeline, at $0. `fresh` starts
 * the demo over; otherwise the next demo photo joins the inventory.
 */
export const startDemo = mutation({
  args: { sessionId: v.id("sessions"), fresh: v.boolean(), place: v.optional(scanPlace) },
  returns: v.id("scans"),
  handler: async (ctx, { sessionId, fresh, place = "fridge" }) => {
    await openSession(ctx, sessionId);
    const active = await activeScans(ctx, sessionId);
    if (analysing(active)) throw new ConvexError({ code: "busy", message: "Wait for the current analysis to finish" });
    if (fresh) for (const scan of active) await ctx.db.patch(scan._id, { archived: true });
    const used = new Set(fresh ? [] : active.flatMap((s) => (s.source.kind === "replay" ? [s.source.recordingId] : [])));
    const recordingId = demoRecordingIds.find((id) => !used.has(id));
    const recording = recordingId ? recordings[recordingId] : undefined;
    if (!recordingId || !recording) throw new ConvexError({ code: "recording", message: "No demo photo left" });
    return launch(ctx, sessionId, {
      place,
      source: { kind: "replay", recordingId, imageSrc: recording.image.src },
      width: recording.image.width,
      height: recording.image.height,
    });
  },
});

export const generateUploadUrl = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.string(),
  handler: async (ctx, { sessionId }) => {
    if (!liveEnabled()) throw new ConvexError({ code: "live_disabled", message: "Live analysis is not enabled" });
    await openSession(ctx, sessionId);
    return await ctx.storage.generateUploadUrl();
  },
});

const MAX_VIDEOS_PER_SESSION = 3;
const MAX_VIDEO_SECONDS = 15;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_STILLS = 3;

/**
 * A filmed fridge: its first frame is analysed like a photo, a few later
 * frames (stills) are read for what it missed (convex/sweeping.ts), then SAM
 * follows each item through the clip (convex/tracking.ts).
 */
export const startVideo = mutation({
  args: {
    sessionId: v.id("sessions"),
    storageId: v.id("_storage"),
    width: v.number(),
    height: v.number(),
    place: v.optional(scanPlace),
    video: v.object({ storageId: v.id("_storage"), width: v.number(), height: v.number(), duration: v.number() }),
    stills: v.optional(v.array(v.object({ storageId: v.id("_storage"), time: v.number() }))),
  },
  returns: v.id("scans"),
  handler: async (ctx, { sessionId, storageId, width, height, place = "fridge", video, stills = [] }) => {
    if (!liveEnabled()) throw new ConvexError({ code: "live_disabled", message: "Live analysis is not enabled" });
    await openSession(ctx, sessionId);
    const videos = (await activeScans(ctx, sessionId)).filter((s) => s.video);
    if (videos.length >= MAX_VIDEOS_PER_SESSION) throw new ConvexError({ code: "quota", message: "Too many videos in this session" });
    const frame = await ctx.db.system.get(storageId);
    const clip = await ctx.db.system.get(video.storageId);
    const stillFiles = await Promise.all(stills.map((still) => ctx.db.system.get(still.storageId)));
    const valid =
      stills.length <= MAX_STILLS &&
      stillFiles.every((file) => file !== null && file.size <= MAX_UPLOAD_BYTES && /^image\/(jpeg|png|webp)$/.test(file.contentType ?? "")) &&
      stills.every((still) => still.time > 0 && still.time <= video.duration + 0.5) &&
      frame !== null &&
      clip !== null &&
      clip.size <= MAX_VIDEO_BYTES &&
      /^video\/(mp4|quicktime)$/.test(clip.contentType ?? "") &&
      video.duration > 0 &&
      video.duration <= MAX_VIDEO_SECONDS + 0.5 &&
      [width, height, video.width, video.height].every((n) => Number.isInteger(n) && n >= 64 && n <= 4096);
    if (!valid) {
      for (const file of [frame, clip, ...stillFiles]) if (file) await ctx.storage.delete(file._id);
      throw new ConvexError({ code: "video", message: `Send an MP4 or MOV of ${MAX_VIDEO_SECONDS} seconds at most` });
    }
    const scanId = await launch(ctx, sessionId, { source: { kind: "upload", storageId }, width, height, place });
    await ctx.db.patch(scanId, { video: { ...video, tracking: "waiting", ...(stills.length ? { stills } : {}) } });
    return scanId;
  },
});

/** Starts a live analysis of an uploaded photo. Width and height are the pixels SAM will see. */
export const startUpload = mutation({
  args: { sessionId: v.id("sessions"), storageId: v.id("_storage"), width: v.number(), height: v.number(), place: v.optional(scanPlace) },
  returns: v.id("scans"),
  handler: async (ctx, { sessionId, storageId, width, height, place = "fridge" }) => {
    if (!liveEnabled()) throw new ConvexError({ code: "live_disabled", message: "Live analysis is not enabled" });
    await openSession(ctx, sessionId);
    const file = await ctx.db.system.get(storageId);
    const valid =
      file !== null &&
      file.size <= MAX_UPLOAD_BYTES &&
      /^image\/(jpeg|png|webp)$/.test(file.contentType ?? "") &&
      [width, height].every((n) => Number.isInteger(n) && n >= 64 && n <= 4096);
    if (!valid) {
      if (file) await ctx.storage.delete(storageId);
      throw new ConvexError({ code: "upload", message: "Send a JPEG, PNG or WebP photo under 8 MB" });
    }
    return launch(ctx, sessionId, { source: { kind: "upload", storageId }, width, height, place });
  },
});

const scanView = v.object({
  _id: v.id("scans"),
  _creationTime: v.number(),
  status: scanStatus,
  error: v.optional(v.string()),
  width: v.number(),
  height: v.number(),
  imageUrl: v.union(v.string(), v.null()),
  place: scanPlace,
  video: v.optional(
    v.object({
      url: v.union(v.string(), v.null()),
      width: v.number(),
      height: v.number(),
      duration: v.number(),
      tracking: v.union(v.literal("waiting"), v.literal("tracking"), v.literal("done"), v.literal("failed")),
      frames: v.optional(v.number()),
      sweep: v.optional(v.union(v.literal("reading"), v.literal("done"), v.literal("failed"))),
      found: v.optional(v.number()),
    }),
  ),
  /** Set on the photo-less lists of items said aloud or read from receipts. */
  list: v.optional(v.union(v.literal("voice"), v.literal("receipt"))),
  recordingId: v.optional(v.string()),
  live: v.boolean(),
  finishedAt: v.optional(v.number()),
});

const ingredientView = v.object({
  _id: v.id("ingredients"),
  scanId: v.id("scans"),
  /** A duplicate folded into an item, possibly on another photo; it stays drawn on its own photo. */
  mergedInto: v.optional(v.id("ingredients")),
  order: v.number(),
  ...perceivedFields,
  segmentation,
  removed: v.boolean(),
  priceEur: v.optional(v.number()),
  /** Seconds into the scan's video where it was first seen; not on the photo. */
  seenAt: v.optional(v.number()),
});

/** Every photo of the session with one shared inventory; masks come from `masks` so this stays light. */
export const kitchen = query({
  args: { sessionId: v.string() },
  returns: v.union(v.null(), v.object({ scans: v.array(scanView), ingredients: v.array(ingredientView) })),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    if (!sessionId) return null;
    const active = await activeScans(ctx, sessionId);
    if (active.length === 0) return null;
    const scans = [];
    const ingredients = [];
    for (const scan of active) {
      scans.push({
        _id: scan._id,
        _creationTime: scan._creationTime,
        status: scan.status,
        error: scan.error,
        width: scan.width,
        height: scan.height,
        imageUrl: await imageOf(ctx, scan.source),
        list: scan.source.kind === "list" ? scan.source.origin : undefined,
        video: scan.video
          ? {
              url: await ctx.storage.getUrl(scan.video.storageId),
              width: scan.video.width,
              height: scan.video.height,
              duration: scan.video.duration,
              tracking: scan.video.tracking,
              frames: scan.video.frames,
              sweep: scan.video.sweep,
              found: scan.video.found,
            }
          : undefined,
        place: scan.place ?? "fridge",
        recordingId: scan.source.kind === "replay" ? scan.source.recordingId : undefined,
        live: scan.source.kind === "upload",
        finishedAt: scan.finishedAt,
      });
      const items = await ctx.db
        .query("ingredients")
        .withIndex("by_scan", (q) => q.eq("scanId", scan._id))
        .take(100);
      for (const i of items.sort((a, b) => a.order - b.order)) {
        ingredients.push({
          _id: i._id,
          scanId: i.scanId,
          mergedInto: i.mergedInto,
          order: i.order,
          name: i.name,
          samPrompt: i.samPrompt,
          category: i.category,
          quantity: i.quantity,
          daysLeft: i.daysLeft,
          freshnessCues: i.freshnessCues,
          dateRead: i.dateRead,
          bbox: i.bbox,
          segmentation: i.segmentation,
          removed: i.removed,
          priceEur: i.priceEur,
          seenAt: i.seenAt?.time,
        });
      }
    }
    return { scans, ingredients };
  },
});

/** Tracking failed (network, a refused prompt): try SAM again without analysing the first frame twice. */
export const retrack = mutation({
  args: { sessionId: v.id("sessions"), scanId: v.id("scans") },
  returns: v.null(),
  handler: async (ctx, { sessionId, scanId }) => {
    if (!liveEnabled()) throw new ConvexError({ code: "live_disabled", message: "Live analysis is not enabled" });
    const scan = await ctx.db.get(scanId);
    if (!scan?.video || scan.sessionId !== sessionId || scan.video.tracking !== "failed") return null;
    await openSession(ctx, scan.sessionId);
    await ctx.db.patch(scanId, { video: { ...scan.video, tracking: "waiting" } });
    await ctx.scheduler.runAfter(0, internal.tracking.track, { scanId });
    return null;
  },
});

/** Reads of a scan's detail need its session id too: a scan id seen elsewhere opens nothing. */
async function ownScan(ctx: QueryCtx, sessionId: Id<"sessions">, scanId: Id<"scans">) {
  const scan = await ctx.db.get(scanId);
  return scan !== null && scan.sessionId === sessionId;
}

/** Where each item sits frame by frame in a filmed scan. */
export const tracks = query({
  args: { sessionId: v.id("sessions"), scanId: v.id("scans") },
  returns: v.array(v.object({ ingredientId: v.id("ingredients"), boxes: v.array(v.number()) })),
  handler: async (ctx, { sessionId, scanId }) => {
    if (!(await ownScan(ctx, sessionId, scanId))) return [];
    const rows = await ctx.db
      .query("tracks")
      .withIndex("by_scan", (q) => q.eq("scanId", scanId))
      .take(16);
    return rows.map((r) => ({ ingredientId: r.ingredientId, boxes: r.boxes }));
  },
});

export const forTracking = internalQuery({
  args: { scanId: v.id("scans") },
  returns: v.union(
    v.null(),
    v.object({
      video: v.object({ storageId: v.id("_storage"), width: v.number(), height: v.number(), duration: v.number() }),
      items: v.array(v.object({ _id: v.id("ingredients"), bbox: gridBox, daysLeft: v.number(), seenAt: v.optional(v.number()) })),
    }),
  ),
  handler: async (ctx, { scanId }) => {
    const scan = await ctx.db.get(scanId);
    if (!scan?.video || scan.video.tracking !== "waiting") return null;
    const items = await ctx.db
      .query("ingredients")
      .withIndex("by_scan", (q) => q.eq("scanId", scanId))
      .take(100);
    const { storageId, width, height, duration } = scan.video;
    return {
      video: { storageId, width, height, duration },
      items: items
        .filter((i) => !i.removed && i.name)
        .sort((a, b) => a.daysLeft - b.daysLeft)
        .map((i) => ({ _id: i._id, bbox: i.bbox, daysLeft: i.daysLeft, seenAt: i.seenAt?.time })),
    };
  },
});

export const setTracking = internalMutation({
  args: {
    scanId: v.id("scans"),
    tracking: v.union(v.literal("tracking"), v.literal("done"), v.literal("failed")),
    frames: v.optional(v.number()),
    tracks: v.optional(v.array(v.object({ ingredientId: v.id("ingredients"), boxes: v.array(v.number()) }))),
    costUsd: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { scanId, tracking, frames, tracks, costUsd }) => {
    const scan = await ctx.db.get(scanId);
    if (!scan?.video) return null;
    for (const t of tracks ?? []) await ctx.db.insert("tracks", { scanId, ...t });
    await ctx.db.patch(scanId, {
      video: { ...scan.video, tracking, ...(frames ? { frames } : {}) },
      ...(costUsd ? { costUsd: scan.costUsd + costUsd } : {}),
    });
    return null;
  },
});

export const masks = query({
  args: { sessionId: v.id("sessions"), scanId: v.id("scans") },
  returns: v.array(v.object({ _id: v.id("masks"), ingredientId: v.id("ingredients"), via: maskVia, ...maskFields })),
  handler: async (ctx, { sessionId, scanId }) => {
    if (!(await ownScan(ctx, sessionId, scanId))) return [];
    const rows = await ctx.db
      .query("masks")
      .withIndex("by_scan", (q) => q.eq("scanId", scanId))
      .take(400);
    return rows.map((m) => ({
      _id: m._id,
      ingredientId: m.ingredientId,
      via: m.via,
      objectId: m.objectId,
      encoding: m.encoding,
      payload: m.payload,
      width: m.width,
      height: m.height,
      bounds: m.bounds,
      confidence: m.confidence,
    }));
  },
});

// ——— Tap to add ———

const MAX_TAPS_PER_SCAN = 20;
const MAX_PENDING_TAPS = 3;
/** Half-size of the placeholder shown under the finger, on the 0–1000 grid. */
const TAP_GHOST = 22;

/** The user tapped something Ripe missed: show a placeholder now, outline and name it in the background. */
export const tap = mutation({
  args: { sessionId: v.id("sessions"), scanId: v.id("scans"), x: v.number(), y: v.number() },
  returns: v.id("ingredients"),
  handler: async (ctx, { sessionId, scanId, x, y }) => {
    if (!liveEnabled()) throw new ConvexError({ code: "live_disabled", message: "Live analysis is not enabled" });
    const scan = await ctx.db.get(scanId);
    const session = scan && (await ctx.db.get(scan.sessionId));
    if (!scan || !session || scan.sessionId !== sessionId || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
    if (scan.status === "perceiving" || scan.status === "segmenting") {
      throw new ConvexError({ code: "busy", message: "Wait for the analysis to finish" });
    }
    if (![x, y].every(Number.isInteger) || x < 0 || y < 0 || x >= scan.width || y >= scan.height) {
      throw new ConvexError({ code: "tap", message: "Tap inside the photo" });
    }

    const items = await ctx.db
      .query("ingredients")
      .withIndex("by_scan", (q) => q.eq("scanId", scanId))
      .take(200);
    const taps = items.filter((i) => i.source === "tapped");
    if (taps.length >= MAX_TAPS_PER_SCAN) throw new ConvexError({ code: "quota", message: "Too many additions on this photo" });
    if (taps.filter((i) => i.segmentation === "pending").length >= MAX_PENDING_TAPS) {
      throw new ConvexError({ code: "busy", message: "Wait for the previous additions" });
    }

    const gx = Math.round((x / scan.width) * 1000);
    const gy = Math.round((y / scan.height) * 1000);
    const ingredientId = await ctx.db.insert("ingredients", {
      sessionId: scan.sessionId,
      scanId,
      order: items.length,
      name: "",
      samPrompt: "",
      category: "other",
      quantity: "",
      daysLeft: 7,
      freshnessCues: "",
      dateRead: null,
      bbox: {
        x_min: Math.max(0, gx - TAP_GHOST),
        y_min: Math.max(0, gy - TAP_GHOST),
        x_max: Math.min(1000, gx + TAP_GHOST),
        y_max: Math.min(1000, gy + TAP_GHOST),
      },
      segmentation: "pending",
      source: "tapped",
      removed: false,
    });
    await ctx.scheduler.runAfter(0, internal.pipeline.tapAdd, { ingredientId, x, y });
    return ingredientId;
  },
});

export const forTap = internalQuery({
  args: { ingredientId: v.id("ingredients") },
  returns: v.union(v.null(), v.object({ scanId: v.id("scans"), source: scanSource, width: v.number(), height: v.number() })),
  handler: async (ctx, { ingredientId }) => {
    const item = await ctx.db.get(ingredientId);
    const scan = item && (await ctx.db.get(item.scanId));
    return scan && { scanId: scan._id, source: scan.source, width: scan.width, height: scan.height };
  },
});

export const saveTapMasks = internalMutation({
  args: { ingredientId: v.id("ingredients"), masks: v.array(v.object(maskFields)), bbox: gridBox },
  returns: v.null(),
  handler: async (ctx, { ingredientId, masks, bbox }) => {
    const item = await ctx.db.get(ingredientId);
    if (!item) return null;
    for (const mask of masks) await ctx.db.insert("masks", { scanId: item.scanId, ingredientId, via: "point", ...mask });
    await ctx.db.patch(ingredientId, { segmentation: "point", bbox });
    return null;
  },
});

/** Muse Spark's description of the tapped item; the outline from SAM keeps its box. */
export const nameTap = internalMutation({
  args: {
    ingredientId: v.id("ingredients"),
    name: v.string(),
    samPrompt: v.string(),
    category: perceivedFields.category,
    quantity: v.string(),
    daysLeft: v.number(),
    freshnessCues: v.string(),
    dateRead: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { ingredientId, daysLeft, ...fields }) => {
    if (!(await ctx.db.get(ingredientId))) return null;
    await ctx.db.patch(ingredientId, { ...fields, daysLeft: Math.max(0, Math.round(daysLeft)) });
    return null;
  },
});

/** Nothing usable under the finger: the placeholder disappears. */
export const dropTap = internalMutation({
  args: { ingredientId: v.id("ingredients") },
  returns: v.null(),
  handler: async (ctx, { ingredientId }) => {
    for (const mask of await ctx.db
      .query("masks")
      .withIndex("by_ingredient", (q) => q.eq("ingredientId", ingredientId))
      .take(50)) {
      await ctx.db.delete(mask._id);
    }
    if (await ctx.db.get(ingredientId)) await ctx.db.delete(ingredientId);
    return null;
  },
});

// ——— Pipeline internals ———

export const forPipeline = internalQuery({
  args: { scanId: v.id("scans") },
  returns: v.union(
    v.null(),
    v.object({ status: scanStatus, source: scanSource, width: v.number(), height: v.number(), place: v.optional(scanPlace) }),
  ),
  handler: async (ctx, { scanId }) => {
    const scan = await ctx.db.get(scanId);
    return scan && { status: scan.status, source: scan.source, width: scan.width, height: scan.height, place: scan.place };
  },
});

/** One ingredient, saved the moment Muse Spark finishes describing it. */
export const addIngredient = internalMutation({
  args: { scanId: v.id("scans"), order: v.number(), item: v.object(perceivedFields) },
  returns: v.id("ingredients"),
  handler: async (ctx, { scanId, order, item }) => {
    const scan = await ctx.db.get(scanId);
    if (!scan || scan.status !== "perceiving") throw new Error("Scan is not waiting for perception");
    return await ctx.db.insert("ingredients", {
      sessionId: scan.sessionId,
      scanId,
      order,
      ...item,
      daysLeft: Math.max(0, Math.round(item.daysLeft)),
      segmentation: "pending",
      source: "perceived",
      removed: false,
    });
  },
});

/** Muse Spark's answer is complete; only box prompts and late masks remain. */
export const finishPerception = internalMutation({
  args: { scanId: v.id("scans") },
  returns: v.null(),
  handler: async (ctx, { scanId }) => {
    const scan = await ctx.db.get(scanId);
    if (scan?.status === "perceiving") await ctx.db.patch(scanId, { status: "segmenting" });
    return null;
  },
});

export const saveMasks = internalMutation({
  args: {
    scanId: v.id("scans"),
    ingredientId: v.id("ingredients"),
    via: v.union(v.literal("concept"), v.literal("box")),
    masks: v.array(v.object(maskFields)),
  },
  returns: v.null(),
  handler: async (ctx, { scanId, ingredientId, via, masks }) => {
    for (const mask of masks) await ctx.db.insert("masks", { scanId, ingredientId, via, ...mask });
    await ctx.db.patch(ingredientId, { segmentation: via });
    return null;
  },
});

export const markUnsegmented = internalMutation({
  args: { ingredientId: v.id("ingredients") },
  returns: v.null(),
  handler: async (ctx, { ingredientId }) => {
    await ctx.db.patch(ingredientId, { segmentation: "none" });
    return null;
  },
});

export const finish = internalMutation({
  args: { scanId: v.id("scans"), costUsd: v.number() },
  returns: v.null(),
  handler: async (ctx, { scanId, costUsd }) => {
    const scan = await ctx.db.get(scanId);
    if (!scan || scan.status === "error") return null;
    await ctx.db.patch(scanId, { status: "done", costUsd, finishedAt: Date.now() });
    await ctx.db.patch(scan.sessionId, { status: "inventory" });
    if (scan.video?.stills?.length && !scan.video.sweep) {
      await ctx.db.patch(scanId, { video: { ...scan.video, sweep: "reading" } });
      await ctx.scheduler.runAfter(0, internal.sweeping.sweep, { scanId });
    } else if (scan.video) {
      await ctx.scheduler.runAfter(0, internal.tracking.track, { scanId });
    }
    return null;
  },
});

/** The later frames, and every name already in the session so Muse Spark adds only what is new. */
export const forSweep = internalQuery({
  args: { scanId: v.id("scans") },
  returns: v.union(
    v.null(),
    v.object({
      stills: v.array(v.object({ storageId: v.id("_storage"), time: v.number() })),
      known: v.array(v.string()),
      place: v.optional(scanPlace),
    }),
  ),
  handler: async (ctx, { scanId }) => {
    const scan = await ctx.db.get(scanId);
    if (!scan?.video?.stills?.length || scan.video.sweep !== "reading") return null;
    const items = await ctx.db
      .query("ingredients")
      .withIndex("by_session", (q) => q.eq("sessionId", scan.sessionId))
      .take(300);
    const known = [...new Set(items.filter((i) => !i.removed && i.name.trim()).map((i) => i.name.trim()))];
    return { stills: scan.video.stills, known, place: scan.place };
  },
});

/** What the later frames showed joins the scan, off its photo; then SAM tracks everything. */
export const addSeen = internalMutation({
  args: {
    scanId: v.id("scans"),
    items: v.array(v.object({ ...perceivedFields, image: v.number() })),
    costUsd: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { scanId, items, costUsd }) => {
    const scan = await ctx.db.get(scanId);
    const stills = scan?.video?.stills;
    if (!scan?.video || !stills || scan.video.sweep !== "reading") return null;
    const order = (
      await ctx.db
        .query("ingredients")
        .withIndex("by_scan", (q) => q.eq("scanId", scanId))
        .take(200)
    ).length;
    let found = 0;
    for (const { image, ...item } of items) {
      const still = stills[image - 1];
      if (!still) continue;
      await ctx.db.insert("ingredients", {
        sessionId: scan.sessionId,
        scanId,
        order: order + found,
        ...item,
        daysLeft: Math.max(0, Math.round(item.daysLeft)),
        segmentation: "none",
        source: "perceived",
        removed: false,
        seenAt: { time: still.time, storageId: still.storageId },
      });
      found++;
    }
    await ctx.db.patch(scanId, { video: { ...scan.video, sweep: "done", found }, costUsd: scan.costUsd + costUsd });
    await ctx.scheduler.runAfter(0, internal.tracking.track, { scanId });
    return null;
  },
});

/** The later frames could not be read: track what the first frame showed. */
export const endSweep = internalMutation({
  args: { scanId: v.id("scans") },
  returns: v.null(),
  handler: async (ctx, { scanId }) => {
    const scan = await ctx.db.get(scanId);
    if (!scan?.video || scan.video.sweep !== "reading") return null;
    await ctx.db.patch(scanId, { video: { ...scan.video, sweep: "failed" } });
    await ctx.scheduler.runAfter(0, internal.tracking.track, { scanId });
    return null;
  },
});

async function failScan(ctx: MutationCtx, scan: Doc<"scans">, message: string) {
  await ctx.db.patch(scan._id, { status: "error", error: message.slice(0, 300), finishedAt: Date.now() });
  // Ingredients still waiting for an outline keep Muse Spark's box.
  const items = await ctx.db
    .query("ingredients")
    .withIndex("by_scan", (q) => q.eq("scanId", scan._id))
    .take(100);
  for (const item of items) if (item.segmentation === "pending") await ctx.db.patch(item._id, { segmentation: "none" });
  await ctx.db.patch(scan.sessionId, { status: items.length > 0 ? "inventory" : "waiting" });
}

export const fail = internalMutation({
  args: { scanId: v.id("scans"), message: v.string() },
  returns: v.null(),
  handler: async (ctx, { scanId, message }) => {
    const scan = await ctx.db.get(scanId);
    if (scan && scan.status !== "done" && scan.status !== "error") await failScan(ctx, scan, message);
    return null;
  },
});

export const watchdog = internalMutation({
  args: { scanId: v.id("scans") },
  returns: v.null(),
  handler: async (ctx, { scanId }) => {
    const scan = await ctx.db.get(scanId);
    if (scan && (scan.status === "perceiving" || scan.status === "segmenting")) {
      await failScan(ctx, scan, "The analysis timed out");
    }
    return null;
  },
});
