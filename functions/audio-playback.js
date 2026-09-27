import { createHmac, timingSafeEqual } from "node:crypto";
import { downloadPublicAudio, readAudioResponse } from "./audio-input.js";

// Tickets are issued only from a tenant-scoped, authenticated provider message list.
export function audioTicket(value, key, now) {
  const data = Buffer.from(JSON.stringify({ ...value, expires: now + 5 * 60000 })).toString("base64url");
  return `${data}.${createHmac("sha256", key).update(`audio-playback:${data}`).digest("hex")}`;
}
export function verifyAudioTicket(ticket, scope, key, now) {
  if (typeof ticket !== "string" || ticket.length > 12000) throw new Error("audio_ticket");
  const [data, signature, extra] = ticket.split(".");
  if (extra || !/^[a-f0-9]{64}$/.test(signature || "")) throw new Error("audio_ticket");
  const expected = createHmac("sha256", key).update(`audio-playback:${data}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new Error("audio_ticket");
  const value = JSON.parse(Buffer.from(data, "base64url").toString());
  if (value.uid !== scope.uid || value.platform !== scope.platform || value.accountId !== scope.accountId || !Number.isSafeInteger(value.expires) || value.expires <= now || value.expires > now + 5 * 60000) throw new Error("audio_ticket");
  return value;
}
export async function socialAudio(ticket, scope, key, now, download = downloadPublicAudio) {
  const value = verifyAudioTicket(ticket, scope, key, now);
  return audioPayload(await download(value.url));
}
export async function lineAudio(url, token, fetchLine) {
  const response = await fetchLine(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(8000) });
  return audioPayload(await readAudioResponse(response));
}
function audioPayload(file) {
  return { mime: file.type, data: file.bytes.toString("base64") };
}
