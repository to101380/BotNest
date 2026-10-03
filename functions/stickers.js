export function lineSticker(message = {}) {
  if (message.type !== 'sticker' || !/^\d{1,20}$/.test(String(message.stickerId || '')) || !/^\d{1,20}$/.test(String(message.packageId || ''))) return null;
  return { stickerId: String(message.stickerId), packageId: String(message.packageId), resourceType: String(message.stickerResourceType || 'STATIC').slice(0, 40), text: typeof message.text === 'string' ? message.text.slice(0, 500) : '', keywords: Array.isArray(message.keywords) ? message.keywords.filter(k => typeof k === 'string').slice(0, 15).map(k => k.slice(0, 80)) : [] };
}
export function socialAttachment(item, sentAt, at) {
  if (!item || typeof item !== 'object') return null;
  const url = item.url || item.payload?.url;
  if (typeof url !== 'string' || !url) return null;
  const kind = ['image', 'sticker', 'animated_image_share'].includes(item.type) ? 'image' : 'file';
  return { kind, name: String(item.filename || (item.type === 'sticker' ? '貼圖' : kind === 'image' ? '圖片' : '社群附件')).slice(0, 200), url: url.slice(0, 4096), external: true, expiresAt: (item.type === 'sticker' ? at : sentAt) + 86400000 };
}
