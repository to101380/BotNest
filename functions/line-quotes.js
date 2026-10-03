export const validQuoteToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(value);
export function publicQuote(message) {
  const { quoteToken, ...safe } = message;
  return { ...safe, canQuote: !message.unsent && !message.attachmentExpired && validQuoteToken(quoteToken) };
}
