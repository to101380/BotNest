// Keep polling bounded; server-side webhooks and AI replies run independently.
export function pollDelay(unchangedRounds, selected) {
  return Math.min(selected ? 60000 : 120000, 10000 * 2 ** Math.min(unchangedRounds, 4));
}
export function conversationVersion(item) {
  return item ? JSON.stringify([item.id, item.updatedAt, item.lastText, item.lastMessageId, item.lastIncomingMessageId]) : "";
}
export function needsMessageRefresh(previous, item, now, force = false) {
  return !!item && (force || previous?.id !== item.id || previous?.version !== conversationVersion(item) || now - previous.at >= 60000);
}
