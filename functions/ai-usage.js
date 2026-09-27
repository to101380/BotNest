import { randomUUID } from "node:crypto";
import { parseBuffer } from "music-metadata";
import { canMonitor } from "./security-monitor.js";
import { aiError } from "./ai-policy.js";

// USD per million tokens. Keep a version on every entry; never reprice history.
export const PRICE_VERSION = "openai-standard-2026-09-27";
const prices = { "gpt-5.4-mini": [0.75, 0.075, 4.5], "gpt-4o-mini-transcribe": [1.25, 1.25, 5] };
const integer = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
export const usageMonth = at => new Date(at + 8 * 3600000).toISOString().slice(0, 7);
const usageDay = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
export function tokenCost(model, usage) {
  const input = integer(usage?.input_tokens), output = integer(usage?.output_tokens);
  const cached = integer(usage?.input_tokens_details?.cached_tokens ?? usage?.input_token_details?.cached_tokens ?? 0);
  if (input === null || output === null || cached === null || cached > input) return { input: null, output: null, cached: null, nanoUsd: null };
  const rate = prices[model] || prices[model?.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  return { input, output, cached, nanoUsd: rate ? Math.round(((input - cached) * rate[0] + cached * rate[1] + output * rate[2]) * 1000) : null };
}
export async function requestMetadata(url, options, context) {
  const audio = url.endsWith("/audio/transcriptions"), body = audio ? options.body : JSON.parse(options.body);
  let durationMs = null;
  if (audio) {
    const file = body.get("file");
    if (file?.size && file.size <= 8 * 1024 * 1024) {
      try {
        const metadata = await parseBuffer(new Uint8Array(await file.arrayBuffer()), { mimeType: file.type }, { duration: true, skipCovers: true });
        if (Number.isFinite(metadata.format.duration) && metadata.format.duration > 0 && metadata.format.duration < 86400) durationMs = Math.round(metadata.format.duration * 1000);
      } catch { /* Missing duration stays unknown; it is never treated as zero. */ }
    }
  }
  const images = audio ? 0 : (body.input || []).reduce((sum, item) => sum + (Array.isArray(item.content) ? item.content.filter(part => part.type === "input_image").length : 0), 0);
  return { provider: context.provider, kind: audio ? "audio" : context.kind || (images ? "image" : "reply"), model: String(audio ? body.get("model") : body.model), images, durationMs };
}
// Meter at the provider boundary, including calls whose output is later rejected
// or not delivered. No prompts, transcripts, URLs, credentials or audio are stored.
export function meteredOpenAi(store, uid, context, fetchOpenAi = fetch, now = Date.now) {
  return async (url, options) => {
    const entry = { ...await requestMetadata(url, options, context), id: randomUUID(), at: now(), status: "pending", priceVersion: PRICE_VERSION, cost: tokenCost("", null) };
    await store.saveUsage(uid, entry); // A durable pending row precedes any billable call.
    let response;
    try { response = await fetchOpenAi(url, options); }
    catch (error) { await settle({ ...entry, status: "uncertain" }); throw error; }
    let data;
    try { data = await response.clone().json(); } catch { data = {}; }
    const billedModel = typeof data.model === "string" ? data.model : entry.model;
    await settle({ ...entry, model: billedModel, status: response.ok ? "completed" : "failed", cost: tokenCost(billedModel, data.usage) });
    return response;
    async function settle(value) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await store.saveUsage(uid, value); return; } catch { /* Idempotent persistence retry, never repeat inference. */ }
      }
      console.error("ai_usage_settlement_pending", entry.id); // Pending row makes the missing result visible.
    }
  };
}
const fields = ["requests", "completed", "failed", "pending", "unknownCost", "images", "audioMs", "unknownDuration", "inputTokens", "cachedTokens", "outputTokens", "nanoUsd"];
export const emptyUsage = () => Object.fromEntries(fields.map(key => [key, 0]));
function contribution(entry) {
  if (!entry) return emptyUsage();
  return { requests: 1, completed: +(entry.status === "completed"), failed: +(entry.status === "failed"), pending: +(["pending", "uncertain"].includes(entry.status)),
    unknownCost: +(entry.cost.nanoUsd === null), images: entry.images, audioMs: entry.durationMs || 0, unknownDuration: +(entry.kind === "audio" && entry.durationMs === null),
    inputTokens: entry.cost.input || 0, cachedTokens: entry.cost.cached || 0, outputTokens: entry.cost.output || 0, nanoUsd: entry.cost.nanoUsd || 0 };
}
export function createUsageStore(db) {
  const state = db.collection("botnest").doc("state");
  const months = uid => uid === null ? state.collection("aiUsageMonths") : state.collection("accounts").doc(uid).collection("aiUsageMonths");
  return {
    async saveUsage(uid, value) {
      const month = usageMonth(value.at), day = usageDay(value.at), summary = months(uid).doc(month), global = months(null).doc(month), ref = summary.collection("events").doc(value.id);
      await db.runTransaction(async tx => {
        const [oldEvent, own, all] = await tx.getAll(ref, summary, global);
        const old = oldEvent.data();
        // A delayed duplicate cannot roll a settled request back to pending.
        if (old && !["pending", "uncertain"].includes(old.status)) return;
        const before = contribution(old), after = contribution(value), bucket = `${value.provider}_${value.kind}`;
        for (const [target, snapshot] of [[summary, own], [global, all]]) {
          const result = snapshot.data() || { firstAt: value.at, buckets: {}, days: {} };
          result.firstAt = Math.min(result.firstAt, value.at); result.updatedAt = Math.max(result.updatedAt || 0, value.at);
          result.buckets[bucket] ||= emptyUsage(); result.days[day] ||= emptyUsage();
          for (const key of fields) { result.buckets[bucket][key] += after[key] - before[key]; result.days[day][key] += after[key] - before[key]; }
          tx.set(target, result);
        }
        tx.set(ref, value);
      });
    },
    async usageSummary(uid, month) { return (await months(uid).doc(month).get()).data() || { firstAt: null, buckets: {}, days: {} }; },
    async usageEvents(uid, month) { return (await months(uid).doc(month).collection("events").orderBy("at", "desc").limit(50).get()).docs.map(doc => doc.data()); },
  };
}
export async function handleUsage({ user, query, req, res, store, now }) {
  if (req.method !== "GET") throw aiError(405, "用量頁面僅提供查詢。");
  const admin = canMonitor(user), scope = query.get("scope") || "mine", month = query.get("month") || usageMonth(now());
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw aiError(400, "月份格式錯誤。");
  if (!["mine", "all"].includes(scope)) throw aiError(400, "查詢範圍錯誤。");
  if (scope === "all" && !admin) throw aiError(403, "僅限管理者查看所有商家用量。");
  if (query.has("uid")) throw aiError(403, "不可指定其他商家帳號。");
  const [summary, events] = await Promise.all([store.usageSummary(scope === "all" ? null : user.uid, month), scope === "mine" ? store.usageEvents(user.uid, month) : []]);
  // Explicit allowlists: cost and tokens never leave the server for merchants.
  const visible = value => Object.fromEntries((admin ? fields : fields.filter(key => !["unknownCost", "inputTokens", "cachedTokens", "outputTokens", "nanoUsd"].includes(key))).map(key => [key, value[key] || 0]));
  return res.json({ month, scope, admin, timezone: "Asia/Taipei", firstAt: summary.firstAt, updatedAt: summary.updatedAt || null,
    buckets: Object.fromEntries(Object.entries(summary.buckets).map(([key, value]) => [key, visible(value)])),
    days: Object.entries(summary.days).sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => ({ day, ...visible(value) })),
    events: events.map(value => ({ at: value.at, provider: value.provider, kind: value.kind, status: value.status, images: value.images, durationMs: value.durationMs,
      ...(admin ? { model: value.model, cost: value.cost, priceVersion: value.priceVersion } : {}) })),
  });
}
