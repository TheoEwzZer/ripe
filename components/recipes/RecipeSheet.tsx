"use client";

import { useFoodName } from "@/lib/i18n/foods";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Pip, dayLabel } from "@/components/scan/Pip";
import { usePhonesOnline } from "@/components/session/Presence";
import { deviceKind } from "@/lib/client/device";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MAX_SERVINGS, MIN_SERVINGS } from "@/lib/recipes/filters";
import { stapleLabel } from "@/lib/recipes/pantry";
import { scaleAmount } from "@/lib/recipes/scale";
import { ShareStory } from "./ShareStory";
import { PhotoCrop, ScoreRing, applianceLabel, dishesLabel, fill, issueLabel, peopleLabel, type RecipeLabels } from "./shared";

/**
 * Everything about one recipe: the plate Muse Image imagines from the fridge
 * photo (asked for as soon as the sheet opens), servings, swaps and the
 * one or two things to buy.
 */
export function RecipeSheet({
  sessionId,
  recipeId,
  locale,
  labels: t,
  onClose,
}: {
  sessionId: string;
  recipeId: string;
  locale: "en" | "fr";
  labels: RecipeLabels;
  /** In the modal; the full page links back to the session instead. */
  onClose?: () => void;
}) {
  const tr = useFoodName();
  const data = useQuery(api.recipes.get, { sessionId, recipeId });
  const caps = useQuery(api.scans.capabilities);
  const imagine = useMutation(api.recipes.imagine);
  const swap = useMutation(api.recipes.swap);
  const undoSwap = useMutation(api.recipes.undoSwap);
  const sendToPhone = useMutation(api.recipes.sendToPhone);
  const phones = usePhonesOnline(sessionId);
  const [sent, setSent] = useState(false);
  const [servings, setServings] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const asked = useRef<string | null>(null);
  const live = caps?.live ?? false;

  // One plate per version of the recipe: a swap clears it, so the new dish gets its own.
  const version = data ? `${data.recipe._id}:${data.recipe.title}` : null;
  const needsPlate =
    data !== undefined && data !== null && data.recipe.status === "ready" && !data.recipe.plate && (data.run.replayed || live);
  useEffect(() => {
    if (!needsPlate || !version || asked.current === version) return;
    asked.current = version;
    imagine({ recipeId: recipeId as Id<"recipes"> }).catch(() => setError(true));
  }, [needsPlate, version, imagine, recipeId]);

  const close = onClose ? (
    <button
      type="button"
      onClick={onClose}
      className="rounded-full px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-glass hover:text-ink"
    >
      {t.close}
    </button>
  ) : (
    <Link
      href={`/${locale}/s/${sessionId}`}
      className="rounded-full px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-glass hover:text-ink"
    >
      ← {t.back}
    </Link>
  );

  if (data === undefined) return <div className="m-4 h-96 animate-pulse rounded-3xl bg-glass" aria-busy="true" />;
  if (data === null) {
    return (
      <div className="flex flex-col items-start gap-4 p-6">
        <p className="text-ink-soft">{t.notFound}</p>
        {close}
      </div>
    );
  }

  const { recipe, photo, items } = data;
  const byId = new Map(items.map((i) => [i._id as string, i]));
  const people = servings ?? recipe.servings;
  const factor = recipe.servings > 0 ? people / recipe.servings : 1;
  const swapping = recipe.swap?.status === "swapping" ? recipe.swap.ingredient : null;
  const plate = recipe.plate;
  const crop = (
    <PhotoCrop photo={photo} boxes={items.filter((i) => i.onPhoto).map((i) => i.bbox)} alt={fill(t.cropAlt, { title: recipe.title })} />
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recipe.toBuy.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-xs text-ink-soft">{data.run.source === "live" ? t.live : t.recorded}</p>
        {close}
      </div>

      <figure className="relative overflow-hidden rounded-2xl bg-scene">
        {plate?.status === "ready" && plate.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={plate.url} alt={fill(t.plateAlt, { title: recipe.title })} className="aspect-square w-full object-cover" />
        ) : (
          <div
            className={
              plate?.status === "imagining"
                ? "[&_img]:blur-[2px] [&_img]:scale-105 [&_img]:transition-[filter,transform] [&_img]:duration-700"
                : ""
            }
          >
            {crop}
          </div>
        )}
        {plate?.status !== "ready" && (
          <figcaption className="absolute inset-x-3 bottom-3 flex flex-col gap-2 rounded-xl bg-nuit/75 px-3 py-2 text-sm text-porcelaine backdrop-blur-md">
            <span>
              {plate?.status === "imagining"
                ? t.plateImagining
                : plate?.status === "failed" || error
                  ? t.plateFailed
                  : !live && !data.run.replayed
                    ? t.plateUnavailable
                    : t.plateImagining}
            </span>
            {(plate?.status === "imagining" || needsPlate) && (
              <span className="plate-progress h-1 overflow-hidden rounded-full bg-porcelaine/20" aria-hidden="true">
                <span className="block h-full w-1/3 rounded-full bg-porcelaine/80" />
              </span>
            )}
          </figcaption>
        )}
      </figure>

      <header className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-2xl leading-tight font-extrabold tracking-tight text-balance sm:text-3xl">{recipe.title}</h2>
          {recipe.pitch && <p className="mt-2 text-ink-soft">{recipe.pitch}</p>}
          <p className="mt-2 text-sm">
            {fill(t.minutes, { n: recipe.minutes })} · {dishesLabel(recipe.dishes, t)}
            {recipe.equipment.length > 0 && ` · ${recipe.equipment.map((e) => applianceLabel(e, t)).join(", ")}`}
          </p>
        </div>
        <div className="flex flex-col items-center gap-1" title={t.scoreHint}>
          <ScoreRing score={recipe.score} label={t.score} size={56} />
          <span className="text-center text-[11px] leading-tight text-ink-soft">{t.score}</span>
        </div>
      </header>

      {recipe.status === "ready" && (
        <div className="flex flex-wrap items-center gap-2">
          {deviceKind() === "desktop" && (
            <button
              type="button"
              disabled={phones === 0}
              title={phones === 0 ? t.noPhone : undefined}
              onClick={async () => {
                try {
                  await sendToPhone({ recipeId: recipe._id as Id<"recipes"> });
                  setSent(true);
                  setTimeout(() => setSent(false), 3000);
                } catch {
                  setError(true);
                }
              }}
              className="rounded-full bg-aubergine px-5 py-2.5 text-sm font-medium text-porcelaine transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-50 dark:bg-porcelaine dark:text-aubergine"
            >
              {sent ? `✓ ${t.sentToPhone}` : t.sendToPhone}
            </button>
          )}
          <Link
            href={`/${locale}/s/${sessionId}/cook/${recipe._id}`}
            className="rounded-full px-5 py-2.5 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass"
          >
            {t.cookMode}
          </Link>
          <ShareStory
            sessionId={sessionId}
            recipeId={recipe._id}
            title={recipe.title}
            labels={{ share: t.shareStory, sharing: t.sharingStory, shareText: t.shareStoryText }}
          />
          {deviceKind() === "desktop" && phones === 0 && <p className="text-xs text-ink-soft">{t.noPhone}</p>}
        </div>
      )}

      {(recipe.fixed || recipe.issues.length > 0) && (
        <div className="flex flex-col gap-1 rounded-2xl bg-surface p-3 text-sm ring-1 ring-hairline">
          {recipe.fixed && <p className="font-medium">{t.fixed}</p>}
          {recipe.issues.length > 0 && (
            <>
              <p className="font-medium text-betterave">{t.issues}</p>
              <ul className="list-disc pl-5 text-ink-soft">
                {recipe.issues.map((issue, i) => (
                  <li key={i}>{issueLabel(issue, t, (id) => stapleLabel(id, locale))}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <section className="flex flex-col gap-3" aria-labelledby="from-kitchen">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="from-kitchen" className="font-display text-lg font-semibold">
            {t.fromKitchen}
          </h3>
          <div className="flex items-center gap-1 rounded-full ring-1 ring-hairline">
            <button
              type="button"
              aria-label={t.fewer}
              disabled={people <= MIN_SERVINGS}
              onClick={() => setServings(people - 1)}
              className="size-8 rounded-full text-lg leading-none transition-colors hover:bg-glass disabled:opacity-40"
            >
              −
            </button>
            <span className="min-w-20 text-center text-sm tabular-nums">{peopleLabel(people, t)}</span>
            <button
              type="button"
              aria-label={t.more}
              disabled={people >= MAX_SERVINGS}
              onClick={() => setServings(people + 1)}
              className="size-8 rounded-full text-lg leading-none transition-colors hover:bg-glass disabled:opacity-40"
            >
              +
            </button>
          </div>
        </div>
        {swapping && (
          <p className="text-sm text-ink-soft" aria-live="polite">
            {fill(t.swapping, { name: swapping })}
          </p>
        )}
        {recipe.swap?.status === "failed" && <p className="text-sm text-betterave">{t.swapFailed}</p>}
        <ul className="flex flex-col divide-y divide-hairline rounded-2xl ring-1 ring-hairline">
          {recipe.uses.map((use, i) => {
            const item = use.ingredientId ? byId.get(use.ingredientId) : undefined;
            return (
              <li key={`${use.ingredient}-${i}`} className="flex items-center gap-3 px-3 py-2.5">
                {item ? (
                  <Pip daysLeft={item.daysLeft} />
                ) : (
                  <span className="size-4 shrink-0 rounded-full ring-1 ring-hairline" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{tr(item?.name ?? use.ingredient)}</p>
                  {use.amount && <p className="text-sm text-ink-soft">{scaleAmount(use.amount, factor, locale)}</p>}
                </div>
                {item && <span className="font-mono text-xs text-ink-soft">{dayLabel(item.daysLeft, t.scan)}</span>}
                {live && (
                  <button
                    type="button"
                    disabled={swapping !== null || recipe.status !== "ready"}
                    onClick={() => swap({ recipeId: recipe._id, ingredient: use.ingredient }).catch(() => setError(true))}
                    aria-label={fill(t.swapLabel, { name: tr(item?.name ?? use.ingredient) })}
                    title={fill(t.swapLabel, { name: tr(item?.name ?? use.ingredient) })}
                    className="rounded-full px-2.5 py-1 text-xs ring-1 ring-hairline transition-colors hover:bg-glass disabled:opacity-40"
                  >
                    {t.swap}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {!live && <p className="text-xs text-ink-soft">{t.swapOff}</p>}
        {recipe.canUndoSwap && swapping === null && (
          <button
            type="button"
            onClick={() => undoSwap({ recipeId: recipe._id })}
            className="self-start text-sm font-medium underline-offset-4 hover:underline"
          >
            {t.undoSwap}
          </button>
        )}
      </section>

      {recipe.staples.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="from-pantry">
          <h3 id="from-pantry" className="font-display text-lg font-semibold">
            {t.fromPantry}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {recipe.staples.map((id) => (
              <span key={id} className="rounded-full px-2.5 py-1 text-sm ring-1 ring-hairline">
                {stapleLabel(id, locale)}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2" aria-labelledby="to-buy">
        <h3 id="to-buy" className="font-display text-lg font-semibold">
          {t.shopping}
        </h3>
        {recipe.toBuy.length === 0 ? (
          <p className="text-sm text-ink-soft">{t.nothingToBuy}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {recipe.toBuy.map((item) => (
              <span key={item} className="rounded-full bg-safran/25 px-3 py-1 text-sm">
                {item}
              </span>
            ))}
            <button
              type="button"
              onClick={copy}
              className="rounded-full px-3 py-1 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass"
            >
              {copied ? t.copied : t.copy}
            </button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="steps">
        <h3 id="steps" className="font-display text-lg font-semibold">
          {t.steps}
        </h3>
        <ol className="flex flex-col gap-3">
          {recipe.steps.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-aubergine font-mono text-xs text-porcelaine dark:bg-porcelaine dark:text-aubergine">
                {i + 1}
              </span>
              <p className="pt-0.5 leading-relaxed">{step}</p>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
