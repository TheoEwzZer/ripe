import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const locale = v.union(v.literal("en"), v.literal("fr"));

export const sessionStatus = v.union(
  v.literal("waiting"),
  v.literal("analyzing"),
  v.literal("inventory"),
  v.literal("recipes"),
);

export const scanStatus = v.union(
  v.literal("perceiving"),
  v.literal("segmenting"),
  v.literal("done"),
  v.literal("error"),
);

/** A demo scan replays a bundled recording; an upload goes through the Meta Model API. */
export const scanSource = v.union(
  v.object({ kind: v.literal("replay"), recordingId: v.string(), imageSrc: v.string() }),
  v.object({ kind: v.literal("upload"), storageId: v.id("_storage") }),
);

export const category = v.union(
  v.literal("produce"),
  v.literal("fruit"),
  v.literal("dairy"),
  v.literal("egg"),
  v.literal("meat"),
  v.literal("fish"),
  v.literal("bakery"),
  v.literal("condiment"),
  v.literal("drink"),
  v.literal("leftover"),
  v.literal("pantry"),
  v.literal("other"),
);

/** How an ingredient got its outline: still waiting, by its name, by Muse Spark's box, or not at all. */
export const segmentation = v.union(
  v.literal("pending"),
  v.literal("concept"),
  v.literal("box"),
  v.literal("point"),
  v.literal("none"),
);

export const maskVia = v.union(v.literal("concept"), v.literal("box"), v.literal("point"));

export const gridBox = v.object({ x_min: v.number(), y_min: v.number(), x_max: v.number(), y_max: v.number() });
export const pixelBox = v.object({ left: v.number(), top: v.number(), right: v.number(), bottom: v.number() });

/** Fields Muse Spark produces for one ingredient (lib/pantry/schema.ts). */
export const perceivedFields = {
  name: v.string(),
  samPrompt: v.string(),
  category,
  quantity: v.string(),
  daysLeft: v.number(),
  freshnessCues: v.string(),
  dateRead: v.union(v.string(), v.null()),
  /** Muse Spark box on the 0–1000 grid. */
  bbox: gridBox,
};

/** One SAM instance exactly as the API encoded it; clients decode it (lib/masks/contour.ts). */
export const maskFields = {
  objectId: v.string(),
  encoding: v.union(v.literal("lossless"), v.literal("one_bit")),
  payload: v.string(),
  width: v.number(),
  height: v.number(),
  bounds: pixelBox,
  confidence: v.optional(v.number()),
};

export default defineSchema({
  /** A temporary desktop ↔ phone session, purged after 24 h. */
  sessions: defineTable({
    code: v.string(),
    status: sessionStatus,
    locale,
    /** SHA-256 of the one-time token carried by the QR code; cleared once a phone joins. */
    joinTokenHash: v.optional(v.string()),
    phoneJoinedAt: v.optional(v.number()),
    expiresAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_expiresAt", ["expiresAt"]),

  /** One photo (fridge, pantry…) inside a session. */
  scans: defineTable({
    sessionId: v.id("sessions"),
    source: scanSource,
    width: v.number(),
    height: v.number(),
    status: scanStatus,
    error: v.optional(v.string()),
    costUsd: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),

  ingredients: defineTable({
    sessionId: v.id("sessions"),
    scanId: v.id("scans"),
    /** Position in Muse Spark's answer; object ids of box prompts refer to it. */
    order: v.number(),
    ...perceivedFields,
    segmentation,
    source: v.union(v.literal("perceived"), v.literal("tapped"), v.literal("manual")),
    removed: v.boolean(),
    /** Set on a duplicate folded into another item; undo reads it. */
    mergedInto: v.optional(v.id("ingredients")),
    /** The kept item's values before a merge, so undo can put them back. */
    beforeMerge: v.optional(v.object({ daysLeft: v.number(), quantity: v.string() })),
  })
    .index("by_session", ["sessionId"])
    .index("by_scan", ["scanId"]),

  /** SAM masks kept apart from ingredients so editing an ingredient never re-sends mask payloads. */
  masks: defineTable({
    scanId: v.id("scans"),
    ingredientId: v.id("ingredients"),
    via: maskVia,
    ...maskFields,
    /** The duplicate this mask belonged to before a merge. */
    mergedFrom: v.optional(v.id("ingredients")),
  })
    .index("by_scan", ["scanId"])
    .index("by_ingredient", ["ingredientId"]),

  recipeRuns: defineTable({
    sessionId: v.id("sessions"),
    filters: v.object({
      emergency: v.boolean(),
      maxMinutes: v.optional(v.number()),
      equipment: v.optional(v.string()),
      diet: v.array(v.string()),
    }),
    status: v.union(v.literal("cooking"), v.literal("done"), v.literal("error")),
    error: v.optional(v.string()),
  }).index("by_session", ["sessionId"]),

  recipes: defineTable({
    runId: v.id("recipeRuns"),
    sessionId: v.id("sessions"),
    title: v.string(),
    pitch: v.string(),
    minutes: v.number(),
    equipment: v.array(v.string()),
    diet: v.array(v.string()),
    uses: v.array(v.object({ ingredientId: v.optional(v.id("ingredients")), ingredient: v.string(), amount: v.string() })),
    extras: v.array(v.string()),
    steps: v.array(v.string()),
    /** Anti-waste score computed by the app from urgency weights, never by the model. */
    score: v.number(),
    plateStorageId: v.optional(v.id("_storage")),
  }).index("by_run", ["runId"]),

  /** Money spent on the Meta Model API per UTC day, checked before every paid call. */
  spend: defineTable({
    day: v.string(),
    usd: v.number(),
  }).index("by_day", ["day"]),
});
