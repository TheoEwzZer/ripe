"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { Pip } from "@/components/scan/Pip";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

type Tip = NonNullable<ReturnType<typeof useTips>>["tips"][number];

const place = (where: Tip["where"], t: Dictionary["tips"]) =>
  ({ fridge: t.fridge, crisper: t.crisper, freezer: t.freezer, counter: t.counter, pantry: t.pantry })[where];
const rescue = (action: Tip["tooLate"]["action"], t: Dictionary["tips"]) =>
  ({ cook_today: t.cookToday, freeze: t.freeze, transform: t.transform, compost: t.compost })[action];

/** The session's tips in this language; asks Muse Spark (or the demo recording) the first time. */
export function useTips(sessionId: Id<"sessions">, locale: "en" | "fr", enabled: boolean) {
  const data = useQuery(api.tips.forSession, { sessionId, locale });
  const request = useMutation(api.tips.request);
  const asked = useRef(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled || asked.current || data === undefined) return;
    asked.current = true;
    request({ sessionId, locale }).catch(() => setError(true));
  }, [enabled, data, request, sessionId, locale]);
  return data === undefined ? null : data ? { ...data, error } : { status: error ? "error" : "writing", tips: [], error };
}

export function TipCard({ tip, daysLeft, t }: { tip: Tip; daysLeft?: number; t: Dictionary["tips"] }) {
  const urgent = daysLeft !== undefined && daysLeft <= 1;
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <p>
        <span className="font-medium">{place(tip.where, t)}</span>
        {tip.extraDays > 0 && (
          <span className="ml-2 rounded-full bg-pousse/15 px-2 py-0.5 text-xs text-feuille">{fill(t.gained, { n: tip.extraDays })}</span>
        )}
      </p>
      <p className="text-ink-soft">{tip.how}</p>
      {tip.tooLate.how && (
        <p className={urgent ? "text-ink" : "text-ink-soft"}>
          <span className={`font-medium ${urgent ? "text-kaki" : ""}`}>
            {t.tooLate} {rescue(tip.tooLate.action, t)}
          </span>
          {" — "}
          {tip.tooLate.how}
        </p>
      )}
    </div>
  );
}

/** How to keep the most urgent items longer, and what to do with them at the limit. */
export function TipsPanel({
  sessionId,
  locale,
  items,
  t,
  onClose,
}: {
  sessionId: Id<"sessions">;
  locale: "en" | "fr";
  items: { name: string; daysLeft: number }[];
  t: Dictionary["tips"];
  onClose: () => void;
}) {
  const data = useTips(sessionId, locale, true);
  const daysOf = new Map(items.map((i) => [i.name, i.daysLeft]));
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface p-3 ring-1 ring-hairline">
      <div className="flex items-start justify-between gap-3">
        <p className="font-display text-lg font-semibold">{t.title}</p>
        <button type="button" onClick={onClose} className="shrink-0 text-sm font-medium underline-offset-4 hover:underline">
          {t.close}
        </button>
      </div>
      {!data || data.status === "writing" ? (
        <p className="text-sm text-ink-soft" aria-live="polite">
          {t.writing}
        </p>
      ) : data.status === "error" ? (
        <p className="text-sm text-betterave">{t.failed}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-hairline">
          {data.tips.map((tip) => (
            <li key={tip.item} className="flex gap-3 py-2.5">
              <Pip daysLeft={daysOf.get(tip.item) ?? 7} />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{tip.item}</p>
                <TipCard tip={tip} daysLeft={daysOf.get(tip.item)} t={t} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
