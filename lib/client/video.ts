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
): Promise<{ frame: Blob; width: number; height: number; videoWidth: number; videoHeight: number; duration: number }> {
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
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!frame) throw new UnreadableVideo("Could not read the first frame");
    return {
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
