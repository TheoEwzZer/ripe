import { notFound } from "next/navigation";
import { lang } from "next/root-params";
import { Suspense } from "react";
import { RecipeView } from "@/components/recipes/RecipeView";
import { recipeLabels } from "@/components/recipes/shared";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";

/** A recipe opened from the workspace: the sheet slides over the session, photo still in view. */
export default async function RecipeModalPage() {
  const locale = await lang();
  if (!isLocale(locale)) notFound();
  const t = await getDictionary(locale);
  return (
    <Suspense>
      <RecipeView labels={recipeLabels(t)} locale={locale} modal />
    </Suspense>
  );
}
