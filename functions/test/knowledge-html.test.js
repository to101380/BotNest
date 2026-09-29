import test from "node:test";
import assert from "node:assert/strict";
import { extractKnowledgeHtml } from "../knowledge-html.js";

test("keeps contact details outside main, image descriptions and table boundaries", () => {
  const result = extractKnowledgeHtml(`<title>Tea</title><header><h1>茶廠</h1><nav>導覽雜訊</nav></header><main><table><tr><td>春茶</td><td>NT$800</td></tr></table><img alt="高山茶 150 公克"></main><footer>營業時間 09:00–17:00<br>電話 04-12345678</footer><div hidden>隱藏促銷</div><div style="display: none">過期內容</div><script>secret()</script>`, "https://example.com/");
  assert.match(result.content, /春茶 \| NT\$800/);
  assert.match(result.content, /營業時間 09:00–17:00/);
  assert.match(result.content, /電話 04-12345678/);
  assert.match(result.content, /\[圖片說明\] 高山茶 150 公克/);
  assert.doesNotMatch(result.content, /隱藏促銷|過期內容|secret|導覽雜訊/);
});

test("reads only published CYBERBIZ home sections and blocks, never executes scripts", () => {
  const settings = { draggable_sections: { index: ["live", "old"] }, sections: {
    live: { visible: true, settings: { dict_title: "春茶系列", dict_body_html: "<p>滿千免運</p><script>throw Error('executed')</script>", credential: "PRIVATE" }, block_order: ["active", "hidden"], blocks: {
      active: { visible: true, settings: { custom_block_image_alt: "單包 150g" } },
      hidden: { visible: false, settings: { dict_title: "過期優惠" } },
      removed: { visible: true, settings: { dict_title: "已移除" } }
    } }, old: { visible: false, settings: { dict_title: "未上架活動" } },
    unused: { visible: true, settings: { dict_title: "主題預設" } }
  } };
  const html = `<script>window.setSettingsData(${JSON.stringify(settings).replace(/</g, "\\u003c")});</script><main>公開文字</main>`;
  const result = extractKnowledgeHtml(html, "https://example.com/zh-TW?gad_source=1");
  assert.match(result.content, /春茶系列/); assert.match(result.content, /滿千免運/); assert.match(result.content, /單包 150g/);
  assert.doesNotMatch(result.content, /過期優惠|已移除|未上架活動|主題預設|PRIVATE|executed/);
  assert.match(result.importWarnings.join(" "), /商品列表/);
  assert.doesNotMatch(extractKnowledgeHtml(html, "https://example.com/products/tea").content, /春茶系列/);
});

test("malformed data fails safely and duplicate image descriptions are merged", () => {
  const html = `<script>window.setSettingsData({not:JSON});</script><img alt="茶廠介紹文字"><img alt="茶廠介紹文字"><footer>客服資訊</footer>`;
  const result = extractKnowledgeHtml(html, "https://example.com/");
  assert.equal(result.content.match(/茶廠介紹文字/g).length, 1);
  assert.match(result.importWarnings.join(" "), /無法解析/);
  assert.match(result.content, /客服資訊/);
});
