/** Later frames only need to show what is there: smaller, cheaper for Muse Spark to read. */
const STILL_SIDE = 1280;

/** One later frame for a short clip, up to three for a long pan. */
export const stillsFor = (seconds: number) => (seconds < 2.5 ? 0 : seconds < 5 ? 1 : seconds < 9 ? 2 : 3);

/** Past this, a phone that cannot decode the clip would leave the screen waiting forever. */
const READ_TIMEOUT_MS = 12_000;

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error: unknown) => (clearTimeout(timer), reject(error)),
    );
  });
}

const once = (target: HTMLVideoElement, event: string) =>
  new Promise<void>((resolve, reject) => {
    target.addEventListener(event, () => resolve(), { once: true });
    target.addEventListener("error", () => reject(new Error("This video cannot be read")), { once: true });
  });

/** Thrown when the browser cannot open the clip, so the caller can say so instead of waiting. */
export class UnreadableVideo extends Error {}

/**
 * Reads a filmed clip in the browser: its size, its length, and its first
 * frame as a JPEG — the photo the analysis runs on before SAM follows each
 * item through the clip.
 *
 * iOS Safari loads nothing for a video that is not on screen and not playing,
 * so the clip is attached (invisibly), loaded explicitly, and nudged with a
 * muted play when seeking alone does not paint a frame.
 */
export async function firstFrame(
  file: Blob,
  maxSide = 1600,
  /** How many later frames to pick too, spread over the clip, for what the first frame misses. */
  stillCount = 0,
): Promise<{
  frame: Blob;
  width: number;
  height: number;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  stills: { blob: Blob; time: number }[];
}> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.preload = "auto";
  video.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
  document.body.appendChild(video);
  try {
    const metadata = once(video, "loadedmetadata");
    video.src = url;
    video.load();
    try {
      await within(metadata, READ_TIMEOUT_MS);
    } catch {
      throw new UnreadableVideo("This video cannot be read");
    }

    // A tiny seek past zero makes Safari decode a frame; play/pause is the fallback.
    const seeked = once(video, "seeked");
    video.currentTime = Math.min(0.05, (Number.isFinite(video.duration) ? video.duration : 1) / 2);
    try {
      await within(seeked, 4_000);
    } catch {
      try {
        await within(video.play(), 4_000);
        video.pause();
      } catch {
        throw new UnreadableVideo("This video cannot be read");
      }
    }
    if (video.readyState < 2) {
      try {
        await within(once(video, "loadeddata"), 4_000);
      } catch {
        throw new UnreadableVideo("This video cannot be read");
      }
    }

    if (!video.videoWidth || !video.videoHeight) throw new UnreadableVideo("This video has no picture");
    const grab = async (side: number, quality: number) => {
      const scale = Math.min(1, side / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      return { canvas, blob: await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality)) };
    };
    const { canvas, blob: frame } = await grab(maxSide, 0.88);
    if (!frame) throw new UnreadableVideo("Could not read the first frame");

    // Later frames are a bonus: one that will not seek is skipped, never fatal.
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const stills: { blob: Blob; time: number }[] = [];
    for (let i = 1; i <= stillCount && duration > 0; i++) {
      const time = Math.min(duration - 0.15, (duration * i) / stillCount);
      if (time <= 0.5) continue;
      try {
        const done = once(video, "seeked");
        video.currentTime = time;
        await within(done, 4_000);
        const { blob } = await grab(STILL_SIDE, 0.85);
        if (blob) stills.push({ blob, time: video.currentTime });
      } catch {
        // Skip this one.
      }
    }
    return {
      stills,
      frame,
      width: canvas.width,
      height: canvas.height,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}

/** POSTs a file to a Convex upload URL, reporting progress (fetch cannot) so a big clip never looks frozen. */
export function uploadWithProgress(url: string, blob: Blob, onProgress: (fraction: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`Upload failed with ${xhr.status}`));
      try {
        resolve((JSON.parse(xhr.responseText) as { storageId: string }).storageId);
      } catch {
        reject(new Error("Upload answer unreadable"));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(blob);
  });
}

/** A clip's length from its metadata alone, or 0 when the browser cannot tell within a few seconds. */
export function durationOf(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const done = (seconds: number) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(seconds) ? seconds : 0);
    };
    const timer = setTimeout(() => done(0), 5_000);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => done(video.duration);
    video.onerror = () => done(0);
    video.src = url;
    video.load();
  });
}
