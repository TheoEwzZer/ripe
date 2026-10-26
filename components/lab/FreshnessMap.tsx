"use client";

import { decodeMaskToSVGPath, recordsOfKind } from "@meta-sam/parser";
import { MotionConfig, motion } from "motion/react";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { pipFill, tierColorVar, tierFor } from "@/lib/pantry/freshness";
import {
  replayPerception,
  replaySegment,
  type Recording,
} from "@/lib/replay/recording";

type Labels = {
  daysLeft: string;
  today: string;
  confidence: string;
  priority: string;
  items: string;
};

type Outline = {
  key: string;
  ingredientIndex: number;
  d: string;
  left: number;
  top: number;
  confidence?: number;
};

function Pip({ daysLeft }: { daysLeft: number }) {
  const fill = pipFill(daysLeft);
  const color = tierColorVar[tierFor(daysLeft)];
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6.5"
        fill="none"
        stroke={color}
        strokeWidth="1.5"
      />
      {fill >= 1 ? (
        <circle cx="8" cy="8" r="5" fill={color} />
      ) : (
        <path
          fill={color}
          d={`M8 8V3A5 5 0 ${fill > 0.5 ? 1 : 0} 1 ${8 + 5 * Math.sin(2 * Math.PI * fill)} ${8 - 5 * Math.cos(2 * Math.PI * fill)}Z`}
        />
      )}
    </svg>
  );
}

export function FreshnessMap({
  recording,
  labels,
}: {
  recording: Recording;
  labels: Labels;
}) {
  const perception = useMemo(() => replayPerception(recording), [recording]);
  const [outlines, setOutlines] = useState<Outline[]>([]);
  const [scanning, setScanning] = useState(true);
  const [active, setActive] = useState<number | null>(null);
  const { width: W, height: H } = recording.image;

  useEffect(() => {
    let cancelled = false;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    // Replays in the recorded latency order so masks appear the way they will live.
    const ordered = [...recording.segments].sort((a, b) => a.ms - b.ms);
    Promise.all(
      ordered.map(async (segment, n) => {
        const result = await replaySegment(segment.rawText);
        await new Promise((r) =>
          setTimeout(r, reduceMotion ? 0 : 500 + n * 140),
        );
        if (cancelled) return;
        const next = recordsOfKind(result.records, "mask").map((m) => ({
          key: `${segment.ingredientIndex}-${m.objectId}`,
          ingredientIndex: segment.ingredientIndex,
          d: decodeMaskToSVGPath(m.mask),
          left: m.bounds.left,
          top: m.bounds.top,
          confidence: m.confidence,
        }));
        setOutlines((prev) => [...prev, ...next]);
      }),
    ).then(() => !cancelled && setScanning(false));
    return () => {
      cancelled = true;
      setOutlines([]);
      setScanning(true);
    };
  }, [recording]);

  const ranked = perception.ingredients
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.daysLeft - b.item.daysLeft);
  const dayLabel = (n: number) =>
    n <= 0 ? labels.today : labels.daysLeft.replace("{n}", String(n));

  return (
    <MotionConfig reducedMotion="user">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <figure
          className="relative overflow-hidden rounded-3xl bg-scene"
          style={{ aspectRatio: `${W} / ${H}` }}
        >
          <Image
            src={recording.image.src}
            alt=""
            fill
            sizes="(min-width: 1024px) 70vw, 100vw"
            className="object-cover opacity-80"
            priority
          />
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="absolute inset-0 size-full"
            preserveAspectRatio="none"
          >
            {outlines.map((o) => {
              const item = perception.ingredients[o.ingredientIndex];
              const color = tierColorVar[tierFor(item.daysLeft)];
              const dim = active !== null && active !== o.ingredientIndex;
              return (
                // Motion owns the path's CSS transform, so the mask offset lives on a wrapping <g>.
                <g key={o.key} transform={`translate(${o.left} ${o.top})`}>
                  <motion.path
                    d={o.d}
                    fill={color}
                    stroke={color}
                    strokeWidth={4}
                    initial={{ opacity: 0, scale: 0.94 }}
                    animate={{ opacity: dim ? 0.12 : 1, scale: 1 }}
                    transition={{
                      type: "spring",
                      duration: 0.38,
                      bounce: 0.25,
                    }}
                    style={{
                      transformBox: "fill-box",
                      transformOrigin: "center",
                      fillOpacity: 0.38,
                    }}
                    onPointerEnter={() => setActive(o.ingredientIndex)}
                    onPointerLeave={() => setActive(null)}
                  />
                </g>
              );
            })}
          </svg>
          {scanning && (
            <div
              className="scan-beam pointer-events-none absolute inset-0 motion-reduce:hidden"
              aria-hidden="true"
            />
          )}
          <figcaption className="sr-only">
            {perception.ingredients.length} {labels.items}
          </figcaption>
        </figure>

        <aside className="glass rounded-3xl p-4">
          <p className="px-2 pb-3 text-sm text-ink-soft">{labels.priority}</p>
          <ol className="flex flex-col">
            {ranked.map(({ item, index }) => (
              <li key={index}>
                <button
                  type="button"
                  onPointerEnter={() => setActive(index)}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-glass"
                >
                  <Pip daysLeft={item.daysLeft} />
                  <span className="flex-1 truncate">{item.name}</span>
                  <span className="font-mono text-xs text-ink-soft">
                    {dayLabel(item.daysLeft)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </MotionConfig>
  );
}
