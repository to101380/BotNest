import { readMediaResponse, downloadPublicMedia } from "./media-input.js";

export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export function audioFile(bytes) {
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new Error("audio_size");
  const head = bytes.toString("ascii", 0, 12);
  let extension, type;
  if (bytes.length >= 12 && head.startsWith("RIFF") && head.slice(8) === "WAVE") { extension = "wav"; type = "audio/wav"; }
  else if (bytes.length >= 12 && head.slice(4, 8) === "ftyp") { extension = "mp4"; type = "audio/mp4"; }
  else if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) { extension = "webm"; type = "audio/webm"; }
  else if (bytes.length >= 4 && (head.startsWith("ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0))) { extension = "mp3"; type = "audio/mpeg"; }
  else throw new Error("audio_format");
  return { bytes, extension, type };
}
export async function readAudioResponse(response) {
  return audioFile(await readMediaResponse(response, MAX_AUDIO_BYTES));
}
export async function downloadPublicAudio(url, options = {}) {
  return audioFile(await downloadPublicMedia(url, { ...options, maxBytes: MAX_AUDIO_BYTES }));
}
export function audioAttachments(message, payload = {}) {
  const items = Array.isArray(message.attachments) ? message.attachments : Array.isArray(payload.attachments) ? payload.attachments : [];
  // Preserve a second item to reject batches instead of silently dropping speech.
  return items.filter(item => item?.type === "audio").slice(0, 2).map(item => ({ type: "audio", url: typeof item.url === "string" ? item.url.slice(0, 4096) : "" }));
}
export async function transcribeAudio(file, { getOpenAiKey, fetchOpenAi = fetch }) {
  const body = new FormData();
  body.append("file", new Blob([file.bytes], { type: file.type }), `voice.${file.extension}`);
  body.append("model", "gpt-4o-mini-transcribe");
  body.append("response_format", "json");
  const response = await fetchOpenAi("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${getOpenAiKey()}` }, body, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("audio_transcription_failed");
  const data = await response.json();
  if (typeof data.text !== "string" || !data.text.trim() || data.text.length > 6000) throw new Error("audio_transcription_empty_or_long");
  return data.text.trim();
}
export const AUDIO_CLARIFICATION = {
  action: "reply", text: "這段語音目前無法清楚辨識，請一次重傳一段較短、清楚的語音（上限 8 MB），或用文字補充您的問題。",
  reason: "語音無法辨識，請顧客補充", sources: [], usage: null,
};
