import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const sessionStatus = v.union(
  v.literal("waiting"),
  v.literal("analyzing"),
  v.literal("inventory"),
  v.literal("recipes"),
);

export const scanStatus = v.union(
  v.literal("uploading"),
  v.literal("perceiving"),
  v.literal("segmenting"),
  v.literal("done"),
  v.literal("error"),
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

const box = v.object({ left: v.number(), top: v.number(), right: v.number(), bottom: v.number() });

export default defineSchema({
  /** A temporary desktop ↔ phone session, purged after 24 h. */
  sessions: defineTable({
    code: v.string(),
    status: sessionStatus,
    locale: v.union(v.literal("en"), v.literal("fr")),
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
    storageId: v.optional(v.id("_storage")),
    /** Set when the scan replays a recording instead of calling the API. */
    recordingId: v.optional(v.string()),
    width: v.number(),
    height: v.number(),
    status: scanStatus,
    error: v.optional(v.string()),
    costUsd: v.number(),
  }).index("by_session", ["sessionId"]),

  ingredients: defineTable({
    sessionId: v.id("sessions"),
    scanId: v.id("scans"),
    name: v.string(),
    samPrompt: v.string(),
    category,
    quantity: v.string(),
    daysLeft: v.number(),
    freshnessCues: v.string(),
    dateRead: v.union(v.string(), v.null()),
    /** Muse Spark box on the 0–1000 grid. */
    bbox: v.object({ x_min: v.number(), y_min: v.number(), x_max: v.number(), y_max: v.number() }),
    source: v.union(v.literal("perceived"), v.literal("tapped"), v.literal("manual")),
    removed: v.boolean(),
  })
    .index("by_session", ["sessionId"])
    .index("by_scan", ["scanId"]),

  /** SAM masks kept apart from ingredients so editing an ingredient never re-sends mask payloads. */
  masks: defineTable({
    scanId: v.id("scans"),
    ingredientId: v.id("ingredients"),
    objectId: v.string(),
    encoding: v.union(v.literal("lossless"), v.literal("one_bit")),
    payload: v.string(),
    width: v.number(),
    height: v.number(),
    bounds: box,
    confidence: v.optional(v.number()),
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
});
