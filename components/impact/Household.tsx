"use client";

import { useFoodName } from "@/lib/i18n/foods";
import { useQuery } from "convex/react";
import { useSyncExternalStore } from "react";
import { api } from "@/convex/_generated/api";
import { householdKey } from "@/lib/client/device";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import { formatters } from "./format";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

const noSubscribe = () => () => {};

/** The household page: 30-day totals, the zero-waste streak, the week and the latest moments, with sources. */
export function Household({ locale, t }: { locale: "en" | "fr"; t: Dictionary["impact"] }) {
  const tr = useFoodName();
  const household = useSyncExternalStore(noSubscribe, householdKey, () => null);
  const today = useSyncExternalStore(
    noSubscribe,
    () => new Date().toISOString().slice(0, 10),
    () => null,
  );
  const data = useQuery(api.impact.forHousehold, household && today ? { household, today } : "skip");
  const f = formatters(locale);
  const weekday = new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", { weekday: "short", timeZone: "UTC" });

  if (!data) return <HouseholdSkeleton />;
  const max = Math.max(0.1, ...data.week.map((d) => d.kg + d.wastedKg));
  const weekKg = data.week.reduce((s, d) => s + d.kg, 0);
  const weekCooked = data.week.reduce((s, d) => s + d.cooked, 0);
  const weekLine = fill(weekCooked === 1 ? t.weekLineOne : t.weekLine, { kg: f.kg(weekKg), n: weekCooked });

  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-3 sm:grid-cols-3" aria-label={t.period}>
        {[
          [f.kg(data.saved.kg), t.kgSaved],
          [f.eur(data.saved.eur), t.eurSaved],
          [f.co2e(data.saved.co2e), t.co2Avoided],
        ].map(([value, label]) => (
          <div key={label} className="glass flex flex-col gap-1 rounded-3xl p-5">
            <p className="font-display text-3xl font-extrabold tracking-tight">{value}</p>
            <p className="text-sm text-ink-soft">{label}</p>
          </div>
        ))}
      </section>

      <section className="glass flex flex-col gap-4 rounded-3xl p-5">
        <p className="flex items-center gap-2 font-display text-xl font-semibold">
          <span aria-hidden="true">{data.streak > 0 ? "🔥" : "🌱"}</span>
          {data.streak === 0 ? t.streakNone : data.streak === 1 ? t.streakOne : fill(t.streak, { n: data.streak })}
        </p>
        <div>
          <p className="text-sm font-medium">{t.week}</p>
          <p className="text-sm text-ink-soft">{weekLine}</p>
        </div>
        <div className="flex h-32 gap-2" role="img" aria-label={weekLine}>
          {data.week.map((d) => (
            <div key={d.day} className="flex h-full flex-1 flex-col items-center gap-1">
              <div className="flex w-full flex-1 flex-col justify-end overflow-hidden rounded-lg bg-hairline/40">
                {d.wastedKg > 0 && <div className="w-full bg-betterave" style={{ height: `${(d.wastedKg / max) * 100}%` }} />}
                <div className="w-full bg-pousse" style={{ height: `${(d.kg / max) * 100}%` }} />
              </div>
              <span className="text-[11px] text-ink-soft">{weekday.format(new Date(`${d.day}T12:00:00Z`))}</span>
            </div>
          ))}
        </div>
        {data.wasted.kg > 0 && <p className="text-sm text-betterave">{fill(t.wastedTotal, { kg: f.kg(data.wasted.kg) })}</p>}
      </section>

      <section className="glass flex flex-col gap-3 rounded-3xl p-5">
        <p className="font-display text-xl font-semibold">{t.recent}</p>
        {data.recent.length === 0 ? (
          <p className="text-ink-soft">{t.empty}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-hairline">
            {data.recent.map((e, i) => (
              <li key={`${e.day}-${i}`} className="flex items-start justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">
                    <span className={e.kind === "wasted" ? "text-betterave" : "text-feuille"}>
                      {e.kind === "cooked" ? t.cooked : e.kind === "offered" ? t.offered : t.wasted}
                    </span>
                    {e.title && ` · ${e.title}`}
                  </p>
                  <p className="truncate text-ink-soft">{e.items.map(tr).join(", ")}</p>
                </div>
                <p className="shrink-0 text-right font-mono text-xs text-ink-soft">
                  {f.kg(e.kg)}
                  <br />
                  {f.co2e(e.co2e)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2 text-sm text-ink-soft">
        <p>{t.national}</p>
        <details>
          <summary className="cursor-pointer font-medium text-ink">{t.sources}</summary>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
            <li>
              {t.sourceCo2}{" "}
              <a href="https://impactco2.fr/outils/alimentation" target="_blank" rel="noreferrer" className="underline">
                impactco2.fr
              </a>
            </li>
            <li>{t.sourceKg}</li>
            <li>{t.sourceEur}</li>
            <li>{t.sourcePaid}</li>
            <li>
              <a
                href="https://www.ecologie.gouv.fr/politiques-publiques/gaspillage-alimentaire"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                ecologie.gouv.fr
              </a>
            </li>
          </ul>
        </details>
      </section>
    </div>
  );
}

/** Same outline as the loaded page, so nothing below it moves when the numbers arrive. */
export function HouseholdSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-26 animate-pulse rounded-3xl bg-glass" />
        ))}
      </div>
      <div className="h-80 animate-pulse rounded-3xl bg-glass" />
      <div className="h-40 animate-pulse rounded-3xl bg-glass" />
    </div>
  );
}
