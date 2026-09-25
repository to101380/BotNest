// Use the server's model identifier; never infer the model from the provider.
export function showAiModel(element, model, fallback = "模型待確認") {
  const id = typeof model === "string" ? model.trim() : "";
  const name = id.replace(/^gpt-(\d+(?:\.\d+)*)(?:-(mini|nano|pro))?$/, (_, version, size) => `GPT-${version}${size ? ` ${size}` : ""}`);
  element.textContent = id ? `OpenAI · ${name}` : fallback;
  if (id) element.title = id;
  else element.removeAttribute("title");
}
