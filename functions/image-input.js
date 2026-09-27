import https from "node:https";
import { validatePublicUrl } from "./knowledge.js";

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
  if (!response.ok || !response.body) throw new Error("image_unavailable");
  if (Number(response.headers?.get("content-length")) > MAX_IMAGE_BYTES) { await response.body.cancel(); throw new Error("image_size"); }
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length; if (size > MAX_IMAGE_BYTES) throw new Error("image_size");
    chunks.push(Buffer.from(chunk));
  }
  return imageDataUrl(Buffer.concat(chunks));
}

// Attachments are untrusted input even when their webhook is authenticated.
// Validate every redirect and pin public DNS; never forward platform credentials.
export async function downloadPublicImage(value, { validate = validatePublicUrl, request = https.get } = {}, redirects = 0, deadline = Date.now() + 8000) {
  const { url, address } = await validate(value);
  if (Date.now() >= deadline) throw new Error("image_timeout");
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false, lookup: (_host, options, cb) => options?.all ? cb(null, [address]) : cb(null, address.address, address.family), headers: { Accept: "image/jpeg,image/png,image/webp", "Accept-Encoding": "identity" } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 3 || !response.headers.location) return reject(new Error("image_redirect"));
        try { resolve(downloadPublicImage(new URL(response.headers.location, url).href, { validate, request }, redirects + 1, deadline)); } catch (error) { reject(error); }
        return;
      }
      if (response.statusCode !== 200 || Number(response.headers["content-length"]) > MAX_IMAGE_BYTES) { response.destroy(); reject(new Error("image_unavailable")); return; }
      let size = 0; const chunks = [];
      response.on("data", chunk => { size += chunk.length; if (size > MAX_IMAGE_BYTES) { response.destroy(); reject(new Error("image_size")); } else chunks.push(chunk); });
      response.on("end", () => { try { resolve(imageDataUrl(Buffer.concat(chunks))); } catch (error) { reject(error); } });
      response.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("image_timeout")), Math.max(1, deadline - Date.now()));
    req.on("close", () => clearTimeout(timer)); req.on("error", reject);
  });
}

export function imageAttachments(message, payload = {}) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : Array.isArray(payload.attachments) ? payload.attachments : [];
  return attachments.filter(item => item?.type === "image").map(item => ({ type: "image", url: typeof item.url === "string" ? item.url.slice(0, 4096) : "" })).slice(0, 4);
}
