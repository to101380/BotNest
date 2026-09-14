import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./core.js";

export const MEDIA_ORIGIN = "https://planning-with-ai-52d58.web.app";
export function mediaSignature(path, expires, key) {
  return createHmac("sha256", Buffer.from(key, "base64")).update(`media:${path}:${expires}`).digest("hex");
}
export function validMediaSignature(path, expires, signature, key, now) {
  if (!/^\d{13}$/.test(expires || "") || Number(expires) <= now || !/^[a-f0-9]{64}$/.test(signature || "")) return false;
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(mediaSignature(path, expires, key), "hex"));
}
export function validateUpload(body) {
  const { name, kind, data } = body || {};
  if (typeof name !== "string" || !name.trim() || name.length > 160 || /[\x00-\x1f\x7f/\\]/.test(name) || !["image", "file"].includes(kind)) throw new HttpError(400, "附件名稱或類型無效。");
  if (typeof data !== "string" || data.length > 7 * 1024 * 1024 || (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))) throw new HttpError(400, "附件資料無效。");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > (kind === "image" ? 1024 * 1024 : 5 * 1024 * 1024)) throw new HttpError(413, kind === "image" ? "圖片壓縮後須小於 1 MB。" : "文件須小於 5 MB。");
  let mime = "application/octet-stream";
  if (kind === "image") {
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = "image/png";
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = "image/jpeg";
    else throw new HttpError(400, "圖片僅支援 JPEG 或 PNG。");
  } else if (!/\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/i.test(name)) throw new HttpError(400, "支援 PDF、Office 文件、TXT、CSV 與 ZIP。");
  return { bytes, name, kind, mime, size: bytes.length };
}
