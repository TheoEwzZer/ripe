import { notFound } from "next/navigation";
import { lang } from "next/root-params";
import { Suspense } from "react";
import { SessionWorkspace } from "@/components/session/SessionWorkspace";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";

export default async function SessionPage() {
  const locale = await lang();
  if (!isLocale(locale)) notFound();
  const t = await getDictionary(locale);

  return (
    <Suspense fallback={<div className="h-72 rounded-3xl bg-glass" />}>
      <SessionWorkspace t={{ session: t.session, scan: t.scan, freshness: t.freshness, recipes: t.recipes, devices: t.devices, offer: t.offer, voice: t.voice, dates: t.dates, impact: t.impact }} />
    </Suspense>
  );
}
