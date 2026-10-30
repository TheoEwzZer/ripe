import { defineSchema, defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

export const locale = v.union(v.literal("en"), v.literal("fr"));

export const sessionStatus = v.union(
  v.literal("waiting"),
  v.literal("analyzing"),
  v.literal("inventory"),
  v.literal("recipes"),
);

export const incomingPhoto = v.object({ dataUrl: v.string(), width: v.number(), height: v.number(), at: v.number() });

export const deviceKind = v.union(v.literal("desktop"), v.literal("phone"));

/** Where a photo was taken: one inventory gathers the fridge, the pantry and the freezer. */
export const scanPlace = v.union(v.literal("fridge"), v.literal("pantry"), v.literal("freezer"));

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
  /** No photo: items said aloud or read from a receipt, kept in the same inventory. */
  v.object({ kind: v.literal("list"), origin: v.union(v.literal("voice"), v.literal("receipt")) }),
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

export const equipmentMode = v.union(v.literal("microwave"), v.literal("air-fryer"), v.literal("one-pan"));
export const diet = v.union(v.literal("vegetarian"), v.literal("vegan"), v.literal("gluten-free"));

/** lib/recipes/filters.ts CookFilters. */
export const cookFilters = v.object({
  emergency: v.boolean(),
  maxMinutes: v.optional(v.union(v.literal(10), v.literal(15), v.literal(30))),
  equipment: v.optional(equipmentMode),
  diet: v.array(diet),
  fewDishes: v.boolean(),
  servings: v.number(),
});

export const runStatus = v.union(v.literal("cooking"), v.literal("fixing"), v.literal("done"), v.literal("error"));

/** lib/recipes/validate.ts Issue: a rule a recipe still breaks after the correction round. */
export const recipeIssue = v.union(
  v.object({ code: v.literal("unknown"), ingredient: v.string() }),
  v.object({ code: v.literal("staple"), staple: v.string() }),
  v.object({ code: v.literal("toBuy"), count: v.number() }),
  v.object({ code: v.literal("time"), minutes: v.number(), limit: v.number() }),
  v.object({ code: v.literal("equipment"), mode: equipmentMode }),
  v.object({ code: v.literal("dishes"), dishes: v.number(), limit: v.number() }),
  v.object({ code: v.literal("diet"), diet, ingredient: v.string() }),
  v.object({ code: v.literal("urgent"), used: v.number() }),
  v.object({ code: v.literal("empty") }),
);

export const recipeUse = v.object({
  /** The inventory item Ripe matched the model's name to. */
  ingredientId: v.optional(v.id("ingredients")),
  ingredient: v.string(),
  amount: v.string(),
  share: v.number(),
});

/** What a recipe says, as checked and scored by Ripe. */
export const recipeContent = {
  title: v.string(),
  pitch: v.string(),
  minutes: v.number(),
  servings: v.number(),
  equipment: v.array(v.string()),
  dishes: v.number(),
  diet: v.array(v.string()),
  uses: v.array(recipeUse),
  staples: v.array(v.string()),
  toBuy: v.array(v.string()),
  steps: v.array(v.string()),
  /** Anti-waste score computed by Ripe from urgency weights, never by the model. */
  score: v.number(),
  issues: v.array(recipeIssue),
  /** Rewritten by the correction round. */
  fixed: v.boolean(),
};

export type RecipeContent = Infer<ReturnType<typeof v.object<typeof recipeContent>>>;

/** Muse Image's plate: a stored image for live calls, a public file for replays. */
export const plate = v.union(
  v.object({ status: v.literal("imagining"), startedAt: v.number() }),
  v.object({ status: v.literal("ready"), storageId: v.optional(v.id("_storage")), src: v.optional(v.string()), ms: v.number() }),
  v.object({ status: v.literal("failed") }),
);

export default defineSchema({
  /** A temporary desktop ↔ phone session, purged after 24 h. */
  sessions: defineTable({
    code: v.string(),
    status: sessionStatus,
    locale,
    /** SHA-256 of the one-time token carried by the QR code; cleared once a phone joins. */
    joinTokenHash: v.optional(v.string()),
    /** Staple ids from lib/recipes/pantry.ts; unset means the standard pantry. */
    pantry: v.optional(v.array(v.string())),
    phoneJoinedAt: v.optional(v.number()),
    /** Sentences sent to Muse Voice in this session, against a per-session cap. */
    voiceClips: v.optional(v.number()),
    /** Printed dates read by Muse Spark in this session, against a per-session cap. */
    labelReads: v.optional(v.number()),
    /** Receipts read by Muse Spark in this session, against a per-session cap. */
    receiptReads: v.optional(v.number()),
    /** A blurred thumbnail of a photo still uploading from a phone; cleared when its scan starts. */
    incoming: v.optional(incomingPhoto),
    /** The recipe the desktop sent to the phones; each phone opens cooking mode when `at` changes. */
    cooking: v.optional(v.object({ recipeId: v.id("recipes"), at: v.number() })),
    expiresAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_expiresAt", ["expiresAt"]),

  /** A browser in the session: the desktop that decides, the phones that capture and cook. */
  devices: defineTable({
    sessionId: v.id("sessions"),
    /** Random id kept in the browser's storage, so a reload is the same device. */
    key: v.string(),
    kind: deviceKind,
    /** "Phone 2": the order in which phones joined. */
    number: v.number(),
    lastSeen: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_and_key", ["sessionId", "key"]),

  /** One photo (fridge, pantry…) inside a session. */
  scans: defineTable({
    sessionId: v.id("sessions"),
    source: scanSource,
    /** Unset on scans made before places existed: the fridge. */
    place: v.optional(scanPlace),
    /** Set when the demo is replayed from scratch: the photo leaves the inventory. */
    archived: v.optional(v.boolean()),
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
    /** Taken out of the inventory because this recipe was cooked; undo puts it back. */
    cookedIn: v.optional(v.id("recipes")),
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

  /** One "cook me something" request: three recipes for one scan's inventory. */
  recipeRuns: defineTable({
    sessionId: v.id("sessions"),
    scanId: v.id("scans"),
    filters: cookFilters,
    pantry: v.array(v.string()),
    locale,
    status: runStatus,
    source: v.union(v.literal("live"), v.literal("replay")),
    /** A recorded pass shown because live cooking was off or out of budget: filters may not hold. */
    approximate: v.boolean(),
    /** The recorded pass a replay came from, so its plates can be replayed too. */
    replayOf: v.optional(v.object({ recordingId: v.string(), cooking: v.number() })),
    swaps: v.number(),
    error: v.optional(v.string()),
    costUsd: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),

  recipes: defineTable({
    runId: v.id("recipeRuns"),
    sessionId: v.id("sessions"),
    /** Position in Muse Wonder's answer. */
    order: v.number(),
    /** A card shows from its title on ("writing"); "fixing" while the correction round rewrites it. */
    status: v.union(v.literal("writing"), v.literal("ready"), v.literal("fixing")),
    ...recipeContent,
    plate: v.optional(plate),
    swap: v.optional(v.object({ ingredient: v.string(), status: v.union(v.literal("swapping"), v.literal("failed")) })),
    /** The recipe before the last swap, so it can be undone. */
    previous: v.optional(v.object({ ...recipeContent, plate: v.optional(plate) })),
    /** Cooked from cooking mode: its ingredients left the inventory. */
    cookedAt: v.optional(v.number()),
  })
    .index("by_run", ["runId"])
    .index("by_session", ["sessionId"]),

  /** Food offered to a neighbour through a link: names, freshness and a crop of the photo, nothing personal. */
  offers: defineTable({
    sessionId: v.id("sessions"),
    items: v.array(
      v.object({
        ingredientId: v.id("ingredients"),
        name: v.string(),
        quantity: v.string(),
        daysLeft: v.number(),
        scanId: v.id("scans"),
        bbox: gridBox,
      }),
    ),
    note: v.string(),
    locale,
    claimedAt: v.optional(v.number()),
    expiresAt: v.number(),
  }).index("by_session", ["sessionId"]),

  /** Money spent on the Meta Model API per UTC day, checked before every paid call. */
  spend: defineTable({
    day: v.string(),
    usd: v.number(),
  }).index("by_day", ["day"]),
});
