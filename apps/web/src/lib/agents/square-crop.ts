/** Avatars render in SQUARES everywhere (our chips, Slack's message icons —
 * which letterbox anything non-square). Center-crop to a square and bound the
 * size before upload; a GIF passes through untouched (canvas would freeze the
 * animation) and any decode failure falls back to the original bytes. */
const AVATAR_EDGE = 512;

export const squareCrop = async (file: File): Promise<File> => {
  if (file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const edge = Math.min(side, AVATAR_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = edge;
    canvas.height = edge;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      edge,
      edge,
    );
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) return file;
    return new File([blob], "avatar.png", { type: "image/png" });
  } catch {
    return file;
  }
};
