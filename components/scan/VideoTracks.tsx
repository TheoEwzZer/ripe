"use client";

import { useFoodName } from "@/lib/i18n/foods";
import { useEffect, useRef, useState } from "react";
import { tierColorVar, tierFor } from "@/lib/pantry/freshness";

type Track = { ingredientId: string; boxes: number[] };

/** The box at `frame`, or null if SAM lost the item for more than a couple of frames. */
function boxAt(boxes: number[], frame: number): [number, number, number, number] | null {
  let found = -1;
  for (let i = 0; i < boxes.length; i += 5) {
    if (boxes[i] > frame) break;
    found = i;
  }
  if (found < 0 || frame - boxes[found] > 2) return null;
  return [boxes[found + 1], boxes[found + 2], boxes[found + 3], boxes[found + 4]];
}

/** The filmed fridge, played back with each item's box following it, as SAM tracked it. */
export function VideoTracks({
  video,
  tracks,
  items,
}: {
  video: { url: string; width: number; height: number; duration: number; frames: number };
  tracks: Track[];
  items: Map<string, { name: string; daysLeft: number }>;
}) {
  const tr = useFoodName();
  const player = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = player.current;
      if (el && video.duration > 0) setFrame(Math.min(video.frames - 1, Math.floor((el.currentTime / video.duration) * video.frames)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video.duration, video.frames]);

  return (
    <div className="relative overflow-hidden rounded-3xl bg-scene" style={{ aspectRatio: `${video.width} / ${video.height}` }}>
      <video ref={player} src={video.url} className="absolute inset-0 size-full" autoPlay muted loop playsInline controls />
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
        {tracks.map((track) => {
          const box = boxAt(track.boxes, frame);
          const item = items.get(track.ingredientId);
          if (!box || !item) return null;
          const color = tierColorVar[tierFor(item.daysLeft)];
          return (
            <rect
              key={track.ingredientId}
              x={box[0]}
              y={box[1]}
              width={box[2] - box[0]}
              height={box[3] - box[1]}
              rx={8}
              fill="none"
              stroke={color}
              strokeWidth={4}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      {tracks.map((track) => {
        const box = boxAt(track.boxes, frame);
        const item = items.get(track.ingredientId);
        if (!box || !item) return null;
        return (
          <span
            key={track.ingredientId}
            className="pointer-events-none absolute -translate-y-full rounded-full bg-nuit/75 px-2 py-0.5 text-xs whitespace-nowrap text-porcelaine backdrop-blur-md"
            style={{ left: `${box[0] / 10}%`, top: `${box[1] / 10}%` }}
          >
            {tr(item.name)}
          </span>
        );
      })}
    </div>
  );
}
