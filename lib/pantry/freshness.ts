/**
 * Freshness rules shared by the UI, the recipe scorer and Convex.
 * Tiers map to the reserved ripeness palette; weights drive "use it first" scoring.
 */

export type RipenessTier = "betterave" | "kaki" | "safran" | "pousse";

export function tierFor(daysLeft: number): RipenessTier {
  if (daysLeft <= 0) return "betterave";
  if (daysLeft <= 2) return "kaki";
  if (daysLeft <= 5) return "safran";
  return "pousse";
}

/** Urgency weight per remaining day, from the design dossier. */
export function urgencyWeight(daysLeft: number): number {
  if (daysLeft <= 0) return 1;
  if (daysLeft === 1) return 0.85;
  if (daysLeft === 2) return 0.7;
  if (daysLeft === 3) return 0.5;
  if (daysLeft <= 5) return 0.3;
  if (daysLeft <= 9) return 0.15;
  return 0.05;
}

/** How full the freshness pip is (0.25 steps), so the state reads without colour. */
export function pipFill(daysLeft: number): number {
  return { betterave: 0.25, kaki: 0.5, safran: 0.75, pousse: 1 }[tierFor(daysLeft)];
}

export const tierColorVar: Record<RipenessTier, string> = {
  betterave: "var(--color-betterave)",
  kaki: "var(--color-kaki)",
  safran: "var(--color-safran)",
  pousse: "var(--color-pousse)",
};

/** The N most urgent items; emergency mode asks each recipe to use at least two of the top five. */
export function mostUrgent<T extends { daysLeft: number }>(items: readonly T[], n = 5): T[] {
  return [...items].sort((a, b) => a.daysLeft - b.daysLeft).slice(0, n);
}
