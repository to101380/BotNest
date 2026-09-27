import https from "node:https";
import { validatePublicUrl } from "./knowledge.js";

export async function readMediaResponse(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("media_limit");
  if (!response.ok || !response.body) throw new Error("media_unavailable");
  if (Number(response.headers?.get("content-length")) > maxBytes) { await response.body.cancel(); throw new Error("media_size"); }
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length; if (size > maxBytes) throw new Error("media_size");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Attachments are untrusted input even when their webhook is authenticated.
// Validate every redirect and pin public DNS; never forward platform credentials.
export async function downloadPublicMedia(value, { validate = validatePublicUrl, request = https.get, maxBytes } = {}, redirects = 0, deadline = Date.now() + 8000) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("media_limit");
  let dnsTimer;
  const { url, address } = await Promise.race([
    validate(value),
    new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error("media_timeout")), Math.max(1, deadline - Date.now())); }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (Date.now() >= deadline) throw new Error("media_timeout");
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false, lookup: (_host, options, cb) => options?.all ? cb(null, [address]) : cb(null, address.address, address.family), headers: { Accept: "*/*", "Accept-Encoding": "identity" } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 3 || !response.headers.location) return reject(new Error("media_redirect"));
        try { resolve(downloadPublicMedia(new URL(response.headers.location, url).href, { validate, request, maxBytes }, redirects + 1, deadline)); } catch (error) { reject(error); }
        return;
      }
      if (response.statusCode !== 200 || Number(response.headers["content-length"]) > maxBytes) { response.destroy(); reject(new Error("media_unavailable")); return; }
      let size = 0; const chunks = [];
      response.on("data", chunk => { size += chunk.length; if (size > maxBytes) { response.destroy(); reject(new Error("media_size")); } else chunks.push(chunk); });
      response.on("end", () => { try { resolve(Buffer.concat(chunks)); } catch (error) { reject(error); } });
      response.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("media_timeout")), Math.max(1, deadline - Date.now()));
    req.on("close", () => clearTimeout(timer)); req.on("error", reject);
  });
}
