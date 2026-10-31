/**
 * Reads the frame rate and picture size of an MP4 or MOV from its boxes, so a
 * frame picked at a time in the browser can be named by its index for SAM.
 * Only the first video track is read; edit lists are ignored.
 */
export type VideoInfo = { fps: number; frames: number; duration: number; width: number; height: number };

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts"]);

type Box = { type: string; start: number; end: number };

function* boxes(view: DataView, start: number, end: number): Generator<Box> {
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7));
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) return;
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

const find = (view: DataView, box: Box, type: string) => {
  for (const child of boxes(view, box.start, box.end)) if (child.type === type) return child;
  return undefined;
};

/** The moov box can sit at the end of the file; `bytes` must be the whole file. */
export function readVideoInfo(bytes: ArrayBuffer): VideoInfo | null {
  const view = new DataView(bytes);
  const moov = [...boxes(view, 0, view.byteLength)].find((b) => b.type === "moov");
  if (!moov) return null;
  for (const trak of boxes(view, moov.start, moov.end)) {
    if (trak.type !== "trak" || !CONTAINERS.has(trak.type)) continue;
    const mdia = find(view, trak, "mdia");
    const hdlr = mdia && find(view, mdia, "hdlr");
    if (!mdia || !hdlr || hdlr.end - hdlr.start < 12) continue;
    const handler = String.fromCharCode(...[8, 9, 10, 11].map((i) => view.getUint8(hdlr.start + i)));
    if (handler !== "vide") continue;

    const mdhd = find(view, mdia, "mdhd");
    if (!mdhd) return null;
    const v1 = view.getUint8(mdhd.start) === 1;
    const timescale = view.getUint32(mdhd.start + (v1 ? 20 : 12));
    const units = v1 ? Number(view.getBigUint64(mdhd.start + 24)) : view.getUint32(mdhd.start + 16);

    const stbl = (() => {
      const minf = find(view, mdia, "minf");
      return minf && find(view, minf, "stbl");
    })();
    const stts = stbl && find(view, stbl, "stts");
    let frames = 0;
    if (stts) {
      const entries = view.getUint32(stts.start + 4);
      for (let i = 0; i < entries && stts.start + 8 + i * 8 + 8 <= stts.end; i++) frames += view.getUint32(stts.start + 8 + i * 8);
    }

    const tkhd = find(view, trak, "tkhd");
    let width = 0;
    let height = 0;
    if (tkhd) {
      // Width and height are the last two 16.16 fixed-point fields of the box.
      width = Math.round(view.getUint32(tkhd.end - 8) / 65536);
      height = Math.round(view.getUint32(tkhd.end - 4) / 65536);
    }
    const duration = timescale > 0 ? units / timescale : 0;
    if (!frames || !duration) return null;
    return { fps: frames / duration, frames, duration, width, height };
  }
  return null;
}

/** Phones film at 30 frames a second unless the file says otherwise. */
export const DEFAULT_FPS = 30;

/** The index SAM gives the frame shown at `seconds`. */
export const frameAt = (seconds: number, fps: number, frames?: number) => {
  const index = Math.round(seconds * fps);
  return Math.max(0, frames ? Math.min(frames - 1, index) : index);
};
