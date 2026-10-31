import type { Issue } from "./validate";

export const PLAN_DAYS = 3;

export type PlanRecipe = {
  uses: { item: { id: string; name: string; daysLeft: number } | null; share: number }[];
  makesLeftover: string;
  usesLeftover: string;
};

function permutations(n: number): number[][] {
  if (n <= 1) return [[0].slice(0, n)];
  return permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)]));
}

const fold = (text: string) => text.trim().toLowerCase();

/**
 * Puts three recipes on tonight (0), tomorrow (1) and the day after (2):
 * no item planned after it goes off, the most urgent items first, and a
 * dish that leaves something for later before the dish that reuses it.
 * Returns each recipe's day and the plan-level problems that remain.
 */
export function arrangePlan(recipes: readonly PlanRecipe[]): { days: number[]; issues: Issue[][] } {
  const n = Math.min(recipes.length, PLAN_DAYS);
  const cost = (days: number[]) => {
    let total = 0;
    recipes.slice(0, n).forEach((recipe, r) => {
      for (const use of recipe.uses) {
        if (!use.item) continue;
        // Late is a hard fault; otherwise the sooner an urgent item is eaten, the better.
        if (days[r] > use.item.daysLeft) total += 100 * (days[r] - use.item.daysLeft);
        total += (days[r] * use.share) / Math.max(1, use.item.daysLeft);
      }
      const reuse = fold(recipe.usesLeftover);
      if (reuse) {
        const maker = recipes.findIndex((other, o) => o !== r && fold(other.makesLeftover) === reuse);
        if (maker >= 0 && maker < n && days[maker] >= days[r]) total += 50;
      }
    });
    return total;
  };
  const best =
    permutations(n).reduce<number[] | null>((winner, days) => (!winner || cost(days) < cost(winner) ? days : winner), null) ?? [];

  const issues: Issue[][] = recipes.map(() => []);
  const shares = new Map<string, { name: string; share: number; last: number }>();
  recipes.slice(0, n).forEach((recipe, r) => {
    for (const use of recipe.uses) {
      if (!use.item) continue;
      if (best[r] > use.item.daysLeft)
        issues[r].push({ code: "late", ingredient: use.item.name, day: best[r], daysLeft: use.item.daysLeft });
      const seen = shares.get(use.item.id) ?? { name: use.item.name, share: 0, last: r };
      shares.set(use.item.id, { name: use.item.name, share: seen.share + use.share, last: r });
    }
  });
  // Rounding in the answers is forgiven up to 10%; the recipe that tips it over carries the issue.
  for (const { name, share, last } of shares.values()) {
    if (share > 1.1) issues[last].push({ code: "overused", ingredient: name, share: Math.round(share * 100) / 100 });
  }
  return { days: best, issues };
}

/** One iCalendar file with a dinner per planned day, at 19:00 local time. */
export function planCalendar(
  recipes: readonly { title: string; minutes: number; day: number; items: string[] }[],
  opts: { start: Date; url: string; uid: string },
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T190000`;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const escape = (text: string) =>
    text
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/([,;])/g, "\\$1");
  // Lines longer than 75 characters continue on the next line after a space (RFC 5545).
  const fold = (line: string) => line.match(/.{1,73}/g)?.join("\r\n ") ?? line;
  const events = recipes.flatMap((r) => {
    const day = new Date(opts.start);
    day.setDate(day.getDate() + r.day);
    return [
      "BEGIN:VEVENT",
      `UID:${opts.uid}-${r.day}@ripe`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${local(day)}`,
      `DURATION:PT${Math.max(15, r.minutes)}M`,
      `SUMMARY:${escape(r.title)}`,
      `DESCRIPTION:${escape(`${r.items.join(", ")}\n${opts.url}`)}`,
      `URL:${opts.url}`,
      "END:VEVENT",
    ];
  });
  return (
    ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ripe//Plan//EN", "CALSCALE:GREGORIAN", ...events, "END:VCALENDAR"]
      .map(fold)
      .join("\r\n") + "\r\n"
  );
}
