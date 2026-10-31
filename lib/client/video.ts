/**
 * Reads a filmed clip in the browser: its size, its length, and its first
 * frame as a JPEG — the photo the analysis runs on before SAM follows each
 * item through the clip.
 */
export async function firstFrame(
  file: Blob,
  maxSide = 1600,
): Promise<{ frame: Blob; width: number; height: number; videoWidth: number; videoHeight: number; duration: number }> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("This video cannot be read"));
    });
    // Frame 0 is where the boxes are drawn for SAM.
    if (video.currentTime !== 0) {
      video.currentTime = 0;
      await new Promise((r) => (video.onseeked = r));
    }
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!frame) throw new Error("Could not read the first frame");
    return {
      frame,
      width: canvas.width,
      height: canvas.height,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      duration: video.duration,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
