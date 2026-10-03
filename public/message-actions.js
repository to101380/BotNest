const icons = {
  pin: '<path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6"/>',
  reply: '<path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7"/>',
  unread: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/><circle cx="19" cy="5" r="3" fill="currentColor"/>'
};
export function messageToolbar({ pinned, unread, disabled, replyUnavailable, onAction }) {
  const row = document.createElement('div'); row.className = 'message-actions'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', '訊息操作');
  for (const [action, label, pressed] of [['pin', pinned ? '取消釘選' : '釘選訊息', pinned], ['reply', '回覆訊息', null], ['unread', '標記未讀', unread]]) {
    const button = document.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.disabled = disabled;
    if (action === 'reply' && replyUnavailable) { button.disabled = true; button.title = replyUnavailable; }
    button.dataset.messageAction = action;
    if (pressed !== null) button.setAttribute('aria-pressed', String(!!pressed));
    button.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[action]}</svg>`;
    button.onclick = () => onAction(action); row.append(button);
  }
  return row;
}
