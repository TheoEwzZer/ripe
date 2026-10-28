"use client";

import { MotionConfig, motion } from "motion/react";
import Image from "next/image";
import { memo, useEffect, useRef, useState, type MouseEvent } from "react";
import { maskToPath } from "@/lib/masks/contour";
import { tierColorVar, tierFor } from "@/lib/pantry/freshness";
import { gridToPixels, union, type GridBox, type PixelBox } from "@/lib/pipeline/geometry";
import { toSegmentationMask } from "@/lib/pipeline/sam";
import { Pip, dayLabel } from "./Pip";

export type Segmentation = "pending" | "concept" | "box" | "point" | "none";

export type CanvasIngredient = {
  key: string;
  name: string;
  daysLeft: number;
  bbox: GridBox;
  segmentation: Segmentation;
  removed?: boolean;
};

export type CanvasMask = {
  key: string;
  ingredientKey: string;
  encoding: "lossless" | "one_bit";
  payload: string;
  width: number;
  height: number;
  bounds: PixelBox;
};

type Labels = { daysLeft: string; today: string; identifying: string; unknown: string };

/** A tapped item has no name until Muse Spark has looked at it. */
export function displayName(item: Pick<CanvasIngredient, "name" | "segmentation">, labels: Pick<Labels, "identifying" | "unknown">) {
  if (item.name) return item.name;
  return item.segmentation === "pending" || item.segmentation === "point" ? labels.identifying : labels.unknown;
}

/** Decoding is the expensive part; a mask never changes once stored, so its path is cached by key. */
const pathCache = new Map<string, string>();
function pathFor(mask: CanvasMask): string {
  let d = pathCache.get(mask.key);
  if (d === undefined) {
    try {
      d = maskToPath(toSegmentationMask(mask));
    } catch {
      d = "";
    }
    if (pathCache.size > 600) pathCache.clear();
    pathCache.set(mask.key, d);
  }
  return d;
}

const areaOf = (b: PixelBox) => (b.right - b.left) * (b.bottom - b.top);

/** Label chips, in screen pixels: text-xs with a pip and a day count. */
const CHIP_H = 26;
const chipWidth = (name: string) => Math.min(200, 56 + name.length * 6.6);
type Rect = { l: number; t: number; r: number; b: number };
const overlaps = (a: Rect, b: Rect, gap = 4) => a.l < b.r + gap && b.l < a.r + gap && a.t < b.b + gap && b.t < a.b + gap;

type ShapeProps = {
  color: string;
  dimmed: boolean;
  selected: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onSelect: () => void;
};

const MaskShape = memo(function MaskShape({ mask, color, dimmed, selected, onEnter, onLeave, onSelect }: ShapeProps & { mask: CanvasMask }) {
  const d = pathFor(mask);
  if (!d) return null;
  return (
    <g transform={`translate(${mask.bounds.left} ${mask.bounds.top})`}>
      <motion.path
        d={d}
        fillRule="evenodd"
        fill={color}
        stroke={selected ? "var(--color-porcelaine)" : color}
        strokeWidth={selected ? 3.5 : 2.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: dimmed ? 0.14 : 1, scale: 1 }}
        transition={{ type: "spring", duration: 0.38, bounce: 0.3 }}
        style={{ transformBox: "fill-box", transformOrigin: "center", fillOpacity: 0.34, cursor: "pointer" }}
        data-shape=""
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onClick={onSelect}
      />
    </g>
  );
});

/** Muse Spark's box, shown while SAM works (dashed) or when no outline came back (solid). */
function BoxShape({ box, pending, color, dimmed, selected, onEnter, onLeave, onSelect }: ShapeProps & { box: PixelBox; pending: boolean }) {
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  return (
    <motion.rect
      x={box.left}
      y={box.top}
      width={w}
      height={h}
      rx={Math.min(w, h) * 0.14}
      fill={color}
      fillOpacity={pending ? 0.05 : 0.14}
      stroke={selected ? "var(--color-porcelaine)" : color}
      strokeWidth={selected ? 3 : 2}
      strokeDasharray={pending ? "7 6" : undefined}
      vectorEffect="non-scaling-stroke"
      className={pending ? "ghost-pulse" : undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: dimmed ? 0.14 : 1 }}
      transition={{ duration: 0.25 }}
      style={{ cursor: "pointer" }}
      data-shape=""
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onClick={onSelect}
    />
  );
}

export function ScanCanvas({
  image,
  ingredients,
  masks,
  scanning,
  active: activeProp,
  onActive,
  labels,
  maxLabels = 4,
  onTap,
  selected: selectedProp = null,
  onSelect,
}: {
  image: { src: string | null; width: number; height: number };
  ingredients: CanvasIngredient[];
  masks: CanvasMask[];
  scanning: boolean;
  active: string | null;
  onActive: (key: string | null) => void;
  labels: Labels;
  maxLabels?: number;
  /** Tapping an empty spot reports it in image pixels (tap to add a missed item). */
  onTap?: (point: { x: number; y: number }) => void;
  /** The item open for editing; clicking a shape selects it, clicking empty photo deselects first. */
  selected?: string | null;
  onSelect?: (key: string | null) => void;
}) {
  const { width: W, height: H } = image;
  const [ripples, setRipples] = useState<{ id: number; left: number; top: number }[]>([]);

  const handleTap = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest("[data-shape]")) return;
    // With an item open, a click on the photo only closes it: adding costs an API call.
    if (onSelect && selectedProp !== null) {
      onSelect(null);
      return;
    }
    if (!onTap) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.height;
    if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return;
    const id = Date.now();
    setRipples((r) => [...r, { id, left: fx * 100, top: fy * 100 }]);
    setTimeout(() => setRipples((r) => r.filter((p) => p.id !== id)), 900);
    onTap({ x: Math.min(W - 1, Math.floor(fx * W)), y: Math.min(H - 1, Math.floor(fy * H)) });
  };
  // Labels are laid out in screen pixels, so the canvas tracks its rendered width.
  const figureRef = useRef<HTMLElement>(null);
  const [shownW, setShownW] = useState(640);
  useEffect(() => {
    const figure = figureRef.current;
    if (!figure) return;
    const observer = new ResizeObserver(([entry]) => setShownW(entry.contentRect.width));
    observer.observe(figure);
    return () => observer.disconnect();
  }, []);
  const scale = shownW / W;
  const shownH = H * scale;

  const visible = ingredients.filter((i) => !i.removed);
  const byKey = new Map(visible.map((i) => [i.key, i]));
  // A key left over from a previous scan must not dim the whole photo.
  const hovered = activeProp !== null && byKey.has(activeProp) ? activeProp : null;
  const selected = selectedProp !== null && byKey.has(selectedProp) ? selectedProp : null;
  const active = hovered ?? selected;
  const masksOf = new Map<string, CanvasMask[]>();
  for (const m of masks) if (byKey.has(m.ingredientKey)) masksOf.set(m.ingredientKey, [...(masksOf.get(m.ingredientKey) ?? []), m]);

  const colorOf = (item: CanvasIngredient) => tierColorVar[tierFor(item.daysLeft)];
  const handlers = (key: string) => ({
    onEnter: () => onActive(key),
    onLeave: () => onActive(null),
    onSelect: () => (onSelect ? onSelect(selected === key ? null : key) : onActive(active === key ? null : key)),
  });

  // Where each item sits: the union of its masks, else Muse Spark's box.
  const frames = visible.map((item) => ({
    item,
    box: union((masksOf.get(item.key) ?? []).map((m) => m.bounds)) ?? gridToPixels(item.bbox, image),
  }));

  // Floating labels: the active item plus the most urgent ones, above their outline (inside it at
  // the top edge), skipping any chip that would overlap one already placed.
  const placed: Rect[] = [];
  const labelled = [...frames]
    .sort((a, b) => Number(b.item.key === active) - Number(a.item.key === active) || a.item.daysLeft - b.item.daysLeft)
    .flatMap(({ item, box }) => {
      const isActive = item.key === active;
      if (!isActive && placed.length >= maxLabels + (active ? 1 : 0)) return [];
      const w = chipWidth(displayName(item, labels));
      const cx = Math.min(shownW - w / 2 - 6, Math.max(w / 2 + 6, ((box.left + box.right) / 2) * scale));
      const top = box.top * scale;
      const y = top < CHIP_H + 8 ? top + 6 : top - CHIP_H - 6;
      const rect = { l: cx - w / 2, r: cx + w / 2, t: y, b: y + CHIP_H };
      if (!isActive && placed.some((p) => overlaps(p, rect))) return [];
      placed.push(rect);
      return [{ item, left: (cx / shownW) * 100, top: (y / shownH) * 100 }];
    });

  const shapes = [...frames].sort((a, b) => areaOf(b.box) - areaOf(a.box));

  return (
    <MotionConfig reducedMotion="user">
      <figure
        ref={figureRef}
        className={`relative mx-auto overflow-hidden rounded-3xl bg-scene select-none ${onTap ? "cursor-crosshair" : ""}`}
        style={{ aspectRatio: `${W} / ${H}`, width: `min(100%, calc(70svh * ${W / H}))` }}
        // A box swapped for its mask under the cursor never gets pointerleave; the figure always does.
        onPointerLeave={() => onActive(null)}
        onClick={handleTap}
      >
        {image.src && (
          <Image
            src={image.src}
            alt=""
            fill
            sizes="(min-width: 1024px) 66vw, 100vw"
            unoptimized={!image.src.startsWith("/")}
            className="object-cover opacity-85"
            priority
          />
        )}
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full" preserveAspectRatio="none">
          {shapes.map(({ item, box }) => {
            const color = colorOf(item);
            const dimmed = active !== null && active !== item.key;
            const own = masksOf.get(item.key);
            if (own?.length) {
              return (
                <g key={item.key}>
                  {[...own]
                    .sort((a, b) => areaOf(b.bounds) - areaOf(a.bounds))
                    .map((mask) => (
                      <MaskShape key={mask.key} mask={mask} color={color} dimmed={dimmed} selected={item.key === selected} {...handlers(item.key)} />
                    ))}
                </g>
              );
            }
            return (
              <BoxShape
                key={item.key}
                box={box}
                pending={item.segmentation === "pending"}
                color={color}
                dimmed={dimmed}
                selected={item.key === selected}
                {...handlers(item.key)}
              />
            );
          })}
        </svg>

        {labelled.map(({ item, left, top }) => {
          return (
            <div
              key={item.key}
              className={`pointer-events-none absolute flex h-[26px] -translate-x-1/2 items-center whitespace-nowrap gap-1.5 rounded-full bg-nuit/75 px-2.5 text-xs text-porcelaine shadow-lg backdrop-blur-md transition-opacity duration-200 ${
                active && active !== item.key ? "opacity-40" : "opacity-100"
              }`}
              style={{ left: `${left}%`, top: `${top}%` }}
            >
              <Pip daysLeft={item.daysLeft} className="size-3" />
              <span className="max-w-32 truncate font-medium">{displayName(item, labels)}</span>
              <span className="font-mono text-[11px] text-porcelaine/75">{dayLabel(item.daysLeft, labels)}</span>
            </div>
          );
        })}

        {ripples.map((r) => (
          <span key={r.id} className="tap-ripple pointer-events-none absolute" style={{ left: `${r.left}%`, top: `${r.top}%` }} aria-hidden="true" />
        ))}

        {scanning && <div className="scan-beam pointer-events-none absolute inset-0 motion-reduce:hidden" aria-hidden="true" />}
      </figure>
    </MotionConfig>
  );
}
