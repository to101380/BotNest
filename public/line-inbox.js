const $ = id => document.getElementById(id);
const formatClock = value => new Date(value).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayKey = value => {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};
const formatConversationTime = value => {
  const date = new Date(value), now = new Date();
  if (dayKey(date) === dayKey(now)) return formatClock(date);
  return date.toLocaleDateString("zh-TW", date.getFullYear() === now.getFullYear()
    ? { month: "numeric", day: "numeric" }
    : { year: "numeric", month: "numeric", day: "numeric" });
};
const formatDay = value => {
  const date = new Date(value), today = new Date(), yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return "今天";
  if (dayKey(date) === dayKey(yesterday)) return "昨天";
  return date.toLocaleDateString("zh-TW", date.getFullYear() === today.getFullYear()
    ? { month: "long", day: "numeric", weekday: "short" }
    : { year: "numeric", month: "long", day: "numeric", weekday: "short" });
};
export function createLineInbox() {
  let user = null, active = false, epoch = 0, controller, timer, channel = null;
  let selected = null, conversationNext = null, messageNext = null, refreshing = false, saving = false, browsingHistory = false;
  const conversations = new Map(), messages = new Map();
  const drafts = new Map(), localReplies = new Map();
  const attachments = new Map();
  let sending = false, uploading = false, customerSaving = false;
  let customerTags = [];
  let followLatest = true;
  const messageArea = $("line-messages");
  messageArea.addEventListener("scroll", () => {
    followLatest = messageArea.scrollHeight - messageArea.clientHeight - messageArea.scrollTop < 40;
  }, { passive: true });
  const messageResize = new ResizeObserver(() => {
    if (active && followLatest) messageArea.scrollTop = messageArea.scrollHeight;
  });
  function replyControls() {
    const enabled = active && !!selected && !!channel?.canReply && !saving && !sending && !uploading;
    $("line-reply-text").disabled = $("line-send").disabled = !enabled;
    for (const id of ["line-pick-image", "line-pick-file", "line-pick-emoji", "line-remove-attachment"]) $(id).disabled = !enabled;
    $("line-attachment-preview").hidden = !attachments.has(selected) && !uploading;
    $("line-attachment-name").textContent = uploading ? "正在準備附件…" : attachments.has(selected) ? `${attachments.get(selected).kind === "image" ? "圖片" : "文件"}：${attachments.get(selected).name}（待傳送）` : "";
    $("line-send").textContent = sending ? "傳送中…" : "傳送回覆";
    $("line-reply-hint").textContent = !channel?.canReply ? "請更新上方 OA 連線憑證，啟用回覆。" : !selected ? "先選擇一段對話。" : "最多 5000 字";
  }
  const status = (text, error = false) => { $("line-status").textContent = text; $("line-status").classList.toggle("error", error); };
  const clearSecrets = () => { $("line-channel-secret").value = $("line-access-token").value = ""; };
  function historyMode(value) {
    browsingHistory = value;
    $("line-polling-note").textContent = value ? "正在瀏覽較早紀錄，自動更新已暫停；按「重新整理」回到最新訊息。" : "每 10 秒更新。";
  }
  const label = item => item?.customer?.name || item?.displayName || `${({ user: "使用者", group: "群組", room: "聊天室" })[item?.sourceType] || "對話"} · ${(item?.sourceId || "").slice(-8)}`;
  function avatar(item) {
    const frame = document.createElement("span"); frame.className = "chat-avatar";
    frame.textContent = item.displayName ? [...item.displayName][0] : "人";
    frame.setAttribute("aria-hidden", "true");
    if (item.pictureUrl && /^https:\/\/[^/]+\.line-scdn\.net\//i.test(item.pictureUrl)) {
      const image = document.createElement("img"); image.alt = ""; image.src = item.pictureUrl;
      image.loading = "lazy"; image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true }); frame.append(image);
    }
    const badge = document.createElement("span"); badge.className = "line-avatar-badge"; badge.title = "LINE"; frame.append(badge);
    return frame;
  }
  function showConversationHeader() {
    const item = conversations.get(selected);
    $("line-chat-empty").hidden = !!item;
    $("line-chat-empty").parentElement.classList.toggle("has-conversation", !!item);
    $("line-conversation-title").textContent = item ? label(item) : "選擇一段對話";
    $("line-chat-avatar").replaceChildren(...(item ? [avatar(item)] : []));
    $("line-chat-source").textContent = item ? "來自 LINE" : "在左側選擇聊天者，開始回覆";
  }
  const customerFields = ["name", "phone", "email", "birthday", "gender", "language", "country", "city", "address", "about", "custom1", "custom2", "custom3"];
  function renderCustomerTags() {
    $("customer-tags").replaceChildren(...customerTags.map(tag => {
      const chip = document.createElement("span"); chip.className = "customer-tag";
      const text = document.createElement("span"); text.textContent = tag;
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `移除標籤 ${tag}`);
      remove.addEventListener("click", () => { customerTags = customerTags.filter(value => value !== tag); renderCustomerTags(); customerStatus("尚未儲存"); });
      chip.append(text, remove); return chip;
    }));
  }
  function renderCustomerNotes(notes = []) {
    $("customer-notes").replaceChildren(...notes.map(note => {
      const card = document.createElement("article"); card.className = "customer-note-card";
      const text = document.createElement("p"); text.textContent = note.text;
      const time = document.createElement("time"); time.dateTime = new Date(note.createdAt).toISOString(); time.textContent = new Date(note.createdAt).toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" });
      card.append(text, time); return card;
    }));
  }
  function customerStatus(text, error = false) { $("customer-status").textContent = text; $("customer-status").classList.toggle("error", error); }
  function showCustomerPanel() {
    const item = conversations.get(selected), panel = $("customer-panel");
    panel.hidden = !item;
    if (!item) return;
    $("customer-avatar").replaceChildren(avatar(item)); $("customer-title").textContent = label(item);
    const customer = item.customer || {};
    for (const field of customerFields) $(`customer-${field}`).value = customer[field] || "";
    customerTags = Array.isArray(customer.tags) ? [...customer.tags] : [];
    renderCustomerTags(); renderCustomerNotes(Array.isArray(customer.notes) ? customer.notes : []); customerStatus("");
  }
  function setCustomerBusy(value) {
    customerSaving = value;
    $("customer-form").querySelectorAll("input,textarea,select,button").forEach(control => { control.disabled = value; });
    $("customer-save").textContent = value ? "儲存中…" : "儲存客戶資料";
  }
  function updateCustomer(customer) {
    const item = conversations.get(selected);
    if (!item) return;
    conversations.set(selected, { ...item, customer });
    showConversations(); showCustomerPanel();
  }
  async function api(path, options = {}) {
    const currentEpoch = epoch, currentUser = user, signal = controller.signal;
    if (!active || !currentUser) throw new DOMException("Inactive", "AbortError");
    const token = await currentUser.getIdToken();
    if (currentEpoch !== epoch) throw new DOMException("Session changed", "AbortError");
    const response = await fetch(`/api/line/${path}`, { ...options, signal, cache: "no-store", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({ error: "LINE 接收服務尚未部署。本機靜態預覽不支援 OA 連線，請於後端部署後使用正式網站。" }));
    if (currentEpoch !== epoch) throw new DOMException("Session changed", "AbortError");
    if (!response.ok || data.error) { const error = new Error(data.error || "LINE 服務暫時無法使用。"); error.status = response.status; throw error; }
    return data;
  }
  function report(error) { if (error.name !== "AbortError") status(error.message, true); }
  function showAccount() {
    $("line-account").hidden = $("line-inbox").hidden = !channel;
    $("line-connect-form").hidden = !!channel;
    $("line-settings-toggle").setAttribute("aria-expanded", "false");
    $("inbox-settings").open = !channel;
    replyControls();
    if (!channel) return;
    $("line-oa-name").textContent = `${channel.displayName} ${channel.basicId}`;
    $("line-oa-state").textContent = channel.verifiedAt ? "Webhook 已接通" : "等待 Webhook 驗證";
    $("line-oa-state").classList.toggle("active", !!channel.verifiedAt);
    $("line-webhook-url").value = channel.webhookUrl;
    $("line-channel-id").value = channel.channelId;
    $("line-channel-id").readOnly = true;
  }
  function showConversations() {
    $("line-conversations").replaceChildren();
    $("line-empty").hidden = conversations.size > 0;
    for (const item of [...conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "conversation-item";
      button.setAttribute("aria-pressed", String(selected === item.id));
      const name = document.createElement("strong"), preview = document.createElement("span"), time = document.createElement("time");
      name.textContent = label(item); preview.textContent = item.lastText;
      time.dateTime = new Date(item.updatedAt).toISOString(); time.textContent = formatConversationTime(item.updatedAt);
      const details = document.createElement("span"); details.className = "conversation-details";
      preview.className = "conversation-preview";
      const heading = document.createElement("span"); heading.className = "conversation-title-row"; heading.append(name, time);
      details.append(heading, preview); button.append(avatar(item), details);
      button.addEventListener("click", () => selectConversation(item.id));
      $("line-conversations").append(button);
    }
    $("line-more-conversations").hidden = !conversationNext;
    showConversationHeader();
  }
  const trustedMediaUrl = attachment => {
    try {
      const url = new URL(attachment.url, location.origin);
      return url.origin === "https://planning-with-ai-52d58.web.app" && url.pathname.startsWith("/api/line/media/") ? url : null;
    } catch { return null; }
  };
  let viewerItems = [], viewerIndex = 0;
  function renderImageViewer() {
    const current = viewerItems[viewerIndex];
    if (!current) return;
    $("line-image-full").src = current.url.href; $("line-image-full").alt = current.name;
    $("line-image-caption").textContent = current.name;
    $("line-image-prev").hidden = $("line-image-next").hidden = viewerItems.length < 2;
  }
  function openImageViewer(id) {
    viewerItems = [...messages.values()]
      .sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id))
      .filter(item => item.attachment?.kind === "image" && item.attachment.expiresAt > Date.now() && trustedMediaUrl(item.attachment))
      .map(item => ({ id: item.id, name: item.attachment.name, url: trustedMediaUrl(item.attachment) }));
    viewerIndex = Math.max(0, viewerItems.findIndex(item => item.id === id));
    if (!viewerItems.length) return;
    renderImageViewer(); $("line-image-viewer").showModal();
  }
  function moveImageViewer(step) {
    if (viewerItems.length < 2) return;
    viewerIndex = (viewerIndex + step + viewerItems.length) % viewerItems.length; renderImageViewer();
  }
  function showMessages(scrollMode = "auto") {
    const previousTop = messageArea.scrollTop, previousHeight = messageArea.scrollHeight;
    const scrollToLatest = scrollMode === "bottom" || (scrollMode === "auto" && followLatest);
    messageResize.disconnect();
    $("line-messages").replaceChildren();
    let renderedDay = null;
    for (const item of [...messages.values()].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id))) {
      const itemDay = dayKey(item.sentAt);
      if (itemDay !== renderedDay) {
        const divider = document.createElement("div"), label = document.createElement("span");
        divider.className = "message-date-divider"; divider.setAttribute("role", "separator");
        label.textContent = formatDay(item.sentAt); divider.append(label); $("line-messages").append(divider);
        renderedDay = itemDay;
      }
      const bubble = document.createElement("article"), text = document.createElement("p"), time = document.createElement("time");
      bubble.className = `message-bubble${item.unsent ? " unsent" : ""}${item.direction === "outgoing" ? " outgoing" : ""}`;
      text.textContent = item.text; time.textContent = formatClock(item.sentAt); time.dateTime = new Date(item.sentAt).toISOString();
      bubble.append(text, time);
      if (item.type === "image" && !item.attachment && !item.unsent) {
        const note = document.createElement("p"); note.className = "note";
        note.textContent = item.imageNote || "正在讀取 LINE 圖片…"; bubble.append(note);
      }
      if (item.attachment) {
        const link = document.createElement("a");
        const url = trustedMediaUrl(item.attachment);
        if (url) {
          let imageMeta = null;
          link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
          link.textContent = `📎 ${item.attachment.name}`; link.className = "message-attachment";
          if (item.attachment.expiresAt <= Date.now()) { link.removeAttribute("href"); link.textContent += "（連結已過期）"; }
          else if (item.attachment.kind === "image") {
            const img = document.createElement("img"); img.src = url.href; img.alt = item.attachment.name; img.loading = "lazy";
            img.addEventListener("error", () => { img.remove(); link.textContent = `圖片暫時無法預覽，點此開啟：${item.attachment.name}`; }, { once: true }); link.prepend(img);
            link.replaceChildren(img); link.classList.add("image-attachment"); link.setAttribute("aria-label", `開啟圖片：${item.attachment.name}`);
            link.addEventListener("click", event => { event.preventDefault(); openImageViewer(item.id); });
            bubble.classList.add("image-message");
            if (item.text === "[圖片]") text.hidden = true;
            imageMeta = document.createElement("div"); const sender = document.createElement("strong");
            const actor = item.direction === "outgoing" ? { displayName: "你" } : conversations.get(selected) || { displayName: "LINE 使用者" };
            imageMeta.className = "image-message-meta"; sender.textContent = item.direction === "outgoing" ? "你" : label(actor);
            imageMeta.append(avatar(actor), sender, time);
          }
          bubble.prepend(link);
          if (imageMeta) bubble.prepend(imageMeta);
        }
      }
      if (item.direction === "outgoing" && ["failed", "uncertain"].includes(item.status)) {
        const delivery = document.createElement("p"); delivery.className = "delivery-state";
        delivery.textContent = item.status === "failed" ? "傳送失敗" : "傳送結果無法確認";
        if (item.note) delivery.title = item.note;
        bubble.append(delivery);
        if (item.status === "uncertain") {
          const retry = document.createElement("button"); retry.type = "button"; retry.className = "retry";
          retry.textContent = "重試確認"; retry.disabled = sending || !channel?.canReply || Date.now() - item.sentAt >= 23 * 60 * 60 * 1000;
          retry.addEventListener("click", () => void sendReply(selected, item.text, item.operationId, item.attachment)); bubble.append(retry);
        }
        if (item.status !== "sent" && item.note) { const note = document.createElement("p"); note.className = "note"; note.textContent = item.note; bubble.append(note); }
      }
      $("line-messages").append(bubble);
    }
    $("line-more-messages").hidden = !messageNext;
    followLatest = scrollToLatest;
    messageArea.scrollTop = scrollToLatest ? messageArea.scrollHeight : scrollMode === "older" ? previousTop + messageArea.scrollHeight - previousHeight : previousTop;
    messageResize.observe(messageArea);
    for (const bubble of messageArea.children) messageResize.observe(bubble);
  }
  async function loadMessages(older = false, scrollMode = "auto") {
    const id = selected;
    if (!id) return;
    const data = await api(`conversations/${id}/messages${older && messageNext ? `?before=${encodeURIComponent(messageNext)}` : ""}`);
    if (selected !== id) return;
    if (older) historyMode(true);
    // Refresh replaces the window, including any retracted messages.
    if (!older) messages.clear();
    for (const item of data.items) messages.set(item.id, item);
    for (const [operationId, local] of localReplies) {
      if (local.conversationId !== id) continue;
      if (!messages.has(local.message.id)) messages.set(local.message.id, local.message);
      else if (["sent", "failed"].includes(messages.get(local.message.id).status)) localReplies.delete(operationId);
    }
    messageNext = data.next; showMessages(older ? "older" : scrollMode);
  }
  async function selectConversation(id) {
    selected = id; messages.clear(); messageNext = null;
    historyMode(false);
    $("line-reply-text").value = drafts.get(id) || ""; replyControls();
    $("line-conversation-title").textContent = label(conversations.get(id));
    showConversations(); showMessages(); showCustomerPanel();
    try { await loadMessages(false, "bottom"); } catch (error) { report(error); }
  }
  async function refresh(more = false) {
    if (refreshing || !channel || !active || saving) return;
    const currentEpoch = epoch;
    refreshing = true; $("line-refresh").disabled = true;
    try {
      const [account, data] = await Promise.all([api("account"), api(`conversations${more && conversationNext ? `?before=${encodeURIComponent(conversationNext)}` : ""}`)]);
      channel = account.channel;
      replyControls();
      if (channel) {
        $("line-oa-state").textContent = channel.verifiedAt ? "Webhook 已接通" : "等待 Webhook 驗證";
        $("line-oa-state").classList.toggle("active", !!channel.verifiedAt);
      }
      if (!more) conversations.clear();
      for (const item of data.items) conversations.set(item.id, item);
      conversationNext = data.next; showConversations();
      if (more) historyMode(true);
      await loadMessages();
      status("");
    } catch (error) { report(error); }
    finally { if (currentEpoch === epoch) { refreshing = false; $("line-refresh").disabled = false; } }
  }
  async function start() {
    const currentEpoch = epoch;
    status("正在讀取 OA 連線狀態…");
    try {
      channel = (await api("account")).channel;
      showAccount();
      if (channel) await refresh();
      else status("連接 OA 後即可開始接收新訊息。");
      if (currentEpoch === epoch) timer = setInterval(() => { if (!document.hidden && !browsingHistory) void refresh(); }, 10000);
    } catch (error) { report(error); }
  }
  async function sendReply(conversationId, text, operationId, attachment) {
    if (sending || !active || !channel?.canReply || !conversationId || (!text.trim() && !attachment)) return;
    const isRetry = !!operationId;
    operationId ||= crypto.randomUUID();
    const currentEpoch = epoch;
    sending = true; replyControls(); showMessages();
    const initial = { id: `out-${operationId}`, operationId, text, ...(attachment ? { attachment } : {}), direction: "outgoing", type: attachment?.kind || "text", status: "pending", sentAt: localReplies.get(operationId)?.message.sentAt || messages.get(`out-${operationId}`)?.sentAt || Date.now() };
    localReplies.set(operationId, { conversationId, message: initial });
    if (selected === conversationId) { historyMode(false); messages.set(initial.id, initial); showMessages("bottom"); }
    try {
      const data = await api(`conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ text, operationId, attachmentId: attachment?.id || null }) });
      localReplies.set(operationId, { conversationId, message: data.message });
      if (selected === conversationId) { messages.set(data.message.id, data.message); showMessages(); }
      status(data.message.status === "sent" ? "" : data.message.note || "傳送狀態待確認。", data.message.status !== "sent");
    } catch (error) {
      if (currentEpoch !== epoch) return;
      if (error.status && error.status < 500 && !isRetry) {
        localReplies.delete(operationId); messages.delete(initial.id);
        if (!drafts.get(conversationId)) { drafts.set(conversationId, text); if (selected === conversationId) $("line-reply-text").value = text; }
        if (attachment && !attachments.has(conversationId)) attachments.set(conversationId, attachment);
      } else {
        const uncertain = { ...initial, status: "uncertain", note: "連線中斷，請用「重試確認」查看結果，避免另發同一則訊息。" };
        localReplies.set(operationId, { conversationId, message: uncertain });
        if (selected === conversationId) messages.set(initial.id, uncertain);
      }
      report(error);
    } finally { if (currentEpoch === epoch) { sending = false; replyControls(); showMessages(); } }
  }
  async function uploadFile(file, kind) {
    if (!file || uploading || sending || !selected || !active || !channel?.canReply) return;
    const conversationId = selected, currentEpoch = epoch;
    uploading = true; replyControls();
    try {
      if (file.size > (kind === "image" ? 20 : 5) * 1024 * 1024) throw new Error(kind === "image" ? "原始圖片請小於 20 MB。" : "文件請小於 5 MB。");
      let blob = file, name = file.name;
      if (kind === "image") {
        const bitmap = await createImageBitmap(file);
        try {
          const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          for (const quality of [0.85, 0.65, 0.45]) {
            blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
            if (blob && blob.size <= 1024 * 1024) break;
          }
          if (!blob || blob.size > 1024 * 1024) throw new Error("圖片壓縮後仍太大，請選擇較小圖片。");
          name = `${file.name.replace(/\.[^.]+$/, "").slice(0, 145)}.jpg`;
        } finally { bitmap.close(); }
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      if (currentEpoch !== epoch) return;
      const data = await api(`conversations/${conversationId}/attachments`, { method: "POST", body: JSON.stringify({ name, kind, data: btoa(binary) }) });
      attachments.set(conversationId, data.attachment);
      status("附件已準備好，按傳送後才會送給對方。");
    } catch (error) { if (currentEpoch === epoch) report(error); }
    finally { if (currentEpoch === epoch) { uploading = false; replyControls(); } }
  }
  for (const kind of ["image", "file"]) {
    $(`line-pick-${kind}`).addEventListener("click", () => $(`line-${kind}-input`).click());
    $(`line-${kind}-input`).addEventListener("change", event => { const file = event.target.files[0]; event.target.value = ""; void uploadFile(file, kind); });
  }
  $("customer-toggle").addEventListener("click", () => {
    const open = $("customer-panel").classList.toggle("open");
    $("customer-toggle").setAttribute("aria-expanded", String(open));
  });
  $("customer-close").addEventListener("click", () => { $("customer-panel").classList.remove("open"); $("customer-toggle").setAttribute("aria-expanded", "false"); });
  function addCustomerTag() {
    const input = $("customer-tag"), tag = input.value.trim();
    if (!tag || customerTags.includes(tag)) { input.value = ""; return; }
    if (customerTags.length >= 20) { customerStatus("標籤最多 20 個。", true); return; }
    customerTags.push(tag); input.value = ""; renderCustomerTags(); customerStatus("尚未儲存");
  }
  $("customer-add-tag").addEventListener("click", addCustomerTag);
  $("customer-tag").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addCustomerTag(); } });
  $("customer-form").addEventListener("submit", async event => {
    event.preventDefault();
    const conversationId = selected;
    if (!conversationId || customerSaving) return;
    const payload = Object.fromEntries(customerFields.map(field => [field, $(`customer-${field}`).value])); payload.tags = customerTags;
    setCustomerBusy(true); customerStatus("正在儲存…");
    try {
      const data = await api(`conversations/${conversationId}/customer`, { method: "PUT", body: JSON.stringify(payload) });
      if (selected === conversationId) { updateCustomer(data.customer); customerStatus("已儲存"); }
    } catch (error) { if (selected === conversationId) customerStatus(error.message, true); }
    finally { setCustomerBusy(false); }
  });
  $("customer-add-note").addEventListener("click", async () => {
    const conversationId = selected, input = $("customer-note"), text = input.value.trim();
    if (!conversationId || !text || customerSaving) return;
    setCustomerBusy(true); customerStatus("正在新增記事…");
    try {
      const data = await api(`conversations/${conversationId}/customer/notes`, { method: "POST", body: JSON.stringify({ text }) });
      if (selected === conversationId) { input.value = ""; updateCustomer(data.customer); customerStatus("記事已新增"); }
    } catch (error) { if (selected === conversationId) customerStatus(error.message, true); }
    finally { setCustomerBusy(false); }
  });
  $("line-remove-attachment").addEventListener("click", () => { attachments.delete(selected); replyControls(); });
  $("line-pick-emoji").addEventListener("click", () => {
    $("line-emoji-panel").hidden = !$("line-emoji-panel").hidden;
    $("line-pick-emoji").setAttribute("aria-expanded", String(!$("line-emoji-panel").hidden));
  });
  for (const emoji of ["😀", "😊", "😄", "🥰", "😍", "😂", "🥹", "😅", "🤔", "😢", "🙏", "👍", "👏", "🙌", "👌", "💪", "❤️", "💚", "🎉", "✨", "🔥", "✅", "📌", "☕"]) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = emoji; button.setAttribute("aria-label", `插入 ${emoji}`);
    button.addEventListener("click", () => {
      const input = $("line-reply-text"); if (input.disabled || input.value.length + emoji.length > 5000) return;
      input.setRangeText(emoji, input.selectionStart, input.selectionEnd, "end"); drafts.set(selected, input.value); input.focus();
      $("line-emoji-panel").hidden = true; $("line-pick-emoji").setAttribute("aria-expanded", "false");
    });
    $("line-emoji-panel").append(button);
  }
  let composingReply = false;
  $("line-reply-text").addEventListener("compositionstart", () => { composingReply = true; });
  $("line-reply-text").addEventListener("compositionend", () => { composingReply = false; });
  $("line-reply-text").addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if (composingReply || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat) $("line-reply-form").requestSubmit();
  });
  $("line-reply-text").addEventListener("input", () => { if (selected) drafts.set(selected, $("line-reply-text").value); });
  $("line-reply-form").addEventListener("submit", event => {
    event.preventDefault();
    const text = $("line-reply-text").value;
    const attachment = attachments.get(selected);
    if (sending || uploading || !selected || !channel?.canReply || (!text.trim() && !attachment) || text.length > 5000) return;
    drafts.delete(selected); $("line-reply-text").value = "";
    attachments.delete(selected);
    void sendReply(selected, text, undefined, attachment);
  });
  $("line-connect-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (saving || !active) return;
    const currentEpoch = epoch;
    saving = true; $("line-connect-fields").disabled = true;
    replyControls();
    status("正在向 LINE 驗證 OA 身分…");
    const body = JSON.stringify({ channelId: $("line-channel-id").value.trim(), channelSecret: $("line-channel-secret").value.trim(), accessToken: $("line-access-token").value.trim() });
    clearSecrets();
    try {
      channel = (await api("account", { method: "POST", body })).channel;
      showAccount(); status("OA 已綁定。請將上方網址填入 LINE Developers，按 Verify 完成接通。");
    } catch (error) { report(error); }
    finally { if (currentEpoch === epoch) { saving = false; $("line-connect-fields").disabled = false; replyControls(); } }
  });
  $("line-settings-toggle").addEventListener("click", () => {
    $("line-connect-form").hidden = !$("line-connect-form").hidden;
    $("line-settings-toggle").setAttribute("aria-expanded", String(!$("line-connect-form").hidden)); clearSecrets();
  });
  $("line-refresh").addEventListener("click", () => { historyMode(false); void refresh(); });
  $("line-more-conversations").addEventListener("click", () => void refresh(true));
  $("line-more-messages").addEventListener("click", async () => { try { await loadMessages(true); } catch (error) { report(error); } });
  $("line-image-close").addEventListener("click", () => $("line-image-viewer").close());
  $("line-image-prev").addEventListener("click", () => moveImageViewer(-1));
  $("line-image-next").addEventListener("click", () => moveImageViewer(1));
  $("line-image-viewer").addEventListener("click", event => { if (event.target === $("line-image-viewer")) $("line-image-viewer").close(); });
  $("line-image-viewer").addEventListener("close", () => { $("line-image-full").removeAttribute("src"); viewerItems = []; });
  $("line-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("line-webhook-url").value); status("已複製 Webhook URL。"); }
    catch { $("line-webhook-url").select(); status("請手動複製已選取的網址。"); }
  });
  window.addEventListener("pagehide", () => { clearSecrets(); controller?.abort(); clearInterval(timer); messageResize.disconnect(); });
  return {
    setSession(nextUser, visible) {
      const nextActive = !!nextUser && visible;
      if (user?.uid === nextUser?.uid && active === nextActive) { user = nextUser; return; }
      epoch++; controller?.abort(); clearInterval(timer); controller = new AbortController();
      messageResize.disconnect(); followLatest = true;
      user = nextUser; active = nextActive; channel = null; selected = null; refreshing = false; saving = false;
      sending = false; uploading = false; customerSaving = false; customerTags = []; attachments.clear(); drafts.clear(); localReplies.clear(); $("line-reply-text").value = ""; replyControls();
      $("line-emoji-panel").hidden = true; $("line-pick-emoji").setAttribute("aria-expanded", "false");
      conversationNext = messageNext = null; conversations.clear(); messages.clear(); clearSecrets();
      historyMode(false);
      $("line-oa-name").textContent = $("line-webhook-url").value = $("line-channel-id").value = "";
      $("line-conversation-title").textContent = "選擇一段對話";
      $("customer-panel").hidden = true; $("customer-panel").classList.remove("open"); $("customer-toggle").setAttribute("aria-expanded", "false");
      $("line-channel-id").readOnly = false; $("line-connect-fields").disabled = false; $("line-refresh").disabled = false;
      $("line-account").hidden = $("line-inbox").hidden = $("line-connect-form").hidden = true;
      showConversations(); showMessages(); status("");
      if (active) void start();
    },
  };
}
