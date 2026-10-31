"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import { formatters } from "./format";

/** What this session has saved, once there is something to show; links to the household page. */
export function ImpactStrip({ sessionId, locale, t }: { sessionId: string; locale: "en" | "fr"; t: Dictionary["impact"] }) {
  const impact = useQuery(api.impact.forSession, { sessionId });
  const f = formatters(locale);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-pousse/10 px-3 py-2 text-sm ring-1 ring-pousse/30">
      {impact && impact.moments > 0 ? (
        <p>
          <span className="font-medium">
            {t.saved}
            {locale === "fr" ? " : " : ": "}
          </span>
          {f.kg(impact.saved.kg)} · {f.eur(impact.saved.eur)} · {f.co2e(impact.saved.co2e)}
        </p>
      ) : (
        <p className="text-ink-soft">{t.stripEmpty}</p>
      )}
      <Link href={`/${locale}/foyer`} className="font-medium underline-offset-4 hover:underline">
        {t.open} →
      </Link>
    </div>
  );
}
