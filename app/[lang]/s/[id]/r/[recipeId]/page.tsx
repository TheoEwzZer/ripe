import { notFound } from "next/navigation";
import { lang } from "next/root-params";
import { Suspense } from "react";
import { RecipeView } from "@/components/recipes/RecipeView";
import { recipeLabels } from "@/components/recipes/shared";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";

/** A recipe opened from a link or a refresh: the same sheet as a full page. */
export default async function RecipePage() {
  const locale = await lang();
  if (!isLocale(locale)) notFound();
  const t = await getDictionary(locale);
  return (
    <div className="glass mx-auto w-full max-w-2xl rounded-3xl">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-glass" />}>
        <RecipeView labels={recipeLabels(t)} locale={locale} modal={false} />
      </Suspense>
    </div>
  );
}
