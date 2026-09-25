export const MONITOR_GOOGLE_ID = "111918945038301227460";
export const METRICS = {
  requests: "API 請求", denied: "登入／授權拒絕", webhookRejected: "Webhook 驗證拒絕",
  throttled: "頻率／額度限制", errors: "API 伺服器錯誤", slow: "API 超過 10 秒",
  settingsChanged: "設定／對話模式變更", channelChanged: "渠道連接變更", downloads: "附件下載",
  aiSent: "AI 已回覆", aiFailed: "AI 回覆失敗", aiHandoff: "AI 轉真人", aiLimited: "AI 額度限制",
  injection: "疑似提示詞注入", monitorDenied: "監控頁存取遭拒"
};
export function canMonitor(user) {
  return user?.firebase?.sign_in_provider === "google.com" &&
    Array.isArray(user.firebase.identities?.["google.com"]) &&
    user.firebase.identities["google.com"].includes(MONITOR_GOOGLE_ID);
}
export function requestMetrics(path, method, status, elapsed) {
  const keys = ["requests"];
  if ([401, 403].includes(status)) keys.push("denied");
  if (path.includes("webhook") && [400, 401, 403, 413].includes(status)) keys.push("webhookRejected");
  if (status === 429) keys.push("throttled");
  if (status >= 500) keys.push("errors");
  if (elapsed > 10000) keys.push("slow");
  if (status < 400 && ["POST", "PUT", "DELETE"].includes(method)) {
    if (/\/api\/ai\/(settings|conversation|knowledge)|\/api\/line\/ai/.test(path)) keys.push("settingsChanged");
    if (/\/api\/line\/account|\/api\/zernio\/connect/.test(path)) keys.push("channelChanged");
  }
  if (path === "/zernio-callback" && status === 302) keys.push("channelChanged");
  if (/\/media\//.test(path) && status === 200) keys.push("downloads");
  return keys;
}
export function aiMetrics(value) {
  const keys = [];
  if (value.status === "sent") keys.push("aiSent");
  if (value.status === "failed") keys.push("aiFailed");
  if (value.status === "handoff") keys.push("aiHandoff");
  if (value.status === "skipped" && /上限|額度/.test(value.reason || "")) keys.push("aiLimited");
  if (value.status === "prepared" && /ignore.{0,30}(instructions|rules)|忽略.{0,15}(指令|規則)|system prompt|系統提示詞|給我.{0,10}(管理員|權限)|新增管理員/i.test(value.question || "")) keys.push("injection");
  return keys;
}
export async function readPermissionAudit(getToken, fetchApi = fetch, now = Date.now()) {
  try {
    const { access_token } = await getToken();
    const response = await fetchApi("https://logging.googleapis.com/v2/entries:list", {
      method: "POST", headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ resourceNames: ["projects/planning-with-ai-52d58"],
        filter: `logName="projects/planning-with-ai-52d58/logs/cloudaudit.googleapis.com%2Factivity" AND timestamp>="${new Date(now - 86400000).toISOString()}" AND (protoPayload.methodName:"SetIamPolicy" OR protoPayload.methodName:"setIamPolicy")`,
        orderBy: "timestamp desc", pageSize: 20 }), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return { available: false, events: [], reason: "無法讀取雲端 IAM 稽核紀錄；不能判定權限是否有異動。" };
    const data = await response.json();
    return { available: true, more: !!data.nextPageToken, events: (data.entries || []).map(item => ({
      at: item.timestamp, actor: String(item.protoPayload?.authenticationInfo?.principalEmail || "未知操作者").slice(0, 200),
      method: String(item.protoPayload?.methodName || "SetIamPolicy").slice(0, 160),
      resource: String(item.protoPayload?.resourceName || "").slice(0, 240),
      changes: (item.protoPayload?.serviceData?.policyDelta?.bindingDeltas || item.protoPayload?.metadata?.policyDelta?.bindingDeltas || []).slice(0, 20).map(change => ({ action: String(change.action || "").slice(0, 20), role: String(change.role || "").slice(0, 120), member: String(change.member || "").slice(0, 200) })),
      failed: !!item.protoPayload?.status?.code
    })) };
  } catch { return { available: false, events: [], reason: "雲端 IAM 稽核讀取失敗或逾時；請稍後重試。" }; }
}
// Fixed 24-hour ring: bounded storage, aggregate counts only, no customer content.
export function createMonitor(db, clock = Date.now) {
  const state = db.collection("botnest").doc("state");
  const collection = state.collection("securityMetrics");
  return {
    async record(keys) {
      keys = [...new Set(keys)].filter(key => Object.hasOwn(METRICS, key));
      if (!keys.length) return;
      const at = clock(), bucket = Math.floor(at / 300000), ref = collection.doc(String(bucket % 288));
      try {
        await db.runTransaction(async tx => {
          const old = (await tx.get(ref)).data();
          if (old?.bucket > bucket) return;
          const counts = old?.bucket === bucket ? { ...old.counts } : {};
          for (const key of keys) counts[key] = (counts[key] || 0) + 1;
          tx.set(ref, { bucket, at, counts });
        });
      } catch { console.error("security_monitor_write_failed"); }
    },
    async snapshot() {
      const now = clock(), minimum = Math.floor(now / 300000) - 287;
      const docs = await collection.get();
      const buckets = docs.docs.map(doc => doc.data()).filter(row => row.bucket >= minimum && row.bucket <= minimum + 287).sort((a, b) => a.bucket - b.bucket);
      const totals = Object.fromEntries(Object.keys(METRICS).map(key => [key, 0]));
      for (const row of buckets) for (const key of Object.keys(totals)) totals[key] += row.counts[key] || 0;
      return { now, totals, buckets, labels: METRICS, windowMinutes: 1440, lastObservedAt: buckets.at(-1)?.at || null };
    }
  };
}
