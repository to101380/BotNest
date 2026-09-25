export class AiError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function aiError(status, message) { return new AiError(status, message); }
export const AI_DEFAULTS = {
  enabled: false, model: "gpt-5.4-mini", instructions: "", role: "品牌客服助理", businessInfo: "",
  tone: "親切、簡潔、有禮貌", language: "繁體中文", forbidden: "不得捏造價格、庫存、政策或已完成的操作。",
  channels: { line: true, facebook: true, instagram: true }, schedule: { mode: "always", timezone: "Asia/Taipei", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
  handoffKeywords: ["退款", "客訴", "投訴", "真人客服", "找真人"], requireKnowledge: true, humanPauseMinutes: 30,
  handoffMessage: "這個問題需要由真人客服協助，我先為您轉交，請稍候。", updatedAt: 0,
};
export function normalizeAiSettings(value = {}) {
  // Segmentation is universal. Discard the old per-channel switches on every read.
  const { splitReplies: _legacySplitReplies, ...settings } = value;
  return { ...AI_DEFAULTS, ...settings, channels: { ...AI_DEFAULTS.channels, ...settings.channels }, schedule: { ...AI_DEFAULTS.schedule, ...settings.schedule } };
}
export function validateAiSettings(input, previous = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw aiError(400, "AI 設定格式錯誤。");
  // Accept but ignore splitReplies so an already-open older client can still save.
  const editable = ["splitReplies", "enabled", "instructions", "role", "businessInfo", "tone", "language", "forbidden", "channels", "schedule", "handoffKeywords", "requireKnowledge", "humanPauseMinutes", "handoffMessage"];
  if (Object.keys(input).some(key => !editable.includes(key))) throw aiError(400, "包含不支援的 AI 設定欄位。");
  const result = normalizeAiSettings({ ...previous, ...input });
  for (const [key, limit] of Object.entries({ instructions: 4000, role: 120, businessInfo: 6000, tone: 200, language: 80, forbidden: 2000, handoffMessage: 500 })) {
    if (typeof result[key] !== "string" || result[key].length > limit) throw aiError(400, `AI 設定內容過長或格式錯誤（${key}）。`);
    result[key] = result[key].trim();
  }
  if (!result.role || !result.language || !result.handoffMessage) throw aiError(400, "請填寫客服角色、回覆語言及轉交真人訊息。");
  if (typeof result.enabled !== "boolean" || typeof result.requireKnowledge !== "boolean" || !Number.isInteger(result.humanPauseMinutes) || result.humanPauseMinutes < 1 || result.humanPauseMinutes > 1440) throw aiError(400, "真人回覆後的暫停時間需為 1～1440 分鐘。");
  if (typeof result.channels?.line !== "boolean" || typeof result.channels?.facebook !== "boolean" || typeof result.channels?.instagram !== "boolean") throw aiError(400, "請選擇有效的渠道設定。");
  result.channels = { line: result.channels.line, facebook: result.channels.facebook, instagram: result.channels.instagram };
  const schedule = result.schedule;
  if (!["always", "inside", "outside"].includes(schedule.mode) || !Array.isArray(schedule.days) || !schedule.days.length || schedule.days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.end) || schedule.start === schedule.end) throw aiError(400, "請設定有效的營業日與時間，開始及結束時間不可相同。");
  try { if (typeof schedule.timezone !== "string" || schedule.timezone.length > 80) throw new Error(); new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }); } catch { throw aiError(400, "時區格式錯誤。"); }
  result.schedule = { mode: schedule.mode, timezone: schedule.timezone, days: [...new Set(schedule.days)], start: schedule.start, end: schedule.end };
  if (!Array.isArray(result.handoffKeywords) || result.handoffKeywords.length > 30 || result.handoffKeywords.some(word => typeof word !== "string" || !word.trim() || word.length > 50)) throw aiError(400, "轉真人關鍵字最多 30 個，每個 1～50 字。");
  result.handoffKeywords = [...new Set(result.handoffKeywords.map(word => word.trim()))]; result.model = AI_DEFAULTS.model;
  return result;
}
export function withinBusinessHours(schedule, at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday), time = `${parts.hour}:${parts.minute}`;
  if (schedule.start < schedule.end) return schedule.days.includes(day) && time >= schedule.start && time < schedule.end;
  return (schedule.days.includes(day) && time >= schedule.start) || (schedule.days.includes((day + 6) % 7) && time < schedule.end);
}
export function aiEligibility(settings, provider, control = {}, at = Date.now(), { preview = false } = {}) {
  const ai = normalizeAiSettings(settings);
  if (!preview && !ai.enabled) return { allowed: false, reason: "AI 自動回覆已關閉" };
  if (!ai.channels[provider]) return { allowed: false, reason: "此渠道未啟用 AI" };
  if (control.mode === "human") return { allowed: false, reason: control.reason || "真人客服處理中" };
  if (control.mode === "off") return { allowed: false, reason: "這位顧客已關閉 AI" };
  if (control.pausedUntil > at) return { allowed: false, reason: "真人已回覆，AI 暫停中" };
  if (ai.schedule.mode !== "always") {
    const inside = withinBusinessHours(ai.schedule, at);
    if ((ai.schedule.mode === "inside" && !inside) || (ai.schedule.mode === "outside" && inside)) return { allowed: false, reason: "目前不在 AI 回覆時段" };
  }
  return { allowed: true, reason: "AI 自動回覆中" };
}

function tokens(value) {
  const text = String(value).toLowerCase(), result = text.match(/[a-z0-9]{2,}/g) || [];
  for (const run of text.match(/[\p{Script=Han}]+/gu) || []) { if (run.length === 1) result.push(run); for (let i = 0; i < run.length - 1; i++) result.push(run.slice(i, i + 2)); }
  return new Set(result);
}
export function retrieveKnowledge(items, question, settings) {
  const documents = items.filter(item => item.enabled && !item.deleted);
  const business = [settings.businessInfo, settings.instructions].filter(Boolean).join("\n");
  if (business) documents.unshift({ id: "business", title: "商家資訊與補充指示", content: business, enabled: true });
  const query = tokens(question), chunks = [];
  for (const item of documents) for (let start = 0, index = 1; start < item.content.length; start += 900, index++) {
    const excerpt = item.content.slice(start, start + 1100), words = tokens(`${item.title} ${excerpt}`);
    let score = 0; for (const word of query) if (words.has(word)) score += 1;
    chunks.push({ id: `${item.id}:${index}`, documentId: item.id, title: item.title, excerpt, score, url: item.url || "" });
  }
  // Small knowledge bases fit in full, including generic questions without lexical overlap.
  if (chunks.length <= 8) return chunks;
  const ranked = chunks.sort((a, b) => b.score - a.score);
  const selected = ranked.filter(item => item.score > 0 || item.documentId === "business").slice(0, 8);
  // Fill unused context with one opening excerpt per document, rather than dropping all unmatched knowledge.
  for (const chunk of ranked) {
    if (selected.length >= 8) break;
    if (!selected.some(item => item.documentId === chunk.documentId)) selected.push(chunk);
  }
  return selected;
}
