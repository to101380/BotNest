import { load } from "cheerio";

// Read public markup as data only. Never evaluate a site's scripts or fetch
// URLs found in its settings. The existing downloader owns network validation.
const normalize = text => text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
function markupText(html) {
  const $ = load(html);
  $("script,style,noscript,iframe,svg,nav,input,select,button,template,[hidden],[aria-hidden='true']").remove();
  $("[style]").filter((_, el) => /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test($(el).attr("style"))).remove();
  $("img[alt]").each((_, el) => { const alt = $(el).attr("alt")?.trim(); if (alt && alt.length > 3) $(el).replaceWith($("<span>").text(`\n[圖片說明] ${alt}\n`)); });
  $("br").replaceWith("\n"); $("td,th").append(" | ");
  $("p,div,section,article,header,footer,li,h1,h2,h3,h4,h5,h6,tr,dt,dd,summary").append("\n");
  return normalize($("body").text());
}

export function extractKnowledgeHtml(html, url) {
  const $ = load(html), title = $("title").first().text().trim() || new URL(url).hostname;
  const parts = [markupText(html)], warnings = [];
  // CYBERBIZ puts home-page sections in a JSON argument. Only published sections
  // and explicitly allowed display fields are eligible, not dormant campaigns,
  // theme defaults, arbitrary script strings or API credentials.
  if (/^\/(?:[a-z]{2}(?:-[A-Z]{2})?)?\/?$/.test(new URL(url).pathname)) {
    const match = html.match(/window\.setSettingsData\(\s*(\{[^\n]*\})\s*\);/);
    if (match) {
      warnings.push("此頁使用動態區塊；已補讀公開的已啟用區塊文字。商品列表、即時價格及圖片內文字可能仍未包含，請另匯入商品頁或圖片。");
      try {
        const data = JSON.parse(match[1]);
        const order = data.draggable_sections?.index;
        if (Array.isArray(order)) for (const id of order.slice(0, 200)) {
          const section = data.sections?.[id];
          if (section?.visible !== true) continue;
          const blocks = section.blocks || {};
          const blockIds = Array.isArray(section.block_order) ? section.block_order : Object.keys(blocks);
          for (const item of [section, ...blockIds.slice(0, 200).map(key => blocks[key])]) {
            if (item?.visible !== true) continue;
            const settings = item.settings || {};
            for (const key of ["dict_title", "dict_body_html", "dict_slide_title", "dict_slide_content", "dict_image_description", "custom_block_image_alt"]) {
              if (typeof settings[key] !== "string") continue;
              const text = markupText(settings[key]);
              if (text) parts.push(key.endsWith("_alt") ? `[圖片說明] ${text}` : text);
            }
          }
        }
      } catch { warnings.push("部分動態資料無法解析，請對照原頁面確認。"); }
    }
  }
  // Keep only distinct extracted lines; do not silently truncate long imports.
  const seen = new Set(), lines = [];
  for (const line of parts.join("\n").split("\n").map(line => line.trim())) {
    if (line && !seen.has(line)) { seen.add(line); lines.push(line); }
  }
  warnings.push("僅匯入此網址，未自動採集其他頁面；圖片說明來自網站 alt 文字，不是圖片 OCR。");
  return { title, content: lines.join("\n"), importWarnings: warnings };
}
