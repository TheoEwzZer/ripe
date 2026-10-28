"use client";

import { useParams, usePathname } from "next/navigation";
import { RecipeModal } from "./RecipeModal";
import { RecipeSheet } from "./RecipeSheet";
import type { RecipeLabels } from "./shared";

/** The recipe route's client side: ids come from the URL, the sheet sits in a modal or a page. */
export function RecipeView({ labels, locale, modal }: { labels: RecipeLabels; locale: "en" | "fr"; modal: boolean }) {
  const { id, recipeId } = useParams<{ id: string; recipeId?: string }>();
  const pathname = usePathname();
  if (!modal) return recipeId ? <RecipeSheet sessionId={id} recipeId={recipeId} locale={locale} labels={labels} /> : null;
  // Going back keeps the slot's last page mounted; the URL says whether the sheet is still open.
  if (!recipeId || !pathname.includes(`/r/${recipeId}`)) return null;
  return (
    <RecipeModal label={labels.recipesTab}>
      {(close) => <RecipeSheet sessionId={id} recipeId={recipeId} locale={locale} labels={labels} onClose={close} />}
    </RecipeModal>
  );
}
