"use client";

import { useParams } from "next/navigation";
import type { RecipeLabels } from "@/components/recipes/shared";
import { CookMode } from "./CookMode";

/** Ids come from the URL, like the recipe sheet's. */
export function CookParams({ labels, locale }: { labels: RecipeLabels; locale: "en" | "fr" }) {
  const { id, recipeId } = useParams<{ id: string; recipeId: string }>();
  return <CookMode sessionId={id} recipeId={recipeId} locale={locale} labels={labels} />;
}
