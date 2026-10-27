import { ConvexError, v } from "convex/values";
import { defaultRecordingId, recordings } from "../lib/replay/catalog";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { maskFields, maskVia, perceivedFields, scanSource, scanStatus, segmentation } from "./schema";

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

async function launch(ctx: MutationCtx, sessionId: Id<"sessions">, scan: Pick<Doc<"scans">, "source" | "width" | "height">) {
  const scanId = await ctx.db.insert("scans", { sessionId, ...scan, status: "perceiving", costUsd: 0 });
  await ctx.db.patch(sessionId, { status: "analyzing" });
  await ctx.scheduler.runAfter(0, internal.pipeline.run, { scanId });
  await ctx.scheduler.runAfter(WATCHDOG_MS, internal.scans.watchdog, { scanId });
  return scanId;
}

/** What this deployment can do: live analysis needs MODEL_API_KEY in the Convex environment. */
export const capabilities = query({
  args: {},
  returns: v.object({ live: v.boolean() }),
  handler: async () => ({ live: liveEnabled() }),
});

/** Replays a bundled recording through the real pipeline, at $0. */
export const startDemo = mutation({
  args: { sessionId: v.id("sessions"), recordingId: v.optional(v.string()) },
  returns: v.id("scans"),
  handler: async (ctx, { sessionId, recordingId = defaultRecordingId }) => {
    await openSession(ctx, sessionId);
    const recording = recordings[recordingId];
    if (!recording) throw new ConvexError({ code: "recording", message: `Unknown recording ${recordingId}` });
    return launch(ctx, sessionId, {
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

/** Starts a live analysis of an uploaded photo. Width and height are the pixels SAM will see. */
export const startUpload = mutation({
  args: { sessionId: v.id("sessions"), storageId: v.id("_storage"), width: v.number(), height: v.number() },
  returns: v.id("scans"),
  handler: async (ctx, { sessionId, storageId, width, height }) => {
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
    return launch(ctx, sessionId, { source: { kind: "upload", storageId }, width, height });
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
  live: v.boolean(),
  finishedAt: v.optional(v.number()),
});

const ingredientView = v.object({
  _id: v.id("ingredients"),
  order: v.number(),
  ...perceivedFields,
  segmentation,
  removed: v.boolean(),
});

/** The session's most recent scan with its inventory; masks come from `masks` so this stays light. */
export const latest = query({
  args: { sessionId: v.string() },
  returns: v.union(v.null(), v.object({ scan: scanView, ingredients: v.array(ingredientView) })),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    if (!sessionId) return null;
    const scan = await ctx.db
      .query("scans")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .first();
    if (!scan) return null;
    const imageUrl = scan.source.kind === "replay" ? scan.source.imageSrc : await ctx.storage.getUrl(scan.source.storageId);
    const ingredients = await ctx.db
      .query("ingredients")
      .withIndex("by_scan", (q) => q.eq("scanId", scan._id))
      .take(100);
    return {
      scan: {
        _id: scan._id,
        _creationTime: scan._creationTime,
        status: scan.status,
        error: scan.error,
        width: scan.width,
        height: scan.height,
        imageUrl,
        live: scan.source.kind === "upload",
        finishedAt: scan.finishedAt,
      },
      ingredients: ingredients
        .sort((a, b) => a.order - b.order)
        .map((i) => ({
          _id: i._id,
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
        })),
    };
  },
});

export const masks = query({
  args: { scanId: v.id("scans") },
  returns: v.array(v.object({ _id: v.id("masks"), ingredientId: v.id("ingredients"), via: maskVia, ...maskFields })),
  handler: async (ctx, { scanId }) => {
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

// ——— Pipeline internals ———

export const forPipeline = internalQuery({
  args: { scanId: v.id("scans") },
  returns: v.union(
    v.null(),
    v.object({ status: scanStatus, source: scanSource, width: v.number(), height: v.number() }),
  ),
  handler: async (ctx, { scanId }) => {
    const scan = await ctx.db.get(scanId);
    return scan && { status: scan.status, source: scan.source, width: scan.width, height: scan.height };
  },
});

export const savePerception = internalMutation({
  args: { scanId: v.id("scans"), ingredients: v.array(v.object(perceivedFields)) },
  returns: v.array(v.id("ingredients")),
  handler: async (ctx, { scanId, ingredients }) => {
    const scan = await ctx.db.get(scanId);
    if (!scan || scan.status !== "perceiving") throw new Error("Scan is not waiting for perception");
    const ids: Id<"ingredients">[] = [];
    for (const [order, item] of ingredients.entries()) {
      ids.push(
        await ctx.db.insert("ingredients", {
          sessionId: scan.sessionId,
          scanId,
          order,
          ...item,
          daysLeft: Math.max(0, Math.round(item.daysLeft)),
          segmentation: "pending",
          source: "perceived",
          removed: false,
        }),
      );
    }
    await ctx.db.patch(scanId, { status: "segmenting" });
    return ids;
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
