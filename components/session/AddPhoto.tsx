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
  accept = "image/jpeg,image/png,image/webp",
  compact = false,
  onFile,
}: {
  label: string;
  disabled: boolean;
  camera: boolean;
  /** Leaving HEIC out makes iOS hand over a JPEG; a video button asks for MP4 or MOV. */
  accept?: string;
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
        accept={accept}
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

/** What the gallery button takes: a photo or a clip, sorted by its type once picked. */
export const GALLERY_ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/quicktime";
export const isVideo = (file: File) => file.type.startsWith("video/");

/** One more photo for the same inventory: where it was taken, then the camera, a file or an example photo. */
export function AddPhoto({
  t,
  live,
  phone,
  demoLeft,
  disabled,
  onDemo,
  onFile,
  onReceipt,
  onVideo,
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
  /** A receipt photo: its food lines join the inventory, no outlines. */
  onReceipt: (file: File) => void;
  /** A short clip of the open fridge: SAM follows each item through it. */
  onVideo: (file: File, place: Place) => void;
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
        <PhotoButton
          label={t.filmFridge}
          camera={phone}
          compact
          accept="video/mp4,video/quicktime"
          disabled={!live || disabled}
          onFile={(file) => onVideo(file, place)}
        />
        {phone && (
          <PhotoButton
            label={t.fromGallery}
            camera={false}
            compact
            accept={GALLERY_ACCEPT}
            disabled={!live || disabled}
            onFile={(file) => (isVideo(file) ? onVideo(file, place) : onFile(file, place))}
          />
        )}
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
      <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-3">
        <p className="text-sm text-ink-soft">{t.receiptLead}</p>
        <PhotoButton label={t.receipt} camera={phone} compact disabled={!live || disabled} onFile={onReceipt} />
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

/** The ~1 KB thumbnail a phone sends before its photo: shown blurred while the upload runs. */
export function IncomingPhoto({
  photo,
  label,
  large,
}: {
  photo: { dataUrl: string; width: number; height: number };
  label: string;
  large: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-3xl bg-scene ${large ? "mx-auto h-[60vh] max-w-full" : "h-28 shrink-0 self-start"}`}
      style={{ aspectRatio: `${photo.width} / ${photo.height}` }}
      role="status"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo.dataUrl} alt="" className="absolute inset-0 size-full scale-110 object-cover blur-xl" />
      <div className="scan-beam absolute inset-0" aria-hidden="true" />
      <p className="absolute inset-x-3 bottom-3 rounded-full bg-nuit/70 px-3 py-1.5 text-center text-xs text-porcelaine backdrop-blur-md">
        {label}
      </p>
    </div>
  );
}
