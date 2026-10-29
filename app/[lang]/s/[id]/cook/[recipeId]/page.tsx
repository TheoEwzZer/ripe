import { notFound } from "next/navigation";
import { lang } from "next/root-params";
import { Suspense } from "react";
import { CookParams } from "@/components/cook/CookParams";
import { recipeLabels } from "@/components/recipes/shared";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";

/** Cooking mode, usually on the phone the desktop sent the recipe to. */
export default async function CookPage() {
  const locale = await lang();
  if (!isLocale(locale)) notFound();
  const t = await getDictionary(locale);
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-glass" />}>
      <CookParams labels={recipeLabels(t)} locale={locale} />
    </Suspense>
  );
}
