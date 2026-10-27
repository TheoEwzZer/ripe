import {
  parseImageStream,
  recordsOfKind,
  type ImageSegmentationResult,
  type ResponsesEvent,
  type SegmentationMask,
} from "@meta-sam/parser";
import type { PixelBox } from "./geometry";

/** One SAM instance as stored and shipped to clients: the wire payload, never a decoded raster. */
export type MaskData = {
  objectId: string;
  encoding: SegmentationMask["encoding"];
  payload: string;
  width: number;
  height: number;
  bounds: PixelBox;
  confidence?: number;
};

/** Parses complete SAM output text through the official parser, split into deltas like a live stream. */
export async function parseSamText(rawText: string, chunkSize = 1024): Promise<ImageSegmentationResult> {
  async function* events(): AsyncIterable<ResponsesEvent> {
    const lane = { item_id: "sam", output_index: 0, content_index: 0 };
    for (let i = 0; i < rawText.length; i += chunkSize) {
      yield { type: "response.output_text.delta", delta: rawText.slice(i, i + chunkSize), ...lane };
    }
    yield { type: "response.output_text.done", text: rawText, ...lane };
    yield { type: "response.completed" };
  }
  return parseImageStream(events()).finalResult;
}

/** Latest mask per object id (an image never revises a mask, but the parser allows it). */
export function masksOf(result: ImageSegmentationResult): MaskData[] {
  const latest = new Map<string, MaskData>();
  for (const record of recordsOfKind(result.records, "mask")) {
    latest.set(record.objectId, {
      objectId: record.objectId,
      encoding: record.mask.encoding,
      payload: record.mask.payload,
      width: record.mask.width,
      height: record.mask.height,
      bounds: { ...record.bounds },
      ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
    });
  }
  return [...latest.values()];
}

/** The `SegmentationMask` shape the decoders expect. */
export function toSegmentationMask(mask: Pick<MaskData, "encoding" | "payload" | "width" | "height">): SegmentationMask {
  return { encoding: mask.encoding, payload: mask.payload, width: mask.width, height: mask.height };
}
