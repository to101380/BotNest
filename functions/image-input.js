import { readMediaResponse, downloadPublicMedia } from "./media-input.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function imageDataUrl(bytes) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("image_size");
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpg = bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!png && !jpg && !webp) throw new Error("image_format");
  return `data:image/${png ? "png" : jpg ? "jpeg" : "webp"};base64,${bytes.toString("base64")}`;
}
export async function readImageResponse(response) {
  return imageDataUrl(await readMediaResponse(response, MAX_IMAGE_BYTES));
}
export async function downloadPublicImage(value, options = {}) {
  return imageDataUrl(await downloadPublicMedia(value, { ...options, maxBytes: MAX_IMAGE_BYTES }));
}

export function imageAttachments(message, payload = {}) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : Array.isArray(payload.attachments) ? payload.attachments : [];
  return attachments.filter(item => item?.type === "image").map(item => ({ type: "image", url: typeof item.url === "string" ? item.url.slice(0, 4096) : "" })).slice(0, 4);
}
