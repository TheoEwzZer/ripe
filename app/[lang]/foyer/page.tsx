import Link from "next/link";
import { notFound } from "next/navigation";
import { lang } from "next/root-params";
import { Suspense } from "react";
import { Logo } from "@/components/brand/Logo";
import { Household } from "@/components/impact/Household";
import { LangToggle } from "@/components/LangToggle";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";

/** The household's last 30 days: what was saved, the streak, the week. */
export default async function HouseholdPage() {
  const locale = await lang();
  if (!isLocale(locale)) notFound();
  const t = await getDictionary(locale);
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <header className="flex items-center justify-between">
        <Link href={`/${locale}`} aria-label="Ripe">
          <Logo className="h-8 w-auto text-ink" />
        </Link>
        <Suspense>
          <LangToggle locale={locale} label={t.nav.switchTo} />
        </Suspense>
      </header>
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-extrabold tracking-tight">{t.impact.title}</h1>
        <p className="max-w-xl text-ink-soft">{t.impact.lead}</p>
      </div>
      <Suspense fallback={<div className="h-72 animate-pulse rounded-3xl bg-glass" />}>
        <Household locale={locale} t={t.impact} />
      </Suspense>
    </main>
  );
}
