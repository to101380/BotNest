export const DAY = 86400000;
export const DEFAULT_RETENTION = Object.freeze({ textDays: 365, attachmentDays: 90, trashDays: 30, backupDays: 7 });
export function initialPolicy(at) {
  return { ...DEFAULT_RETENTION, enabled: false, preparedAt: at, effectiveAt: at + 14 * DAY, revision: 0 };
}
export function retentionActive(policy, at) { return !!policy?.enabled && at >= policy.effectiveAt; }
export function trashDeadline(state, policy) {
  return state?.trashed ? Math.max(state.trashedAt || policy.preparedAt, policy.preparedAt) + policy.trashDays * DAY : null;
}
export function attachmentCreated(value) {
  return value.createdAt ?? value.receivedAt ?? (Number.isFinite(value.expiresAt) ? value.expiresAt - 30 * DAY : null);
}
export function messageDue(value, policy, at) { return Number.isFinite(value.sentAt) && value.sentAt + policy.textDays * DAY <= at; }
export function attachmentDue(value, policy, at) { const created = attachmentCreated(value); return Number.isFinite(created) && created + policy.attachmentDays * DAY <= at; }
export function visibleRetainedMessage(message, policy, workflow, at) {
  const cutoff = workflow?.purgedAt || workflow?.lastPurgedAt;
  if (cutoff && message.sentAt <= cutoff) return false;
  return !retentionActive(policy, at) || !messageDue(message, policy, at);
}
export function validateRetention(body, previous, preview, at) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!body || Object.keys(body).some(key => !['textDays', 'attachmentDays', 'trashDays', 'enabled', 'revision', 'confirm'].includes(key)) || !Number.isSafeInteger(body.revision) || body.revision !== previous.revision) throw Object.assign(new Error('設定已更新，請重新整理。'), { status: 409 });
  if (![365, 730].includes(body.textDays) || ![90, 180].includes(body.attachmentDays) || ![30, 60].includes(body.trashDays) || typeof body.enabled !== 'boolean') fail('保留期限格式錯誤。');
  const changesDeletion = body.enabled && (!previous.enabled || body.textDays < previous.textDays || body.attachmentDays < previous.attachmentDays || body.trashDays < previous.trashDays);
  if (changesDeletion && (!body.confirm || !preview?.finishedAt || preview.finishedAt < at - DAY || preview.policyRevision !== previous.revision)) fail('請先完成最新資料盤點，並確認永久清除規則。');
  return { ...previous, ...(!previous.enabledAt && body.enabled ? { preparedAt: at, enabledAt: at } : {}), textDays: body.textDays, attachmentDays: body.attachmentDays, trashDays: body.trashDays, enabled: body.enabled, revision: previous.revision + 1, effectiveAt: changesDeletion ? Math.max(previous.effectiveAt, at + 14 * DAY) : previous.effectiveAt, updatedAt: at };
}
export function safeMessage(id, value) {
  // Export allowlist: never export access/reply tokens, leases, signed URLs or internal paths.
  return { id, direction: value.direction || 'incoming', type: value.type || 'text', text: value.unsent ? '[訊息已收回]' : String(value.text || ''), sentAt: value.sentAt || 0, unsent: !!value.unsent, ...(value.attachment ? { attachment: { name: value.attachment.name || '附件', kind: value.attachment.kind || value.type, expired: !!value.attachmentExpired } } : {}) };
}
export function safeFilename(value) { return String(value || 'attachment').replace(/[\\/\x00-\x1f<>:"|?*]/g, '_').slice(0, 100).replace(/^\.+/, '_'); }
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
