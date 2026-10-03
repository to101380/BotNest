export function lineStickerUrl(sticker) {
  if (!/^\d{1,20}$/.test(sticker?.stickerId || '') || !/^\d{1,20}$/.test(sticker?.packageId || '')) return null;
  // LINE's arranging feature reports a generic ID rather than the combined stickers.
  if (sticker.packageId === '30563' && sticker.stickerId === '651698630') return null;
  return `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.stickerId}/android/sticker.png`;
}
