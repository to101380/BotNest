import { HttpError } from "./core.js";

export function normalizeImageCard(value, attachmentId) {
  if (value == null) return null;
  if (!attachmentId || typeof value !== "object" || Array.isArray(value) ||
      typeof value.title !== "string" || typeof value.description !== "string" ||
      value.title.length > 80 || value.description.length > 500) {
    throw new HttpError(400, "圖片卡片標題最多 80 字、說明最多 500 字，並須選取圖片。");
  }
  return { title: value.title.trim(), description: value.description.trim() };
}

export function imageCardMessage(attachment, card) {
  if (attachment?.kind !== "image") throw new HttpError(400, "卡片僅支援圖片。");
  const title = card.title || attachment.name;
  return {
    type: "flex", altText: `圖片：${title}`.slice(0, 400),
    contents: {
      type: "bubble",
      hero: { type: "image", url: attachment.url, size: "full", aspectRatio: "4:3", aspectMode: "fit", backgroundColor: "#F5F5F7", action: { type: "uri", label: "查看圖片", uri: attachment.url } },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "text", text: title, weight: "bold", size: "md", wrap: true },
        ...(card.description ? [{ type: "text", text: card.description, size: "sm", color: "#666666", wrap: true }] : []),
      ] },
      footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "link", action: { type: "uri", label: "查看圖片", uri: attachment.url } }] },
    },
  };
}
