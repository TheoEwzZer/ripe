"use client";

import { useRef, useState } from "react";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

export type Place = "fridge" | "pantry" | "freezer";
export const places: readonly Place[] = ["fridge", "pantry", "freezer"];

export const placeLabel = (place: Place, t: Dictionary["session"]) =>
  place === "fridge" ? t.placeFridge : place === "pantry" ? t.placePantry : t.placeFreezer;

/** A file input styled as a button; on a phone it opens the camera straight away. */
export function PhotoButton({
  label,
  disabled,
  camera,
  primary = false,
  compact = false,
  onFile,
}: {
  label: string;
  disabled: boolean;
  camera: boolean;
  primary?: boolean;
  compact?: boolean;
  onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <label
      className={`rounded-full font-medium transition-[transform,opacity,background-color] duration-150 ${compact ? "px-4 py-2 text-sm" : "px-6 py-3"} ${
        primary ? "bg-aubergine text-porcelaine dark:bg-porcelaine dark:text-aubergine" : "ring-1 ring-hairline"
      } ${disabled ? "cursor-not-allowed opacity-50" : `cursor-pointer active:scale-[0.98] ${primary ? "hover:opacity-90" : "hover:bg-glass"}`}`}
    >
      {label}
      <input
        ref={input}
        type="file"
        // Leaving HEIC out makes iOS hand over a JPEG.
        accept="image/jpeg,image/png,image/webp"
        capture={camera ? "environment" : undefined}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (input.current) input.current.value = "";
          if (file) onFile(file);
        }}
      />
    </label>
  );
}

/** One more photo for the same inventory: where it was taken, then the camera, a file or an example photo. */
export function AddPhoto({
  t,
  live,
  phone,
  demoLeft,
  disabled,
  onDemo,
  onFile,
  onClose,
}: {
  t: Dictionary["session"];
  live: boolean;
  phone: boolean;
  demoLeft: boolean;
  disabled: boolean;
  /** The example photos are fridges, whatever place is picked. */
  onDemo: () => void;
  onFile: (file: File, place: Place) => void;
  onClose: () => void;
}) {
  const [place, setPlace] = useState<Place>("pantry");
  return (
    <div className="glass flex flex-col gap-4 rounded-3xl p-4" role="group" aria-label={t.addPhoto}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-medium">{t.addWhere}</p>
        <button type="button" onClick={onClose} className="text-sm font-medium underline-offset-4 hover:underline">
          {t.cancel}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {places.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={place === p}
            onClick={() => setPlace(p)}
            className={`rounded-full px-3 py-1.5 text-sm transition-colors duration-150 ${
              place === p ? "bg-aubergine text-porcelaine dark:bg-porcelaine dark:text-aubergine" : "ring-1 ring-hairline hover:bg-glass"
            }`}
          >
            {placeLabel(p, t)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <PhotoButton
          label={phone ? t.takePhoto : t.choosePhoto}
          camera={phone}
          primary
          compact
          disabled={!live || disabled}
          onFile={(file) => onFile(file, place)}
        />
        {demoLeft && (
          <button
            type="button"
            disabled={disabled}
            onClick={onDemo}
            className="rounded-full px-4 py-2 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass disabled:opacity-50"
          >
            {t.examplePhoto}
          </button>
        )}
      </div>
      {!live && <p className="text-xs text-ink-soft">{t.liveOff}</p>}
    </div>
  );
}

/** The session's photos side by side; the inventory below gathers them all. */
export function PhotoStrip({
  scans,
  shown,
  counts,
  labels,
  t,
  onShow,
}: {
  scans: { _id: string; imageUrl: string | null; place: Place; status: string }[];
  shown: string;
  counts: Map<string, number>;
  labels: Map<string, string>;
  t: Dictionary["session"];
  onShow: (scanId: string) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t.photos}>
      {scans.map((scan) => (
        <button
          key={scan._id}
          type="button"
          role="tab"
          aria-selected={scan._id === shown}
          onClick={() => onShow(scan._id)}
          className={`flex shrink-0 items-center gap-2 rounded-2xl p-1 pr-3 text-left transition-colors ${
            scan._id === shown ? "bg-surface ring-2 ring-ink/70" : "ring-1 ring-hairline hover:bg-glass"
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {scan.imageUrl && <img src={scan.imageUrl} alt="" className="size-10 rounded-xl object-cover" />}
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-medium">{labels.get(scan._id) ?? placeLabel(scan.place, t)}</span>
            <span className="font-mono text-xs text-ink-soft">
              {scan.status === "perceiving" || scan.status === "segmenting" ? "···" : (counts.get(scan._id) ?? 0)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
