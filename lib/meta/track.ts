import { metaBaseUrl } from "./client";
import { MODELS } from "./models";

/** SAM video: $0.20 per 1,000 frames, at least 50 frames a request (dev.meta.ai/docs/pricing-rate-limits). */
export const SAM_USD_PER_FRAME = 0.2 / 1000;
export const MIN_BILLED_FRAMES = 50;
/** SAM tracks at most 16 prompted objects. */
export const MAX_TRACKED = 16;

/** A box drawn on one frame of the clip (0 unless the item first shows up later). */
export type TrackPrompt = { id: number; box: { x1: number; y1: number; x2: number; y2: number }; frame?: number };
/** Per object id: [frame, x1, y1, x2, y2] in source pixels, frame order. */
export type Tracks = Map<number, [number, number, number, number, number][]>;

/** Box prompts, each on its own frame, in the token grammar SAM reads and writes. */
export function trackPrompt(objects: readonly TrackPrompt[], size: { w: number; h: number }): string {
  // Corners are inclusive pixels: the last column is w - 1, and SAM refuses anything past it.
  const clamp = (n: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(n)));
  return objects
    .slice(0, MAX_TRACKED)
    .map(({ id, box, frame = 0 }) => ({
      id,
      frame: Math.max(0, Math.round(frame)),
      x1: clamp(box.x1, size.w),
      y1: clamp(box.y1, size.h),
      x2: clamp(box.x2, size.w),
      y2: clamp(box.y2, size.h),
    }))
    .filter((b) => b.x2 > b.x1 && b.y2 > b.y1)
    .map(({ id, frame, x1, y1, x2, y2 }) => `<${frame}f>${id}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${size.w};h=${size.h}|>`)
    .join("");
}

/**
 * Reads SAM's video answer: one line per frame, `<Nf>` then `id<|box;…|><|mask;…|>`
 * entries separated by commas. Only the boxes are kept: they are what the
 * player draws, and they stay small.
 */
export function parseTracks(text: string): { tracks: Tracks; frames: number; size: { w: number; h: number } | null } {
  const tracks: Tracks = new Map();
  let frames = 0;
  let size: { w: number; h: number } | null = null;
  const marker = /<(\d+)f>/g;
  const starts = [...text.matchAll(marker)];
  starts.forEach((m, i) => {
    const frame = Number(m[1]);
    frames = Math.max(frames, frame + 1);
    const body = text.slice(m.index! + m[0].length, i + 1 < starts.length ? starts[i + 1].index : text.length);
    for (const e of body.matchAll(/(?:^|,)(\d+)<\|box;x1=(-?\d+);y1=(-?\d+);x2=(-?\d+);y2=(-?\d+);w=(\d+);h=(\d+)/g)) {
      const id = Number(e[1]);
      size ??= { w: Number(e[6]), h: Number(e[7]) };
      const list = tracks.get(id) ?? [];
      list.push([frame, Number(e[2]), Number(e[3]), Number(e[4]), Number(e[5])]);
      tracks.set(id, list);
    }
  });
  for (const list of tracks.values()) list.sort((a, b) => a[0] - b[0]);
  return { tracks, frames, size };
}

/** Uploads a clip to Meta's file store (it remuxes MP4s whose index sits at the end); returns its file id. */
export async function uploadVideo(video: Blob, filename: string): Promise<string> {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("MODEL_API_KEY is not set.");
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", video, filename);
  const res = await fetch(`${metaBaseUrl()}/files`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  if (!res.ok) throw new Error(`Meta files ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { id: string }).id;
}

/** SAM 3.1 follows each prompted object through the video (Responses API, `input_video`). */
export async function trackVideo(
  video: { fileId: string } | { url: string },
  objects: readonly TrackPrompt[],
  size: { w: number; h: number },
) {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("MODEL_API_KEY is not set.");
  const started = Date.now();
  const res = await fetch(`${metaBaseUrl()}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODELS.segment,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: trackPrompt(objects, size) },
            "fileId" in video ? { type: "input_video", file_id: video.fileId } : { type: "input_video", video_url: video.url },
          ],
        },
      ],
      // Items first seen later in the clip are followed back to the start as well.
      metadata: { propagation_direction: objects.some((o) => (o.frame ?? 0) > 0) ? "both" : "forward", mask_encoding: "one_bit" },
    }),
  });
  if (!res.ok) throw new Error(`SAM video ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as {
    output_text?: string;
    output?: { content?: { type?: string; text?: string }[] }[];
    usage?: { video_frames_processed?: number };
  };
  const text =
    body.output_text ??
    (body.output ?? [])
      .flatMap((o) => o.content ?? [])
      .map((c) => c.text ?? "")
      .join("\n");
  const parsed = parseTracks(text);
  const billed = Math.max(MIN_BILLED_FRAMES, body.usage?.video_frames_processed ?? parsed.frames);
  return { ...parsed, ms: Date.now() - started, costUsd: billed * SAM_USD_PER_FRAME, rawText: text };
}
