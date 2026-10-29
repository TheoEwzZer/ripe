import Link from "next/link";
import { notFound } from "next/navigation";
import { lang } from "next/root-params";
import { Suspense } from "react";
import { Logo } from "@/components/brand/Logo";
import { OfferView } from "@/components/offer/OfferView";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";

/** The page a neighbour opens from a surplus link. */
export default async function OfferPage() {
  const locale = await lang();
  if (!isLocale(locale)) notFound();
  const t = await getDictionary(locale);
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <Link href={`/${locale}`} aria-label="Ripe">
        <Logo className="h-8 w-auto text-ink" />
      </Link>
      <Suspense fallback={<div className="h-72 animate-pulse rounded-3xl bg-glass" />}>
        <OfferView locale={locale} t={t.offer} />
      </Suspense>
    </main>
  );
}
