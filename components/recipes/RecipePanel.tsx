"use client";

import type { FunctionReturnType } from "convex/server";
import { useMutation } from "convex/react";
import { LayoutGroup, motion } from "motion/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  MAX_SERVINGS,
  MIN_SERVINGS,
  defaultFilters,
  diets,
  equipmentModes,
  sameFilters,
  timeLimits,
  type CookFilters,
} from "@/lib/recipes/filters";
import { cleanPantry, defaultPantry, pantryKey, staples } from "@/lib/recipes/pantry";
import { planCalendar } from "@/lib/recipes/plan";
import { RecipeCard, type KitchenView, type Photo } from "./RecipeCard";
import { fill, peopleLabel, type RecipeLabels } from "./shared";

type Latest = FunctionReturnType<typeof api.recipes.latest>;

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-sm transition-colors duration-150 ${
        on ? "bg-aubergine text-porcelaine dark:bg-porcelaine dark:text-aubergine" : "ring-1 ring-hairline hover:bg-glass"
      }`}
    >
      {children}
    </button>
  );
}

/** Filters, the basic pantry, and three recipe cards that fill in while Muse Wonder writes. */
export function RecipePanel({
  sessionId,
  locale,
  data,
  pantry: sessionPantry,
  canCook,
  kitchen,
  photos,
  recipeHref,
  labels: t,
  attempt,
  onHighlight,
}: {
  sessionId: Id<"sessions">;
  locale: "en" | "fr";
  data: Latest;
  pantry: string[] | undefined;
  canCook: boolean;
  kitchen: KitchenView;
  photos: Map<string, Photo>;
  recipeHref: (recipeId: string) => string;
  labels: RecipeLabels;
  attempt: (job: () => Promise<unknown>) => Promise<void>;
  onHighlight: (keys: ReadonlySet<string> | null) => void;
}) {
  const start = useMutation(api.recipes.start);
  const setPantry = useMutation(api.recipes.setPantry).withOptimisticUpdate((store, { pantry }) => {
    const session = store.getQuery(api.sessions.get, { sessionId });
    if (session) store.setQuery(api.sessions.get, { sessionId }, { ...session, pantry });
  });

  const run = data?.run ?? null;
  const [filters, setFilters] = useState<CookFilters>(run?.filters ?? defaultFilters);
  const [showPantry, setShowPantry] = useState(false);
  // Once recipes exist, the filters fold into one line so the cards come first.
  const [editing, setEditing] = useState(run === null);
  const pantry = cleanPantry(sessionPantry ?? defaultPantry);

  const running = run?.status === "cooking" || run?.status === "fixing";
  const changed = run !== null && (!sameFilters(filters, run.filters) || pantryKey(pantry) !== pantryKey(run.pantry));
  const recipes = data?.recipes ?? [];
  // Muse Wonder's order while it writes, Ripe's score once everything is checked.
  const planned = run?.filters.plan === true && run.status === "done";
  // A plan reads in day order; ideas by Ripe's score once everything is checked.
  const shown = run?.status === "done" ? [...recipes].sort((a, b) => (planned ? (a.day ?? 9) - (b.day ?? 9) : b.score - a.score)) : recipes;

  const downloadPlan = () => {
    const start = new Date();
    const ics = planCalendar(
      shown.flatMap((r) =>
        r.day === undefined
          ? []
          : [
              {
                title: r.title,
                minutes: r.minutes,
                day: r.day,
                items: r.uses.map((u) => kitchen.get(u.ingredientId ?? "")?.name ?? u.ingredient),
              },
            ],
      ),
      { start, url: location.href.replace(/\/r\/.*$/, ""), uid: run?._id ?? "plan" },
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    link.download = "ripe-plan.ics";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  const toggle = <K extends keyof CookFilters>(key: K, value: CookFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: f[key] === value ? undefined : value }));
  const toggleDiet = (diet: CookFilters["diet"][number]) =>
    setFilters((f) => ({ ...f, diet: f.diet.includes(diet) ? f.diet.filter((d) => d !== diet) : [...f.diet, diet] }));
  const toggleStaple = (id: string) =>
    void attempt(() => setPantry({ sessionId, pantry: pantry.includes(id) ? pantry.filter((p) => p !== id) : [...pantry, id] }));

  const cook = () => {
    setEditing(false);
    setShowPantry(false);
    void attempt(() => start({ sessionId, filters, locale }));
  };

  const summary = [
    filters.plan && t.planMode,
    filters.emergency && t.emergency,
    filters.maxMinutes && fill(t.maxMinutes, { n: filters.maxMinutes }),
    filters.equipment && (filters.equipment === "microwave" ? t.microwave : filters.equipment === "air-fryer" ? t.airFryer : t.onePan),
    ...filters.diet.map((d) => (d === "vegetarian" ? t.vegetarian : d === "vegan" ? t.vegan : t.glutenFree)),
    filters.fewDishes && t.fewDishes,
    peopleLabel(filters.servings, t),
  ].filter(Boolean);

  const writtenCount = recipes.length;
  const fixingCount = recipes.filter((r) => r.status === "fixing").length;
  const seconds = run?.finishedAt ? ((run.finishedAt - run._creationTime) / 1000).toFixed(1) : null;
  const status = !run
    ? null
    : run.status === "cooking"
      ? writtenCount === 0
        ? t.thinking
        : fill(t.writing, { n: writtenCount })
      : run.status === "fixing"
        ? fixingCount === 1
          ? t.fixingOne
          : fill(t.fixing, { n: fixingCount })
        : run.status === "error"
          ? fill(t.failed, { message: run.error === "budget" ? t.budget : (run.error ?? "") })
          : run.filters.plan
            ? t.planDone
            : fill(t.done, { n: recipes.length });

  const filterBar = (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-1 rounded-full bg-surface p-1 ring-1 ring-hairline" role="radiogroup" aria-label={t.planMode}>
        {[false, true].map((plan) => (
          <button
            key={String(plan)}
            type="button"
            role="radio"
            aria-checked={Boolean(filters.plan) === plan}
            onClick={() => setFilters((f) => ({ ...f, plan: plan || undefined }))}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              Boolean(filters.plan) === plan
                ? "bg-aubergine text-porcelaine dark:bg-porcelaine dark:text-aubergine"
                : "text-ink-soft hover:text-ink"
            }`}
          >
            {plan ? t.planMode : t.ideasMode}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Chip on={filters.emergency} onClick={() => setFilters((f) => ({ ...f, emergency: !f.emergency }))}>
          {t.emergency}
        </Chip>
        {timeLimits.map((n) => (
          <Chip key={n} on={filters.maxMinutes === n} onClick={() => toggle("maxMinutes", n)}>
            {fill(t.maxMinutes, { n })}
          </Chip>
        ))}
        {equipmentModes.map((mode) => (
          <Chip key={mode} on={filters.equipment === mode} onClick={() => toggle("equipment", mode)}>
            {mode === "microwave" ? t.microwave : mode === "air-fryer" ? t.airFryer : t.onePan}
          </Chip>
        ))}
        {diets.map((diet) => (
          <Chip key={diet} on={filters.diet.includes(diet)} onClick={() => toggleDiet(diet)}>
            {diet === "vegetarian" ? t.vegetarian : diet === "vegan" ? t.vegan : t.glutenFree}
          </Chip>
        ))}
        <Chip on={filters.fewDishes} onClick={() => setFilters((f) => ({ ...f, fewDishes: !f.fewDishes }))}>
          {t.fewDishes}
        </Chip>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-full ring-1 ring-hairline">
          <button
            type="button"
            aria-label={t.fewer}
            disabled={filters.servings <= MIN_SERVINGS}
            onClick={() => setFilters((f) => ({ ...f, servings: f.servings - 1 }))}
            className="size-8 rounded-full text-lg leading-none transition-colors hover:bg-glass disabled:opacity-40"
          >
            −
          </button>
          <span className="min-w-20 text-center text-sm tabular-nums">{peopleLabel(filters.servings, t)}</span>
          <button
            type="button"
            aria-label={t.more}
            disabled={filters.servings >= MAX_SERVINGS}
            onClick={() => setFilters((f) => ({ ...f, servings: f.servings + 1 }))}
            className="size-8 rounded-full text-lg leading-none transition-colors hover:bg-glass disabled:opacity-40"
          >
            +
          </button>
        </div>
        <button
          type="button"
          aria-expanded={showPantry}
          onClick={() => setShowPantry((s) => !s)}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t.pantry} ({pantry.length})
        </button>
      </div>
      {showPantry && (
        <div className="flex flex-col gap-2 rounded-2xl bg-surface p-3 ring-1 ring-hairline">
          <p className="text-xs text-ink-soft">{t.pantryHint}</p>
          <div className="flex flex-wrap gap-1.5">
            {staples.map((s) => (
              <Chip key={s.id} on={pantry.includes(s.id)} onClick={() => toggleStaple(s.id)}>
                {s[locale]}
              </Chip>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={cook}
        disabled={!canCook || running}
        className={`rounded-full px-5 py-2.5 font-medium transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:opacity-50 ${
          !run || changed
            ? "bg-aubergine text-porcelaine hover:opacity-90 dark:bg-porcelaine dark:text-aubergine"
            : "ring-1 ring-hairline hover:bg-glass"
        }`}
      >
        {filters.plan ? (!run || changed ? t.planCook : t.replan) : !run ? t.cook : changed ? t.recookChanged : t.recook}
      </button>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {!run && (
        <div className="flex flex-col gap-1 px-1">
          <h2 className="font-display text-xl font-semibold tracking-tight">{t.emptyTitle}</h2>
          <p className="text-sm text-ink-soft">{t.emptyLead}</p>
        </div>
      )}
      {editing || !run ? (
        filterBar
      ) : (
        <div className="flex items-center gap-2 rounded-2xl bg-surface py-1.5 pr-1.5 pl-3 ring-1 ring-hairline">
          <p className="min-w-0 flex-1 truncate text-sm text-ink-soft">{summary.join(" · ")}</p>
          <button
            type="button"
            aria-expanded={false}
            onClick={() => setEditing(true)}
            className="rounded-full px-3 py-1.5 text-sm font-medium transition-colors hover:bg-glass"
          >
            {t.filters}
          </button>
          <button
            type="button"
            onClick={cook}
            disabled={!canCook || running}
            className="rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass disabled:opacity-50"
          >
            {t.recook}
          </button>
        </div>
      )}

      {run && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1" aria-live="polite">
            <p className={`font-medium ${run.status === "error" ? "text-betterave" : ""}`}>{status}</p>
            <p className="font-mono text-xs text-ink-soft">
              {run.source === "live" ? t.live : t.recorded}
              {seconds && ` · ${seconds} s`}
              {run.source === "live" && run.status === "done" && ` · $${run.costUsd.toFixed(3)}`}
            </p>
          </div>
          {run.approximate && <p className="px-1 text-xs text-ink-soft">{t.approximate}</p>}
          <LayoutGroup>
            <div className="flex flex-col gap-3">
              {planned && (
                <button
                  type="button"
                  onClick={downloadPlan}
                  className="self-start rounded-full px-4 py-2 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass"
                >
                  📅 {t.calendar}
                </button>
              )}
              {shown.map((recipe) => (
                <motion.div
                  key={recipe._id}
                  layout="position"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <RecipeCard
                    recipe={recipe}
                    kitchen={kitchen}
                    photos={photos}
                    href={recipeHref(recipe._id)}
                    labels={t}
                    onHighlight={onHighlight}
                  />
                </motion.div>
              ))}
              {run.status === "cooking" &&
                Array.from({ length: Math.max(0, 3 - recipes.length) }, (_, i) => (
                  <div
                    key={`ghost-${i}`}
                    className="aspect-[16/12] animate-pulse rounded-2xl bg-glass ring-1 ring-hairline"
                    aria-hidden="true"
                  />
                ))}
            </div>
          </LayoutGroup>
          {run.status === "done" && recipes.length > 0 && <p className="hidden px-1 text-xs text-ink-soft lg:block">{t.hoverHint}</p>}
        </div>
      )}
    </div>
  );
}
