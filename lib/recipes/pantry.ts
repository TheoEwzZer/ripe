/**
 * The basic pantry: what a kitchen always has. Recipes may only lean on these
 * beyond the photo, so Muse Wonder stops inventing ingredients.
 */

export type StapleTag = "gluten" | "dairy" | "animal";

export type Staple = { id: string; en: string; fr: string; tags: StapleTag[]; standard: boolean };

export const staples: Staple[] = [
  { id: "oil", en: "Oil", fr: "Huile", tags: [], standard: true },
  { id: "salt-pepper", en: "Salt and pepper", fr: "Sel et poivre", tags: [], standard: true },
  { id: "butter", en: "Butter", fr: "Beurre", tags: ["dairy", "animal"], standard: true },
  { id: "garlic", en: "Garlic", fr: "Ail", tags: [], standard: true },
  { id: "onion", en: "Onion", fr: "Oignon", tags: [], standard: true },
  { id: "pasta", en: "Pasta", fr: "Pâtes", tags: ["gluten"], standard: true },
  { id: "rice", en: "Rice", fr: "Riz", tags: [], standard: true },
  { id: "flour", en: "Flour", fr: "Farine", tags: ["gluten"], standard: true },
  { id: "sugar", en: "Sugar", fr: "Sucre", tags: [], standard: true },
  { id: "spices", en: "Dried herbs and spices", fr: "Herbes et épices", tags: [], standard: true },
  { id: "vinegar", en: "Vinegar", fr: "Vinaigre", tags: [], standard: true },
  { id: "mustard", en: "Mustard", fr: "Moutarde", tags: [], standard: false },
  { id: "soy-sauce", en: "Soy sauce", fr: "Sauce soja", tags: ["gluten"], standard: false },
  { id: "stock", en: "Stock cubes", fr: "Bouillon cube", tags: [], standard: false },
  { id: "canned-tomato", en: "Canned tomatoes", fr: "Tomates en conserve", tags: [], standard: false },
  { id: "honey", en: "Honey", fr: "Miel", tags: ["animal"], standard: false },
];

export const stapleIds = staples.map((s) => s.id);
export const defaultPantry = staples.filter((s) => s.standard).map((s) => s.id);

const byId = new Map(staples.map((s) => [s.id, s]));
export const stapleById = (id: string) => byId.get(id);
export const stapleLabel = (id: string, locale: "en" | "fr") => byId.get(id)?.[locale] ?? id;

/** Known ids only, in catalogue order, so the same pantry always reads the same. */
export function cleanPantry(ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return stapleIds.filter((id) => wanted.has(id));
}

export const pantryKey = (ids: readonly string[]) => cleanPantry(ids).join(",");
