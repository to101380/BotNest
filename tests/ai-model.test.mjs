import test from "node:test";
import assert from "node:assert/strict";
import { showAiModel } from "../public/ai-model.js";

test("model label follows the backend identifier and preserves unknown models", () => {
  const node = { textContent: "", title: "", removeAttribute(name) { delete this[name]; } };
  showAiModel(node, "gpt-5.4-mini");
  assert.equal(node.textContent, "OpenAI · GPT-5.4 mini");
  assert.equal(node.title, "gpt-5.4-mini");
  showAiModel(node, "deployment-custom-2026");
  assert.equal(node.textContent, "OpenAI · deployment-custom-2026");
  showAiModel(node, null, "正在讀取模型…");
  assert.equal(node.textContent, "正在讀取模型…");
  assert.equal(node.title, undefined);
  showAiModel(node, undefined);
  assert.equal(node.textContent, "模型待確認");
});
