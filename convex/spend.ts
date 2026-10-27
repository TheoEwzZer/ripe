import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";

/** Daily cap on Meta Model API spending, in USD. Set META_DAILY_BUDGET_USD in the Convex dashboard. */
function dailyCapUsd(): number {
  const raw = Number(process.env.META_DAILY_BUDGET_USD);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

const today = () => new Date().toISOString().slice(0, 10);

async function todayRow(ctx: MutationCtx) {
  const day = today();
  const row = await ctx.db
    .query("spend")
    .withIndex("by_day", (q) => q.eq("day", day))
    .unique();
  if (row) return row;
  const id = await ctx.db.insert("spend", { day, usd: 0 });
  return (await ctx.db.get(id))!;
}

/** Reserves an estimate before a paid call; throws once the day's cap would be exceeded. */
export const reserve = internalMutation({
  args: { label: v.string(), usd: v.number() },
  returns: v.null(),
  handler: async (ctx, { label, usd }) => {
    if (!Number.isFinite(usd) || usd < 0 || usd > 1) throw new Error(`Invalid estimate ${usd} for ${label}`);
    const row = await todayRow(ctx);
    if (row.usd + usd > dailyCapUsd()) {
      throw new ConvexError({ code: "budget", message: `Daily Meta API budget of $${dailyCapUsd()} reached` });
    }
    await ctx.db.patch(row._id, { usd: row.usd + usd });
    return null;
  },
});

/** Swaps an estimate for the measured cost once usage comes back. */
export const settle = internalMutation({
  args: { estimateUsd: v.number(), actualUsd: v.number() },
  returns: v.null(),
  handler: async (ctx, { estimateUsd, actualUsd }) => {
    if (![estimateUsd, actualUsd].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return null;
    const row = await todayRow(ctx);
    await ctx.db.patch(row._id, { usd: Math.max(0, row.usd + actualUsd - estimateUsd) });
    return null;
  },
});
