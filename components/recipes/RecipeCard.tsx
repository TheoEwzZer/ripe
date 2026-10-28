"use client";

import Link from "next/link";
import { Pip } from "@/components/scan/Pip";
import type { GridBox } from "@/lib/pipeline/geometry";
import { PhotoCrop, ScoreRing, dishesLabel, fill, type RecipeLabels } from "./shared";

export type CardRecipe = {
  _id: string;
  status: "writing" | "ready" | "fixing";
  title: string;
  minutes: number;
  dishes: number;
  score: number;
  fixed: boolean;
  issues: unknown[];
  toBuy: string[];
  uses: { ingredientId?: string; ingredient: string }[];
  plate?: { status: "imagining" } | { status: "ready"; url: string | null } | { status: "failed" };
  swap?: { status: "swapping" | "failed" };
};

export type KitchenView = Map<string, { name: string; daysLeft: number; bbox: GridBox }>;

const MAX_CHIPS = 3;

/** One recipe in the list. Pointing at it lights its ingredients on the photo. */
export function RecipeCard({
  recipe,
  kitchen,
  photo,
  href,
  labels: t,
  onHighlight,
}: {
  recipe: CardRecipe;
  kitchen: KitchenView;
  photo: { src: string | null; width: number; height: number };
  href: string;
  labels: RecipeLabels;
  onHighlight: (keys: ReadonlySet<string> | null) => void;
}) {
  const used = [...new Set(recipe.uses.flatMap((u) => (u.ingredientId && kitchen.has(u.ingredientId) ? [u.ingredientId] : [])))];
  const items = used.map((id) => ({ id, ...kitchen.get(id)! })).sort((a, b) => a.daysLeft - b.daysLeft);
  const plate = recipe.plate?.status === "ready" ? recipe.plate.url : null;
  const writing = recipe.status === "writing";
  const busy = recipe.status === "fixing" || recipe.swap?.status === "swapping";

  const thumb = plate ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={plate} alt={fill(t.plateAlt, { title: recipe.title })} className="aspect-video w-full object-cover" />
  ) : (
    <PhotoCrop photo={photo} boxes={items.map((i) => i.bbox)} alt="" className={writing ? "animate-pulse" : ""} />
  );

  const body = (
    <>
      <div className="relative overflow-hidden rounded-xl">
        {thumb}
        {(writing || busy) && (
          <span className="absolute top-2 left-2 rounded-full bg-nuit/75 px-2.5 py-1 text-xs text-porcelaine backdrop-blur-md">
            {writing ? t.writingCard : t.fixingCard}
          </span>
        )}
      </div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg leading-tight font-semibold tracking-tight text-balance">{recipe.title}</h3>
          {!writing && (
            <p className="mt-1 text-sm text-ink-soft">
              {fill(t.minutes, { n: recipe.minutes })} · {dishesLabel(recipe.dishes, t)}
              {recipe.toBuy.length > 0 && ` · ${fill(t.toBuy, { n: recipe.toBuy.length })}`}
            </p>
          )}
        </div>
        {!writing && <ScoreRing score={recipe.score} label={t.score} />}
      </div>
      {writing ? (
        <div className="flex flex-col gap-1.5" aria-hidden="true">
          <span className="h-3 w-3/4 animate-pulse rounded-full bg-hairline" />
          <span className="h-3 w-1/2 animate-pulse rounded-full bg-hairline" />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {items.slice(0, MAX_CHIPS).map((i) => (
            <span key={i.id} className="inline-flex items-center gap-1 rounded-full py-0.5 pr-2 pl-1 text-xs ring-1 ring-hairline">
              <Pip daysLeft={i.daysLeft} className="size-3" />
              {i.name}
            </span>
          ))}
          {items.length > MAX_CHIPS && <span className="text-xs text-ink-soft">+{items.length - MAX_CHIPS}</span>}
          {recipe.fixed && <span className="text-xs text-ink-soft">· {t.fixed}</span>}
        </div>
      )}
    </>
  );

  const className = "flex flex-col gap-3 rounded-2xl bg-surface p-3 ring-1 ring-hairline transition-[box-shadow,transform] duration-200";
  if (writing) return <div className={className}>{body}</div>;
  const light = () => onHighlight(new Set(used));
  return (
    <Link
      href={href}
      scroll={false}
      className={`${className} hover:-translate-y-0.5 hover:shadow-lg focus-visible:-translate-y-0.5`}
      onPointerEnter={light}
      onPointerLeave={() => onHighlight(null)}
      onFocus={light}
      onBlur={() => onHighlight(null)}
    >
      {body}
    </Link>
  );
}
