"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { PhotoCrop } from "@/components/recipes/shared";
import { Pip } from "@/components/scan/Pip";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** What a neighbour sees: each item cut from the giver's photo, how long it keeps, one button. */
export function OfferView({ locale, t }: { locale: "en" | "fr"; t: Dictionary["offer"] }) {
  const { offerId } = useParams<{ offerId: string }>();
  const offer = useQuery(api.offers.get, { offerId });
  const claim = useMutation(api.offers.claim);
  const [mine, setMine] = useState(false);
  const [pending, setPending] = useState(false);

  if (offer === undefined) return <div className="h-72 animate-pulse rounded-3xl bg-glass" aria-busy="true" />;
  if (offer === null) return <p className="text-ink-soft">{t.gone}</p>;

  const photos = new Map(offer.photos.map((p) => [p.scanId as string, p]));
  const keeps = (days: number) => (days <= 0 ? t.eatToday : days === 1 ? t.eatOne : fill(t.eatWithin, { n: days }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-extrabold tracking-tight">{t.publicTitle}</h1>
        <p className="text-ink-soft">{t.publicLead}</p>
      </div>
      {offer.note && <p className="glass rounded-2xl px-4 py-3 text-lg">« {offer.note} »</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {offer.items.map((item, i) => {
          const days = Math.max(0, item.daysLeft - offer.ageDays);
          const photo = photos.get(item.scanId);
          return (
            <li key={`${item.name}-${i}`} className="glass flex flex-col gap-2 overflow-hidden rounded-3xl p-2">
              {photo && !item.offPhoto && <PhotoCrop photo={photo} boxes={[item.bbox]} alt={item.name} className="rounded-2xl" />}
              <div className="flex items-center gap-2 px-2 pb-1">
                <Pip daysLeft={days} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{item.name}</p>
                  <p className="text-xs text-ink-soft">
                    {item.quantity && `${item.quantity} · `}
                    {keeps(days)}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div aria-live="polite">
        {mine ? (
          <p className="rounded-2xl bg-pousse/15 px-4 py-3 font-medium ring-1 ring-pousse/50">✓ {t.takenByYou}</p>
        ) : offer.claimed ? (
          <p className="text-ink-soft">{t.takenAlready}</p>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              try {
                setMine(await claim({ offerId: offerId as Id<"offers"> }));
              } catch {
                setMine(false);
              }
              setPending(false);
            }}
            className="rounded-full bg-aubergine px-8 py-4 text-lg font-medium text-porcelaine transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60 dark:bg-porcelaine dark:text-aubergine"
          >
            {pending ? t.taking : offer.items.length > 1 ? t.takeMany : t.take}
          </button>
        )}
      </div>
      <Link href={`/${locale}`} className="text-sm text-ink-soft underline-offset-4 hover:underline">
        {t.tryRipe} →
      </Link>
    </section>
  );
}
