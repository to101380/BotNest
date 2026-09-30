export function bulkAiInput(item, mode) {
  if (!["auto", "human"].includes(mode)) throw new Error("不支援的批量操作。");
  const revision = item?.ai?.control?.revision ?? 0;
  if (!item?.ai?.control || !Number.isInteger(revision) || revision < 0) throw new Error("AI 狀態尚未載入，請重新整理後再試。");
  if (["AI 自動回覆已關閉", "此渠道未啟用 AI"].includes(item.ai.state?.reason)) throw new Error("請先在設定開啟此渠道的 AI，再切換對話模式。");
  const social = ["facebook", "instagram"].includes(item.provider);
  return { provider: social ? item.provider : "line", conversationId: social ? item.remoteId : item.id, mode, revision };
}

// Keep existing authorization/revision checks. Bound concurrency rather than fan out
// one request per conversation simultaneously; never automatically retry a write.
export async function runBulkAi(items, mode, save, { isCurrent = () => true, onResult = () => {}, onProgress = () => {} } = {}) {
  const unique = [...new Map(items.map(item => [item.id, item])).values()];
  const results = new Array(unique.length);
  let cursor = 0, completed = 0, stopped = false;
  async function worker() {
    while (!stopped && isCurrent() && cursor < unique.length) {
      const index = cursor++, item = unique[index];
      let result;
      try {
        const data = await save(bulkAiInput(item, mode), item);
        result = { id: item.id, ok: true, data };
      } catch (error) {
        result = { id: item.id, ok: false, error: error.message || "操作未完成，請重新整理確認。" };
        if ([401, 403, 429].includes(error.status) || error.name === "AbortError") stopped = true;
      }
      results[index] = result; completed++;
      if (isCurrent()) { onResult(result); onProgress(completed, unique.length); }
    }
  }
  await Promise.all([worker(), worker()]);
  return unique.map((item, index) => results[index] || { id: item.id, ok: false, pending: true, error: "尚未執行，請稍後重試。" });
}
