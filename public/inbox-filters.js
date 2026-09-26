const normalize = value => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{M}]+/gu, "");
export function matchesName(item, query) {
  const needle = normalize(query);
  if (!needle) return true;
  return [item.customer?.name, item.displayName].some(name => {
    const value = normalize(name);
    if (value.includes(needle)) return true;
    // Ordered partial characters also match (e.g. 黃博 → 黃韋博).
    let index = 0;
    for (const char of value) if (char === needle[index]) index++;
    return index === needle.length;
  });
}
export function inboxMode(ai) {
  if (!ai) return "unknown";
  if (["AI 自動回覆已關閉", "此渠道未啟用 AI"].includes(ai.state.reason) || ai.control.mode === "off") return "off";
  if (ai.control.mode === "human" || ai.state.reason === "真人已回覆，AI 暫停中" || (!ai.state.allowed && ai.control.pausedUntil > Date.now())) return "human";
  return ai.state.allowed ? "auto" : "off";
}
export function filterConversations(items, query, mode) {
  return items.filter(item => matchesName(item, query) && (mode === "all" || inboxMode(item.ai) === mode));
}
