"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

/**
 * The fridge before, and as Muse Image imagines it once the saved foods were
 * eaten: one picture over the other, a slider in between.
 */
export function BeforeAfter({ sessionId, t }: { sessionId: Id<"sessions">; t: Dictionary["impact"] }) {
  const data = useQuery(api.afters.latest, { sessionId });
  const imagine = useMutation(api.afters.imagine);
  const [split, setSplit] = useState(50);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setError(false);
          imagine({ sessionId }).catch(() => setError(true));
        }}
        className="self-start rounded-full px-4 py-2 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass"
      >
        {t.beforeAfter}
      </button>
    );
  }

  const ready = data?.status === "ready" && data.before && data.after;
  return (
    <section className="glass flex flex-col gap-3 rounded-3xl p-4" aria-label={t.beforeAfter}>
      <div className="flex items-center justify-between gap-3">
        <p className="font-display text-lg font-semibold">{t.beforeAfter}</p>
        <button type="button" onClick={() => setOpen(false)} className="text-sm font-medium underline-offset-4 hover:underline">
          {t.close}
        </button>
      </div>
      {error || data?.status === "failed" ? (
        <p className="text-sm text-betterave">{t.afterFailed}</p>
      ) : !ready ? (
        <p className="text-sm text-ink-soft" aria-live="polite">
          {t.imagining}
        </p>
      ) : (
        <>
          <div className="relative w-full overflow-hidden rounded-2xl bg-scene" style={{ aspectRatio: `${data.width} / ${data.height}` }}>
            {/* Muse Image squeezes the whole photo into a square: stretching it back lines it up with the original. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={data.after!} alt={t.after} className="absolute inset-0 size-full object-fill" />
            <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={data.before!} alt={t.before} className="absolute inset-0 size-full object-cover" />
            </div>
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-porcelaine shadow" style={{ left: `${split}%` }} />
            <span className="absolute top-3 left-3 rounded-full bg-nuit/70 px-2.5 py-1 text-xs text-porcelaine">{t.before}</span>
            <span className="absolute top-3 right-3 rounded-full bg-nuit/70 px-2.5 py-1 text-xs text-porcelaine">{t.after}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={split}
            onChange={(e) => setSplit(Number(e.target.value))}
            aria-label={t.afterHint}
            className="w-full accent-[var(--color-kaki)]"
          />
          <p className="text-sm text-ink-soft">{data.items.join(", ")}</p>
        </>
      )}
    </section>
  );
}
