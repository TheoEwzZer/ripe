import { ConvexError, v, type Infer } from "convex/values";
import { MAX_SERVINGS, MIN_SERVINGS } from "../lib/recipes/filters";
import { cleanPantry, defaultPantry, stapleIds } from "../lib/recipes/pantry";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { activeScans } from "./scans";
import { cookFilters, gridBox, locale, plate, recipeContent, runStatus, scanSource } from "./schema";

const MAX_RUNS_PER_SESSION = 20;
const MAX_PLATES_PER_SESSION = 9;
const MAX_SWAPS_PER_RUN = 6;
/** Scheduled actions are not retried: anything still running after this is marked failed. */
const RUN_WATCHDOG_MS = 3 * 60 * 1000;
const PLATE_WATCHDOG_MS = 2 * 60 * 1000;

const liveEnabled = () => Boolean(process.env.MODEL_API_KEY);

async function openSession(ctx: QueryCtx, sessionId: Id<"sessions">): Promise<Doc<"sessions">> {
  const session = await ctx.db.get(sessionId);
  if (!session || session.expiresAt < Date.now()) throw new ConvexError({ code: "session", message: "Session expired" });
  return session;
}

/** What the recipes may use: every photo's items still on the list, with a name, most urgent first. */
async function kitchenOf(ctx: QueryCtx, sessionId: Id<"sessions">) {
  const scans = new Set((await activeScans(ctx, sessionId)).map((s) => s._id));
  const items = await ctx.db
    .query("ingredients")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(400);
  return items
    .filter((i) => scans.has(i.scanId) && !i.removed && i.name.trim() !== "")
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 60)
    .map((i) => ({ id: i._id as string, name: i.name, quantity: i.quantity, daysLeft: i.daysLeft, category: i.category }));
}

/** The photo that holds most of a recipe's ingredients: its crop, its highlight, Muse Image's source. */
async function mainScan(ctx: QueryCtx, recipe: Doc<"recipes">, run: Doc<"recipeRuns">): Promise<Doc<"scans"> | null> {
  const counts = new Map<Id<"scans">, number>();
  for (const id of new Set(recipe.uses.flatMap((u) => (u.ingredientId ? [u.ingredientId] : [])))) {
    const item = await ctx.db.get(id);
    if (item) counts.set(item.scanId, (counts.get(item.scanId) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return (best && (await ctx.db.get(best))) ?? (await ctx.db.get(run.scanId));
}

const kitchenItem = v.object({ id: v.string(), name: v.string(), quantity: v.string(), daysLeft: v.number(), category: v.string() });

async function recipeFor(ctx: MutationCtx, recipeId: Id<"recipes">) {
  const recipe = await ctx.db.get(recipeId);
  const run = recipe && (await ctx.db.get(recipe.runId));
  if (!recipe || !run) throw new ConvexError({ code: "session", message: "This recipe is gone" });
  await openSession(ctx, recipe.sessionId);
  return { recipe, run };
}

// ——— Client API ———

/** Three recipes for everything the session's photos show; the cards fill in as Muse Wonder writes. */
export const start = mutation({
  args: { sessionId: v.id("sessions"), filters: cookFilters, locale },
  returns: v.id("recipeRuns"),
  handler: async (ctx, { sessionId, filters, locale }) => {
    const session = await openSession(ctx, sessionId);
    if (!Number.isInteger(filters.servings) || filters.servings < MIN_SERVINGS || filters.servings > MAX_SERVINGS) {
      throw new ConvexError({ code: "invalid", message: `Servings must be ${MIN_SERVINGS} to ${MAX_SERVINGS}` });
    }
    const scans = await activeScans(ctx, sessionId);
    const scan = scans.at(-1);
    if (!scan || scans.some((s) => s.status !== "done" && s.status !== "error")) {
      throw new ConvexError({ code: "busy", message: "Wait for the analysis to finish" });
    }
    if ((await kitchenOf(ctx, sessionId)).length === 0) throw new ConvexError({ code: "empty", message: "Nothing to cook with" });

    const runs = await ctx.db
      .query("recipeRuns")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .take(MAX_RUNS_PER_SESSION);
    if (runs.some((r) => r.status === "cooking" || r.status === "fixing")) {
      throw new ConvexError({ code: "busy", message: "Recipes are already cooking" });
    }
    if (runs.length >= MAX_RUNS_PER_SESSION) throw new ConvexError({ code: "quota", message: "Too many recipe requests in this session" });

    const runId = await ctx.db.insert("recipeRuns", {
      sessionId,
      scanId: scan._id,
      filters: { ...filters, diet: [...new Set(filters.diet)] },
      pantry: cleanPantry(session.pantry ?? defaultPantry),
      locale,
      status: "cooking",
      source: "live",
      approximate: false,
      swaps: 0,
      costUsd: 0,
    });
    await ctx.db.patch(sessionId, { status: "recipes" });
    await ctx.scheduler.runAfter(0, internal.cooking.run, { runId });
    await ctx.scheduler.runAfter(RUN_WATCHDOG_MS, internal.recipes.runWatchdog, { runId });
    return runId;
  },
});

/** What the kitchen always has, for every recipe of this session. */
export const setPantry = mutation({
  args: { sessionId: v.id("sessions"), pantry: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { sessionId, pantry }) => {
    await openSession(ctx, sessionId);
    if (pantry.length > stapleIds.length) throw new ConvexError({ code: "invalid", message: "Unknown staples" });
    await ctx.db.patch(sessionId, { pantry: cleanPantry(pantry) });
    return null;
  },
});

const runView = v.object({
  _id: v.id("recipeRuns"),
  _creationTime: v.number(),
  scanId: v.id("scans"),
  filters: cookFilters,
  pantry: v.array(v.string()),
  locale,
  status: runStatus,
  source: v.union(v.literal("live"), v.literal("replay")),
  approximate: v.boolean(),
  error: v.optional(v.string()),
  costUsd: v.number(),
  finishedAt: v.optional(v.number()),
});

const plateView = v.union(
  v.object({ status: v.literal("imagining"), startedAt: v.number() }),
  v.object({ status: v.literal("ready"), url: v.union(v.string(), v.null()), ms: v.number() }),
  v.object({ status: v.literal("failed") }),
);

const recipeView = v.object({
  _id: v.id("recipes"),
  order: v.number(),
  status: v.union(v.literal("writing"), v.literal("ready"), v.literal("fixing")),
  ...recipeContent,
  plate: v.optional(plateView),
  swap: v.optional(v.object({ ingredient: v.string(), status: v.union(v.literal("swapping"), v.literal("failed")) })),
  canUndoSwap: v.boolean(),
  cookedAt: v.optional(v.number()),
});

async function plateUrl(ctx: QueryCtx, p: Infer<typeof plate> | undefined): Promise<Infer<typeof plateView> | undefined> {
  if (!p || p.status !== "ready") return p;
  const url = p.storageId ? await ctx.storage.getUrl(p.storageId) : (p.src ?? null);
  return { status: "ready", url, ms: p.ms };
}

async function viewOf(ctx: QueryCtx, r: Doc<"recipes">): Promise<Infer<typeof recipeView>> {
  return {
    _id: r._id,
    order: r.order,
    status: r.status,
    title: r.title,
    pitch: r.pitch,
    minutes: r.minutes,
    servings: r.servings,
    equipment: r.equipment,
    dishes: r.dishes,
    diet: r.diet,
    uses: r.uses,
    staples: r.staples,
    toBuy: r.toBuy,
    steps: r.steps,
    score: r.score,
    issues: r.issues,
    fixed: r.fixed,
    plate: await plateUrl(ctx, r.plate),
    swap: r.swap,
    canUndoSwap: r.previous !== undefined,
    cookedAt: r.cookedAt,
  };
}

/** The session's latest recipe request with its cards, in Muse Wonder's order. */
export const latest = query({
  args: { sessionId: v.string() },
  returns: v.union(v.null(), v.object({ run: runView, recipes: v.array(recipeView) })),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    if (!sessionId) return null;
    const run = await ctx.db
      .query("recipeRuns")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .first();
    if (!run || (await ctx.db.get(run.scanId))?.archived) return null;
    const rows = await ctx.db
      .query("recipes")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .take(10);
    const recipes = await Promise.all(rows.sort((a, b) => a.order - b.order).map((r) => viewOf(ctx, r)));
    return {
      run: {
        _id: run._id,
        _creationTime: run._creationTime,
        scanId: run.scanId,
        filters: run.filters,
        pantry: run.pantry,
        locale: run.locale,
        status: run.status,
        source: run.source,
        approximate: run.approximate,
        error: run.error,
        costUsd: run.costUsd,
        finishedAt: run.finishedAt,
      },
      recipes,
    };
  },
});

/** One recipe card, with the inventory items it uses, for the recipe sheet. */
export const get = query({
  args: { sessionId: v.string(), recipeId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      recipe: recipeView,
      run: v.object({ source: v.union(v.literal("live"), v.literal("replay")), locale, replayed: v.boolean() }),
      photo: v.object({ src: v.union(v.string(), v.null()), width: v.number(), height: v.number() }),
      items: v.array(
        v.object({
          _id: v.id("ingredients"),
          name: v.string(),
          daysLeft: v.number(),
          removed: v.boolean(),
          bbox: gridBox,
          /** On the photo shown in the sheet; the others were seen on another photo. */
          onPhoto: v.boolean(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    const recipeId = ctx.db.normalizeId("recipes", args.recipeId);
    if (!sessionId || !recipeId) return null;
    const session = await ctx.db.get(sessionId);
    const recipe = await ctx.db.get(recipeId);
    const run = recipe && (await ctx.db.get(recipe.runId));
    const scan = recipe && run && (await mainScan(ctx, recipe, run));
    if (!session || session.expiresAt < Date.now() || !recipe || !run || !scan || recipe.sessionId !== sessionId) return null;
    const items = [];
    for (const id of new Set(recipe.uses.flatMap((u) => (u.ingredientId ? [u.ingredientId] : [])))) {
      const item = await ctx.db.get(id);
      if (item) {
        items.push({ _id: item._id, name: item.name, daysLeft: item.daysLeft, removed: item.removed, bbox: item.bbox, onPhoto: item.scanId === scan._id });
      }
    }
    const src = scan.source.kind === "replay" ? scan.source.imageSrc : await ctx.storage.getUrl(scan.source.storageId);
    return {
      recipe: await viewOf(ctx, recipe),
      // A recorded plate exists only for an untouched recorded recipe.
      run: { source: run.source, locale: run.locale, replayed: run.replayOf !== undefined && recipe.previous === undefined },
      photo: { src, width: scan.width, height: scan.height },
      items,
    };
  },
});

/** Muse Image imagines the finished dish from the fridge photo, once per recipe, when its sheet opens. */
export const imagine = mutation({
  args: { recipeId: v.id("recipes") },
  returns: v.null(),
  handler: async (ctx, { recipeId }) => {
    const { recipe, run } = await recipeFor(ctx, recipeId);
    if (recipe.status !== "ready" || (recipe.plate && recipe.plate.status !== "failed")) return null;
    const recorded = run.replayOf !== undefined && recipe.previous === undefined;
    if (!recorded && !liveEnabled()) return null;
    const imagined = await ctx.db
      .query("recipes")
      .withIndex("by_session", (q) => q.eq("sessionId", recipe.sessionId))
      .take(100);
    if (imagined.filter((r) => r.plate).length >= MAX_PLATES_PER_SESSION) {
      throw new ConvexError({ code: "quota", message: "Too many plates in this session" });
    }
    await ctx.db.patch(recipeId, { plate: { status: "imagining", startedAt: Date.now() } });
    await ctx.scheduler.runAfter(0, internal.cooking.plate, { recipeId });
    await ctx.scheduler.runAfter(PLATE_WATCHDOG_MS, internal.recipes.failPlate, { recipeId });
    return null;
  },
});

/** Rewrites the recipe without one of its ingredients (live only). */
export const swap = mutation({
  args: { recipeId: v.id("recipes"), ingredient: v.string() },
  returns: v.null(),
  handler: async (ctx, { recipeId, ingredient }) => {
    if (!liveEnabled()) throw new ConvexError({ code: "live_disabled", message: "Live cooking is not enabled" });
    const { recipe, run } = await recipeFor(ctx, recipeId);
    if (recipe.status !== "ready" || recipe.swap?.status === "swapping") throw new ConvexError({ code: "busy", message: "This recipe is busy" });
    if (!recipe.uses.some((u) => u.ingredient === ingredient)) throw new ConvexError({ code: "invalid", message: "Not in this recipe" });
    if (run.swaps >= MAX_SWAPS_PER_RUN) throw new ConvexError({ code: "quota", message: "Too many swaps" });
    await ctx.db.patch(run._id, { swaps: run.swaps + 1 });
    await ctx.db.patch(recipeId, { swap: { ingredient, status: "swapping" } });
    await ctx.scheduler.runAfter(0, internal.cooking.swap, { recipeId });
    return null;
  },
});

export const undoSwap = mutation({
  args: { recipeId: v.id("recipes") },
  returns: v.null(),
  handler: async (ctx, { recipeId }) => {
    const { recipe } = await recipeFor(ctx, recipeId);
    if (!recipe.previous || recipe.swap?.status === "swapping") return null;
    if (recipe.plate?.status === "ready" && recipe.plate.storageId) await ctx.storage.delete(recipe.plate.storageId);
    await ctx.db.patch(recipeId, { ...recipe.previous, previous: undefined, swap: undefined });
    return null;
  },
});

/** Most of an item goes into the dish: it leaves the inventory once the recipe is cooked. */
const USED_UP_SHARE = 0.5;

/** The desktop hands the recipe to every phone in the session; they open cooking mode. */
export const sendToPhone = mutation({
  args: { recipeId: v.id("recipes") },
  returns: v.null(),
  handler: async (ctx, { recipeId }) => {
    const { recipe } = await recipeFor(ctx, recipeId);
    if (recipe.status !== "ready") throw new ConvexError({ code: "busy", message: "This recipe is still being written" });
    await ctx.db.patch(recipe.sessionId, { cooking: { recipeId, at: Date.now() } });
    return null;
  },
});

/** "I cooked it": the items the recipe used up leave the inventory. Returns how many. */
export const markCooked = mutation({
  args: { recipeId: v.id("recipes") },
  returns: v.number(),
  handler: async (ctx, { recipeId }) => {
    const { recipe } = await recipeFor(ctx, recipeId);
    if (recipe.cookedAt) return 0;
    let count = 0;
    for (const use of recipe.uses) {
      if (!use.ingredientId || use.share < USED_UP_SHARE) continue;
      const item = await ctx.db.get(use.ingredientId);
      if (!item || item.removed || item.sessionId !== recipe.sessionId) continue;
      await ctx.db.patch(item._id, { removed: true, cookedIn: recipeId });
      count++;
    }
    await ctx.db.patch(recipeId, { cookedAt: Date.now() });
    return count;
  },
});

export const unmarkCooked = mutation({
  args: { recipeId: v.id("recipes") },
  returns: v.null(),
  handler: async (ctx, { recipeId }) => {
    const { recipe } = await recipeFor(ctx, recipeId);
    for (const use of recipe.uses) {
      const item = use.ingredientId && (await ctx.db.get(use.ingredientId));
      if (item && item.cookedIn === recipeId) await ctx.db.patch(item._id, { removed: false, cookedIn: undefined });
    }
    await ctx.db.patch(recipeId, { cookedAt: undefined });
    return null;
  },
});

// ——— Cooking internals (convex/cooking.ts) ———

export const forRun = internalQuery({
  args: { runId: v.id("recipeRuns") },
  returns: v.union(
    v.null(),
    v.object({
      status: runStatus,
      filters: cookFilters,
      pantry: v.array(v.string()),
      locale,
      scanSource,
      kitchen: v.array(kitchenItem),
      liveRuns: v.number(),
    }),
  ),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    const scan = run && (await ctx.db.get(run.scanId));
    if (!run || !scan) return null;
    const runs = await ctx.db
      .query("recipeRuns")
      .withIndex("by_session", (q) => q.eq("sessionId", run.sessionId))
      .take(MAX_RUNS_PER_SESSION);
    return {
      status: run.status,
      filters: run.filters,
      pantry: run.pantry,
      locale: run.locale,
      scanSource: scan.source,
      kitchen: await kitchenOf(ctx, run.sessionId),
      liveRuns: runs.filter((r) => r._id !== runId && r.source === "live").length,
    };
  },
});

export const begin = internalMutation({
  args: {
    runId: v.id("recipeRuns"),
    source: v.union(v.literal("live"), v.literal("replay")),
    approximate: v.boolean(),
    replayOf: v.optional(v.object({ recordingId: v.string(), cooking: v.number() })),
  },
  returns: v.null(),
  handler: async (ctx, { runId, ...fields }) => {
    await ctx.db.patch(runId, fields);
    return null;
  },
});

async function recipeAt(ctx: MutationCtx, runId: Id<"recipeRuns">, order: number) {
  return await ctx.db
    .query("recipes")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .take(10)
    .then((rows) => rows.find((r) => r.order === order) ?? null);
}

const blank = { pitch: "", minutes: 0, servings: 0, equipment: [], dishes: 0, diet: [], uses: [], staples: [], toBuy: [], steps: [], score: 0, issues: [], fixed: false };

/** A title is written: its card appears. */
export const draft = internalMutation({
  args: { runId: v.id("recipeRuns"), order: v.number(), title: v.string() },
  returns: v.null(),
  handler: async (ctx, { runId, order, title }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "cooking" || order >= 6 || (await recipeAt(ctx, runId, order))) return null;
    await ctx.db.insert("recipes", { runId, sessionId: run.sessionId, order, status: "writing", ...blank, title: title.slice(0, 120) });
    return null;
  },
});

export const saveRecipe = internalMutation({
  args: { runId: v.id("recipeRuns"), order: v.number(), content: v.object(recipeContent) },
  returns: v.null(),
  handler: async (ctx, { runId, order, content }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status === "error" || order >= 6) return null;
    const existing = await recipeAt(ctx, runId, order);
    if (existing) await ctx.db.patch(existing._id, { status: "ready", ...content });
    else await ctx.db.insert("recipes", { runId, sessionId: run.sessionId, order, status: "ready", ...content });
    return null;
  },
});

export const dropRecipe = internalMutation({
  args: { runId: v.id("recipeRuns"), order: v.number() },
  returns: v.null(),
  handler: async (ctx, { runId, order }) => {
    const existing = await recipeAt(ctx, runId, order);
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

export const markFixing = internalMutation({
  args: { runId: v.id("recipeRuns"), orders: v.array(v.number()) },
  returns: v.null(),
  handler: async (ctx, { runId, orders }) => {
    await ctx.db.patch(runId, { status: "fixing" });
    for (const order of orders) {
      const existing = await recipeAt(ctx, runId, order);
      if (existing) await ctx.db.patch(existing._id, { status: "fixing" });
    }
    return null;
  },
});

async function clearDrafts(ctx: MutationCtx, runId: Id<"recipeRuns">) {
  for (const r of await ctx.db.query("recipes").withIndex("by_run", (q) => q.eq("runId", runId)).take(10)) {
    if (r.status === "writing") await ctx.db.delete(r._id);
    else if (r.status === "fixing") await ctx.db.patch(r._id, { status: "ready" });
  }
}

export const finishRun = internalMutation({
  args: { runId: v.id("recipeRuns"), costUsd: v.number() },
  returns: v.null(),
  handler: async (ctx, { runId, costUsd }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status === "error") return null;
    await clearDrafts(ctx, runId);
    await ctx.db.patch(runId, { status: "done", costUsd, finishedAt: Date.now() });
    return null;
  },
});

export const failRun = internalMutation({
  args: { runId: v.id("recipeRuns"), message: v.string() },
  returns: v.null(),
  handler: async (ctx, { runId, message }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status === "done" || run.status === "error") return null;
    await clearDrafts(ctx, runId);
    await ctx.db.patch(runId, { status: "error", error: message.slice(0, 300), finishedAt: Date.now() });
    return null;
  },
});

export const runWatchdog = internalMutation({
  args: { runId: v.id("recipeRuns") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (run && (run.status === "cooking" || run.status === "fixing")) {
      await clearDrafts(ctx, runId);
      await ctx.db.patch(runId, { status: "error", error: "Cooking timed out", finishedAt: Date.now() });
    }
    return null;
  },
});

export const forPlate = internalQuery({
  args: { recipeId: v.id("recipes") },
  returns: v.union(
    v.null(),
    v.object({
      imagining: v.boolean(),
      title: v.string(),
      ingredients: v.array(v.string()),
      order: v.number(),
      swapped: v.boolean(),
      replayOf: v.optional(v.object({ recordingId: v.string(), cooking: v.number() })),
      scanSource,
    }),
  ),
  handler: async (ctx, { recipeId }) => {
    const recipe = await ctx.db.get(recipeId);
    const run = recipe && (await ctx.db.get(recipe.runId));
    const scan = recipe && run && (await mainScan(ctx, recipe, run));
    if (!recipe || !run || !scan) return null;
    return {
      imagining: recipe.plate?.status === "imagining",
      title: recipe.title,
      ingredients: recipe.uses.map((u) => u.ingredient),
      order: recipe.order,
      swapped: recipe.previous !== undefined,
      replayOf: run.replayOf,
      scanSource: scan.source,
    };
  },
});

export const savePlate = internalMutation({
  args: { recipeId: v.id("recipes"), storageId: v.optional(v.id("_storage")), src: v.optional(v.string()), ms: v.number() },
  returns: v.null(),
  handler: async (ctx, { recipeId, storageId, src, ms }) => {
    const recipe = await ctx.db.get(recipeId);
    if (!recipe || recipe.plate?.status !== "imagining") {
      if (storageId) await ctx.storage.delete(storageId);
      return null;
    }
    await ctx.db.patch(recipeId, { plate: { status: "ready", storageId, src, ms } });
    return null;
  },
});

export const failPlate = internalMutation({
  args: { recipeId: v.id("recipes") },
  returns: v.null(),
  handler: async (ctx, { recipeId }) => {
    const recipe = await ctx.db.get(recipeId);
    if (recipe?.plate?.status === "imagining") await ctx.db.patch(recipeId, { plate: { status: "failed" } });
    return null;
  },
});


export const forSwap = internalQuery({
  args: { recipeId: v.id("recipes") },
  returns: v.union(
    v.null(),
    v.object({
      ingredient: v.string(),
      content: v.object(recipeContent),
      filters: cookFilters,
      pantry: v.array(v.string()),
      locale,
      kitchen: v.array(kitchenItem),
    }),
  ),
  handler: async (ctx, { recipeId }) => {
    const recipe = await ctx.db.get(recipeId);
    const run = recipe && (await ctx.db.get(recipe.runId));
    if (!recipe || !run || recipe.swap?.status !== "swapping") return null;
    const { title, pitch, minutes, servings, equipment, dishes, diet, uses, staples, toBuy, steps, score, issues, fixed } = recipe;
    return {
      ingredient: recipe.swap.ingredient,
      content: { title, pitch, minutes, servings, equipment, dishes, diet, uses, staples, toBuy, steps, score, issues, fixed },
      filters: run.filters,
      pantry: run.pantry,
      locale: run.locale,
      kitchen: await kitchenOf(ctx, run.sessionId),
    };
  },
});

export const saveSwap = internalMutation({
  args: { recipeId: v.id("recipes"), content: v.object(recipeContent) },
  returns: v.null(),
  handler: async (ctx, { recipeId, content }) => {
    const recipe = await ctx.db.get(recipeId);
    if (!recipe || recipe.swap?.status !== "swapping") return null;
    const { title, pitch, minutes, servings, equipment, dishes, diet, uses, staples, toBuy, steps, score, issues, fixed, plate } = recipe;
    // Only the first swap is kept for undo; the plate goes with the old version.
    if (recipe.previous && plate?.status === "ready" && plate.storageId) await ctx.storage.delete(plate.storageId);
    await ctx.db.patch(recipeId, {
      ...content,
      previous: recipe.previous ?? { title, pitch, minutes, servings, equipment, dishes, diet, uses, staples, toBuy, steps, score, issues, fixed, plate },
      plate: undefined,
      swap: undefined,
    });
    return null;
  },
});

export const failSwap = internalMutation({
  args: { recipeId: v.id("recipes") },
  returns: v.null(),
  handler: async (ctx, { recipeId }) => {
    const recipe = await ctx.db.get(recipeId);
    if (recipe?.swap?.status === "swapping") await ctx.db.patch(recipeId, { swap: { ...recipe.swap, status: "failed" } });
    return null;
  },
});
