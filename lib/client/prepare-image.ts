/**
 * Normalises a photo before upload: applies the EXIF rotation, caps the long
 * side and re-encodes as JPEG. SAM's box and point tokens must use the pixel
 * size the model sees, so the size returned here is the one stored with the scan.
 */
export async function prepareImage(file: Blob, maxSide = 1600): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("Could not encode the photo");
  return { blob, width, height };
}

/** A ~1 KB thumbnail sent ahead of the photo, so the other screens show it at once, blurred. */
export async function previewOf(file: Blob, side = 40): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = side / Math.max(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.6), ...size };
}
