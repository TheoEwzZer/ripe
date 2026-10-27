"use client";

import { displayName, type CanvasIngredient } from "./ScanCanvas";
import { Pip, dayLabel } from "./Pip";

type Labels = { daysLeft: string; today: string; pending: string; approximate: string; identifying: string; unknown: string };

/** The inventory ranked by urgency; hovering an item lights it up on the photo. */
export function IngredientList({
  ingredients,
  active,
  onActive,
  labels,
}: {
  ingredients: CanvasIngredient[];
  active: string | null;
  onActive: (key: string | null) => void;
  labels: Labels;
}) {
  const ranked = ingredients.filter((i) => !i.removed).sort((a, b) => a.daysLeft - b.daysLeft);

  return (
    <ol className="flex flex-col">
      {ranked.map((item) => (
        <li key={item.key}>
          <button
            type="button"
            onPointerEnter={() => onActive(item.key)}
            onPointerLeave={() => onActive(null)}
            onFocus={() => onActive(item.key)}
            onBlur={() => onActive(null)}
            aria-pressed={active === item.key}
            className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-glass aria-pressed:bg-glass"
          >
            <Pip daysLeft={item.daysLeft} />
            <span className="min-w-0 flex-1 truncate">{displayName(item, labels)}</span>
            {(item.segmentation === "pending" || (item.segmentation === "point" && !item.name)) && (
              <span className="ghost-pulse text-xs text-ink-soft" aria-label={labels.pending}>
                ···
              </span>
            )}
            {item.segmentation === "none" && (
              <span className="text-xs text-ink-soft" title={labels.approximate} aria-label={labels.approximate}>
                ≈
              </span>
            )}
            <span className="font-mono text-xs text-ink-soft">{dayLabel(item.daysLeft, labels)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
