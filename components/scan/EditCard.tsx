"use client";

import { useEffect, useRef, useState } from "react";
import { tierFor, type RipenessTier } from "@/lib/pantry/freshness";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import { Pip, dayLabel } from "./Pip";
import { displayName } from "./ScanCanvas";

export type EditableItem = {
  key: string;
  name: string;
  daysLeft: number;
  quantity: string;
  freshnessCues: string;
  dateRead: string | null;
  segmentation: "pending" | "concept" | "box" | "point" | "none";
};

type Labels = Dictionary["scan"] & { tiers: Record<RipenessTier, string> };

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** Wait this long after the slider stops before saving, so a drag is one write. */
const SAVE_DELAY_MS = 250;

/**
 * Correct what the AI got wrong about one item. Mount it with `key={item.key}`
 * so drafts reset when another item is selected.
 */
export function EditCard({
  item,
  duplicateCount,
  labels,
  onRename,
  onDays,
  onRemove,
  onMerge,
  onClose,
  children,
}: {
  item: EditableItem;
  duplicateCount: number;
  labels: Labels;
  onRename: (name: string) => void;
  onDays: (daysLeft: number) => void;
  onRemove: () => void;
  onMerge: () => void;
  onClose: () => void;
  /** Extra tools for this item, such as reading its printed date. */
  children?: React.ReactNode;
}) {
  const [draftName, setDraftName] = useState<string | null>(null);
  const [draftDays, setDraftDays] = useState<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const days = draftDays ?? item.daysLeft;
  const naming = item.segmentation === "pending" || (item.segmentation === "point" && !item.name);
  const daysText = days <= 0 ? labels.todayLower : days === 1 ? labels.dayOne : fill(labels.dayCount, { n: days });

  const commitName = () => {
    if (draftName === null) return;
    const clean = draftName.trim();
    if (clean && clean !== item.name) onRename(clean);
    setDraftName(null);
  };

  const changeDays = (value: number) => {
    setDraftDays(value);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onDays(value);
      setDraftDays(null);
    }, SAVE_DELAY_MS);
  };

  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-surface p-4 ring-1 ring-hairline" aria-label={displayName(item, labels)}>
      <div className="flex items-start gap-3">
        <Pip daysLeft={days} className="mt-1.5 size-5" />
        <div className="min-w-0 flex-1">
          <label htmlFor={`name-${item.key}`} className="sr-only">
            {labels.nameLabel}
          </label>
          <input
            id={`name-${item.key}`}
            value={draftName ?? (naming ? "" : item.name)}
            placeholder={naming ? labels.identifying : undefined}
            disabled={naming}
            maxLength={60}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setDraftName(null);
                e.currentTarget.blur();
              }
            }}
            className="w-full rounded-md bg-transparent font-display text-xl font-semibold tracking-tight outline-none placeholder:text-ink-soft focus-visible:ring-2 focus-visible:ring-kaki"
          />
          <p className="text-sm text-ink-soft">
            {labels.tiers[tierFor(days)]}, <span className="font-mono text-xs">{dayLabel(days, labels)}</span>
          </p>
        </div>
        <button type="button" onClick={onClose} className="-mr-1 rounded-full px-3 py-1 text-sm text-ink-soft transition-colors hover:bg-glass hover:text-ink">
          {labels.close}
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`days-${item.key}`} className="flex justify-between gap-2 text-sm text-ink-soft">
          <span>{labels.freshnessSlider}</span>
          <span className="text-ink">{daysText}</span>
        </label>
        <input
          id={`days-${item.key}`}
          type="range"
          min={0}
          max={Math.max(14, item.daysLeft)}
          step={1}
          value={days}
          onChange={(e) => changeDays(Number(e.target.value))}
          className="fresh-range"
        />
      </div>

      {(item.quantity || item.freshnessCues || item.dateRead) && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {item.quantity && (
            <>
              <dt className="text-ink-soft">{labels.quantity}</dt>
              <dd>{item.quantity}</dd>
            </>
          )}
          {item.freshnessCues && (
            <>
              <dt className="text-ink-soft">{labels.cue}</dt>
              <dd>{item.freshnessCues}</dd>
            </>
          )}
          {item.dateRead && (
            <>
              <dt className="text-ink-soft">{labels.dateRead}</dt>
              <dd>{item.dateRead}</dd>
            </>
          )}
        </dl>
      )}

      {children}

      <div className="flex flex-wrap gap-2">
        {duplicateCount > 0 && (
          <button
            type="button"
            onClick={onMerge}
            className="rounded-full bg-aubergine px-4 py-2 text-sm font-medium text-porcelaine transition-opacity hover:opacity-90 dark:bg-porcelaine dark:text-aubergine"
          >
            {duplicateCount === 1 ? labels.mergeOne : fill(labels.merge, { n: duplicateCount })}
          </button>
        )}
        <button type="button" onClick={onRemove} className="rounded-full px-4 py-2 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass">
          {labels.remove}
        </button>
      </div>
    </section>
  );
}
