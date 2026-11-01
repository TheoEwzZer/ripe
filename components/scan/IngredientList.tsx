"use client";

import { useRef, type KeyboardEvent } from "react";
import { displayName, type CanvasIngredient } from "./ScanCanvas";
import { Pip, dayLabel } from "./Pip";

type Labels = { daysLeft: string; today: string; pending: string; approximate: string; identifying: string; unknown: string };

/**
 * The inventory ranked by urgency. Hovering an item lights it up on the photo;
 * with `onSelect`, it is also a keyboard list: arrows move, Enter opens the
 * item, Delete removes it.
 */
export function IngredientList({
  ingredients,
  active,
  onActive,
  labels,
  selected = null,
  onSelect,
  onRemove,
}: {
  ingredients: CanvasIngredient[];
  active: string | null;
  onActive: (key: string | null) => void;
  labels: Labels;
  selected?: string | null;
  onSelect?: (key: string) => void;
  onRemove?: (key: string) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const ranked = ingredients.filter((i) => !i.removed).sort((a, b) => a.daysLeft - b.daysLeft);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button[data-key]") ?? [])];
    const at = buttons.findIndex((b) => b.dataset.key === key);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    } else if ((event.key === "Delete" || event.key === "Backspace") && onRemove) {
      event.preventDefault();
      // Keep the keyboard in the list: focus the next item before this one disappears.
      (buttons[at + 1] ?? buttons[at - 1])?.focus();
      onRemove(key);
    }
  };

  return (
    <ol ref={list} className="flex flex-col">
      {ranked.map((item) => (
        <li key={item.key}>
          <button
            type="button"
            data-key={item.key}
            onClick={() => onSelect?.(item.key)}
            onKeyDown={(e) => onKeyDown(e, item.key)}
            onPointerEnter={() => onActive(item.key)}
            onPointerLeave={() => onActive(null)}
            onFocus={() => onActive(item.key)}
            onBlur={() => onActive(null)}
            aria-current={selected === item.key ? "true" : undefined}
            className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-glass ${
              active === item.key ? "bg-glass" : ""
            } ${selected === item.key ? "ring-2 ring-ink/70" : ""}`}
          >
            <Pip daysLeft={item.daysLeft} />
            <span className="min-w-0 flex-1 truncate">{displayName(item, labels)}</span>
            {item.tag && <span className="shrink-0 rounded-full px-1.5 text-[11px] text-ink-soft ring-1 ring-hairline">{item.tag}</span>}
            {(item.segmentation === "pending" || (item.segmentation === "point" && !item.name)) && (
              <span className="flex items-center">
                <span className="ghost-pulse flex gap-0.5" aria-hidden="true">
                  {[0, 1, 2].map((dot) => (
                    <span key={dot} className="size-1 rounded-full bg-ink-soft" />
                  ))}
                </span>
                <span className="sr-only">{labels.pending}</span>
              </span>
            )}
            {item.segmentation === "none" && !item.offPhoto && (
              <span className="text-xs text-ink-soft" title={labels.approximate}>
                <span aria-hidden="true">≈</span>
                <span className="sr-only">{labels.approximate}</span>
              </span>
            )}
            <span className="font-mono text-xs text-ink-soft">{dayLabel(item.daysLeft, labels)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
