import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import type { RipenessTier } from "@/lib/pantry/freshness";
import type { GridBox } from "@/lib/pipeline/geometry";
import type { Issue } from "@/lib/recipes/validate";

export type RecipeLabels = Dictionary["recipes"] & {
  scan: Pick<Dictionary["scan"], "daysLeft" | "today">;
  tiers: Record<RipenessTier, string>;
};

export const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

export const peopleLabel = (n: number, t: RecipeLabels) => (n === 1 ? t.personOne : fill(t.people, { n }));
export const dishesLabel = (n: number, t: RecipeLabels) => (n <= 1 ? t.dishOne : fill(t.dishes, { n }));

const modeLabel = (mode: "microwave" | "air-fryer" | "one-pan", t: RecipeLabels) =>
  mode === "microwave" ? t.microwave : mode === "air-fryer" ? t.airFryer : t.onePan;
const dietLabel = (diet: "vegetarian" | "vegan" | "gluten-free", t: RecipeLabels) =>
  diet === "vegetarian" ? t.vegetarian : diet === "vegan" ? t.vegan : t.glutenFree;

export function applianceLabel(id: string, t: RecipeLabels): string {
  return ({ hob: t.hob, oven: t.oven, microwave: t.microwave, "air-fryer": t.airFryer, blender: t.blender } as Record<string, string>)[id] ?? id;
}

export function issueLabel(issue: Issue, t: RecipeLabels, staple: (id: string) => string): string {
  switch (issue.code) {
    case "unknown":
      return fill(t.issueUnknown, { name: issue.ingredient });
    case "staple":
      return fill(t.issueStaple, { name: staple(issue.staple) });
    case "toBuy":
      return fill(t.issueToBuy, { n: issue.count });
    case "time":
      return fill(t.issueTime, { minutes: issue.minutes, limit: issue.limit });
    case "equipment":
      return fill(t.issueEquipment, { mode: modeLabel(issue.mode, t) });
    case "dishes":
      return fill(t.issueDishes, { n: issue.dishes });
    case "diet":
      return fill(t.issueDiet, { name: issue.ingredient, diet: dietLabel(issue.diet, t).toLowerCase() });
    case "urgent":
      return fill(t.issueUrgent, { n: issue.used });
    case "empty":
      return t.issueEmpty;
    case "late":
      return fill(t.issueLate, { name: issue.ingredient, n: issue.daysLeft });
    case "overused":
      return fill(t.issueOverused, { name: issue.ingredient });
  }
}

/** Ripe's anti-waste score, out of 100. */
export function ScoreRing({ score, label, size = 40 }: { score: number; label: string; size?: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} role="img" aria-label={`${label} ${score}/100`} className="shrink-0">
      <circle cx="20" cy="20" r={r} fill="none" stroke="var(--hairline)" strokeWidth="4" />
      <circle
        cx="20"
        cy="20"
        r={r}
        fill="none"
        stroke="var(--color-feuille)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${(c * Math.max(0, Math.min(100, score))) / 100} ${c}`}
        transform="rotate(-90 20 20)"
      />
      <text x="20" y="20" dominantBaseline="central" textAnchor="middle" fill="currentColor" className="font-mono text-[11px] font-medium">
        {score}
      </text>
    </svg>
  );
}

const ASPECT = 16 / 9;
const PAD = 0.04;

/**
 * The part of the fridge photo a recipe rescues, framed at 16:9: the union of
 * its items' boxes, padded and widened to fit inside the photo. $0, instant.
 */
export function cropFor(boxes: readonly GridBox[], width: number, height: number) {
  if (boxes.length === 0) return { x: 0, y: 0, w: 1, h: 1 };
  let x0 = Math.min(...boxes.map((b) => b.x_min)) / 1000 - PAD;
  let y0 = Math.min(...boxes.map((b) => b.y_min)) / 1000 - PAD;
  let x1 = Math.max(...boxes.map((b) => b.x_max)) / 1000 + PAD;
  let y1 = Math.max(...boxes.map((b) => b.y_max)) / 1000 + PAD;
  // Work in pixels so the aspect is right, then back to fractions.
  let cw = (x1 - x0) * width;
  let ch = (y1 - y0) * height;
  if (cw / ch < ASPECT) cw = ch * ASPECT;
  else ch = cw / ASPECT;
  if (cw > width) [cw, ch] = [width, width / ASPECT];
  if (ch > height) [cw, ch] = [height * ASPECT, height];
  const cx = ((x0 + x1) / 2) * width;
  const cy = ((y0 + y1) / 2) * height;
  x0 = Math.min(width - cw, Math.max(0, cx - cw / 2)) / width;
  y0 = Math.min(height - ch, Math.max(0, cy - ch / 2)) / height;
  x1 = cw / width;
  y1 = ch / height;
  return { x: x0, y: y0, w: x1, h: y1 };
}

export function PhotoCrop({
  photo,
  boxes,
  alt,
  className = "",
}: {
  photo: { src: string | null; width: number; height: number };
  boxes: readonly GridBox[];
  alt: string;
  className?: string;
}) {
  const crop = cropFor(boxes, photo.width, photo.height);
  return (
    <div className={`relative aspect-video overflow-hidden bg-scene ${className}`}>
      {photo.src && (
        // A plain img: next/image cannot position an oversized frame like this.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo.src}
          alt={alt}
          className="absolute max-w-none opacity-90"
          style={{
            width: `${100 / crop.w}%`,
            height: `${100 / crop.h}%`,
            left: `${(-crop.x / crop.w) * 100}%`,
            top: `${(-crop.y / crop.h) * 100}%`,
          }}
        />
      )}
    </div>
  );
}

export function recipeLabels(t: Pick<Dictionary, "recipes" | "scan" | "freshness">): RecipeLabels {
  return { ...t.recipes, scan: { daysLeft: t.scan.daysLeft, today: t.scan.today }, tiers: t.freshness };
}
