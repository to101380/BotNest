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
  let user = null, active = false, pageMode = null, epoch = 0, controller, timer, channel = null;
  let selected = null, conversationNext = null, zernioConversationNext = null, messageNext = null, refreshing = false, saving = false, browsingHistory = false;
  const conversations = new Map(), messages = new Map();
  const drafts = new Map(), localReplies = new Map();
  const attachments = new Map();
  let sending = false, uploading = false, customerSaving = false, aiSaving = false, zernioBusy = false, facebookAccount = null;
  let customerTags = [];
  let customerSaveTimer = null, pendingCustomerSave = null, customerSaveRevision = 0;
  let customerSaveChain = Promise.resolve();
  let followLatest = true;
  const messageArea = $("line-messages");
  messageArea.addEventListener("scroll", () => {
    followLatest = messageArea.scrollHeight - messageArea.clientHeight - messageArea.scrollTop < 40;
  }, { passive: true });
  const messageResize = new ResizeObserver(() => {
    if (active && followLatest) messageArea.scrollTop = messageArea.scrollHeight;
  });
  function replyControls() {
    const current = conversations.get(selected), facebook = current?.provider === "facebook";
    const canReply = facebook ? !!facebookAccount : !!channel?.canReply;
    const enabled = active && !!selected && canReply && !saving && !sending && !uploading;
    $("line-reply-text").disabled = $("line-send").disabled = !enabled;
    for (const id of ["line-pick-image", "line-pick-file", "line-remove-attachment"]) $(id).disabled = !enabled || facebook;
    $("line-pick-emoji").disabled = !enabled;
    $("line-attachment-preview").hidden = !attachments.has(selected) && !uploading;
    $("line-attachment-name").textContent = uploading ? "正在準備附件…" : attachments.has(selected) ? `${attachments.get(selected).kind === "image" ? "圖片" : "文件"}：${attachments.get(selected).name}（待傳送）` : "";
    $("line-send").textContent = sending ? "傳送中…" : "傳送回覆";
    $("line-reply-hint").textContent = !selected ? "先選擇一段對話。" : !canReply ? "請先到渠道設定完成連線。" : facebook ? "Facebook 文字回覆 · 最多 5000 字" : "最多 5000 字";
    $("reply-channel-note").textContent = facebook ? "Enter 傳送，Shift＋Enter 換行。回覆會透過 Facebook Messenger 傳送。" : "Enter 傳送，Shift＋Enter 換行。回覆會使用 OA 的 LINE 訊息額度。";
    $("reply-attachment-note").hidden = !!facebook;
  }
  const status = (text, error = false) => {
    for (const id of ["line-status", "channel-status"]) { $(id).textContent = text; $(id).classList.toggle("error", error); }
  };
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
    let trustedPicture = false;
    try { const url = new URL(item.pictureUrl); trustedPicture = url.protocol === "https:" && (item.provider === "facebook" ? /(^|\.)(fbcdn\.net|facebook\.com|fbsbx\.com)$/i.test(url.hostname) : /(^|\.)line-scdn\.net$/i.test(url.hostname)); } catch { /* Invalid profile image. */ }
    if (item.pictureUrl && trustedPicture) {
      const image = document.createElement("img"); image.alt = ""; image.src = item.pictureUrl;
      image.loading = "lazy"; image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true }); frame.append(image);
    }
    const badge = document.createElement("span"); badge.className = item.provider === "facebook" ? "facebook-avatar-badge" : "line-avatar-badge"; badge.title = item.provider === "facebook" ? "Facebook Messenger" : "LINE"; frame.append(badge);
    return frame;
  }
  function showConversationHeader() {
    const item = conversations.get(selected);
    $("line-chat-empty").hidden = !!item;
    $("line-chat-empty").parentElement.classList.toggle("has-conversation", !!item);
    $("line-conversation-title").textContent = item ? label(item) : "選擇一段對話";
    $("line-chat-avatar").replaceChildren(...(item ? [avatar(item)] : []));
    $("line-chat-source").textContent = item ? `來自 ${item.provider === "facebook" ? "Facebook Messenger" : "LINE"}` : "在左側選擇聊天者，開始回覆";
  }
  const customerFields = ["name", "phone", "email", "birthday", "gender", "language", "country", "city", "address", "about", "custom1", "custom2", "custom3"];
  function renderCustomerTags() {
    $("customer-tags").replaceChildren(...customerTags.map(tag => {
      const chip = document.createElement("span"); chip.className = "customer-tag";
      const text = document.createElement("span"); text.textContent = tag;
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `移除標籤 ${tag}`);
      remove.addEventListener("click", () => { customerTags = customerTags.filter(value => value !== tag); renderCustomerTags(); queueCustomerSave(); });
      chip.append(text, remove); return chip;
    }));
  }
  function renderCustomerNotes(notes = []) {
    $("customer-notes").replaceChildren(...notes.map(note => {
      const card = document.createElement("article"); card.className = "customer-note-card";
      const text = document.createElement("p"); text.textContent = note.text;
      const time = document.createElement("time"); time.dateTime = new Date(note.createdAt).toISOString(); time.textContent = new Date(note.createdAt).toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" });
      const footer = document.createElement("div"); footer.className = "customer-note-footer";
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "customer-note-delete"; remove.textContent = "×"; remove.title = "刪除記事"; remove.setAttribute("aria-label", `刪除記事：${note.text.slice(0, 30)}`);
      remove.addEventListener("click", async () => {
        const conversationId = selected;
        if (!conversationId || customerSaving || !confirm("確定要刪除這則記事嗎？刪除後無法復原。")) return;
        await flushCustomerSave();
        if (selected !== conversationId) return;
        setCustomerBusy(true); customerStatus("正在刪除記事…");
        try {
          const data = await customerRequest(conversationId, `/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
          if (selected === conversationId) { updateCustomer(data.customer); customerStatus("記事已刪除"); }
        } catch (error) { if (selected === conversationId) customerStatus(error.message, true); }
        finally { setCustomerBusy(false); }
      });
      footer.append(time, remove); card.append(text, footer); return card;
    }));
  }
  function customerStatus(text, error = false) { $("customer-status").textContent = text; $("customer-status").classList.toggle("error", error); }
  function showCustomerPanel() {
    const item = conversations.get(selected), panel = $("customer-panel");
    panel.hidden = !item;
    $("customer-toggle").hidden = !item;
    if (!item) {
      panel.classList.remove("open");
      $("customer-toggle").setAttribute("aria-expanded", "false");
      return;
    }
    $("customer-avatar").replaceChildren(avatar(item)); $("customer-title").textContent = label(item);
    $("customer-source").textContent = `來自 ${item.provider === "facebook" ? "Facebook Messenger" : "LINE"}`;
    const customer = item.customer || {};
    for (const field of customerFields) $(`customer-${field}`).value = customer[field] || "";
    customerTags = Array.isArray(customer.tags) ? [...customer.tags] : [];
    renderCustomerTags(); renderCustomerNotes(Array.isArray(customer.notes) ? customer.notes : []); customerStatus("");
  }
  function setCustomerBusy(value) {
    customerSaving = value;
    $("customer-form").querySelectorAll("input,textarea,select,button").forEach(control => { control.disabled = value; });
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
  async function zernioApi(path, options = {}) {
    const currentEpoch = epoch, currentUser = user, signal = controller.signal;
    if (!active || !currentUser) throw new DOMException("Inactive", "AbortError");
    const token = await currentUser.getIdToken();
    if (currentEpoch !== epoch) throw new DOMException("Session changed", "AbortError");
    const response = await fetch(`/api/zernio/${path}`, { ...options, signal, cache: "no-store", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({ error: "Zernio 服務暫時無法使用。" }));
    if (currentEpoch !== epoch) throw new DOMException("Session changed", "AbortError");
    if (!response.ok || data.error) throw new Error(data.error || "Zernio 服務暫時無法使用。");
    return data;
  }
  function customerRequest(conversationId, suffix = "", options = {}) {
    const item = conversations.get(conversationId);
    if (item?.provider === "facebook") return zernioApi(`customer${suffix}?conversationId=${encodeURIComponent(item.remoteId)}`, options);
    return api(`conversations/${conversationId}/customer${suffix}`, options);
  }
  function showZernioAccount(data) {
    const connected = !!data.facebook;
    facebookAccount = data.facebook || null;
    $("facebook-card-state").textContent = connected ? "已連接" : data.configured ? "未連接" : "尚未設定";
    $("facebook-card-state").classList.toggle("connected", connected);
    $("facebook-page-name").textContent = connected ? data.facebook.displayName : "尚未連接 Facebook 粉絲專頁";
    $("facebook-page-detail").textContent = connected ? `@${data.facebook.username || "Facebook"} · 由 Zernio 管理連線` : data.configured ? "授權時可選擇你管理的粉絲專頁" : "請先設定 Zernio API Key";
    $("facebook-connect").textContent = connected ? "重新授權" : "使用 Facebook 授權";
    $("facebook-connect").disabled = !data.configured || zernioBusy;
    showAccount(); replyControls();
  }
  async function loadZernioAccount() {
    try {
      const data = await zernioApi("account"); showZernioAccount(data);
      const callback = new URLSearchParams(location.search).get("zernio");
      if (callback === "connected") status("Facebook Messenger 粉絲專頁已成功連接。");
      else if (callback === "error") status("Facebook 授權未完成，請重新操作。", true);
      if (callback) history.replaceState(null, "", `${location.pathname}${location.hash}`);
    } catch (error) {
      $("facebook-card-state").textContent = "讀取失敗"; $("facebook-card-state").classList.remove("connected");
      $("facebook-connect").disabled = true; report(error);
    }
  }
  function report(error) { if (error.name !== "AbortError") status(error.message, true); }
  function showAccount() {
    $("line-account").hidden = !channel;
    $("line-inbox").hidden = !channel && !facebookAccount;
    $("line-connect-form").hidden = !!channel;
    $("line-not-connected").hidden = !!channel || !!facebookAccount;
    $("line-settings-toggle").setAttribute("aria-expanded", "false");
    $("line-card-state").textContent = channel ? "已連接" : "未連接";
    $("line-card-state").classList.toggle("connected", !!channel);
    for (const control of $("ai-settings-form").querySelectorAll("input,textarea,button")) control.disabled = !channel || aiSaving;
    if (!channel) {
      $("ai-card-state").textContent = "需先連接 LINE";
      $("ai-card-state").classList.remove("connected");
      $("ai-key-state").textContent = "連接 LINE 官方帳號後即可設定。";
    }
    replyControls();
    if (!channel) return;
    $("line-oa-name").textContent = `${channel.displayName} ${channel.basicId}`;
    $("line-oa-state").textContent = channel.verifiedAt ? "Webhook 已接通" : "等待 Webhook 驗證";
    $("line-oa-state").classList.toggle("active", !!channel.verifiedAt);
    $("line-webhook-url").value = channel.webhookUrl;
    $("line-channel-id").value = channel.channelId;
    $("line-channel-id").readOnly = true;
  }
  function showAiSettings(settings) {
    $("ai-enabled").checked = !!settings.enabled;
    $("ai-instructions").value = settings.instructions || "";
    $("ai-key-state").textContent = settings.configured ? "OpenAI API 已安全設定於 Firebase 後端。" : "尚未設定 OpenAI API Key。";
    $("ai-card-state").textContent = !settings.configured ? "待設定 API Key" : settings.enabled ? "自動回覆中" : "已關閉";
    $("ai-card-state").classList.toggle("connected", !!settings.configured && !!settings.enabled);
    $("ai-reply-indicator").hidden = !(settings.configured && settings.enabled);
  }
  function aiStatus(text, error = false) {
    $("ai-settings-status").textContent = text;
    $("ai-settings-status").classList.toggle("error", error);
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
    $("line-more-conversations").hidden = !conversationNext && !zernioConversationNext;
    showConversationHeader();
  }
  const trustedMediaUrl = attachment => {
    try {
      const url = new URL(attachment.url, location.origin);
      if (url.origin === "https://planning-with-ai-52d58.web.app" && url.pathname.startsWith("/api/line/media/")) return url;
      if (attachment.external && url.protocol === "https:" && /(^|\.)fbcdn\.net$/i.test(url.hostname)) return url;
      return null;
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
          const selectedProvider = conversations.get(selected)?.provider;
          retry.textContent = "重試確認"; retry.disabled = sending || (selectedProvider === "facebook" ? !facebookAccount : !channel?.canReply) || Date.now() - item.sentAt >= 23 * 60 * 60 * 1000;
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
    const current = conversations.get(id);
    const data = current?.provider === "facebook"
      ? await zernioApi(`messages?conversationId=${encodeURIComponent(current.remoteId)}${older && messageNext ? `&cursor=${encodeURIComponent(messageNext)}` : ""}`)
      : await api(`conversations/${id}/messages${older && messageNext ? `?before=${encodeURIComponent(messageNext)}` : ""}`);
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
    flushCustomerSave();
    selected = id; messages.clear(); messageNext = null;
    historyMode(false);
    $("line-reply-text").value = drafts.get(id) || ""; replyControls();
    $("line-conversation-title").textContent = label(conversations.get(id));
    showConversations(); showMessages(); showCustomerPanel();
    const tasks = [loadMessages(false, "bottom")];
    if (conversations.get(id)?.provider === "facebook") tasks.push(customerRequest(id).then(data => {
      if (selected !== id) return;
      const item = conversations.get(id); conversations.set(id, { ...item, customer: data.customer || {} }); showCustomerPanel(); showConversations();
    }));
    const results = await Promise.allSettled(tasks);
    const failed = results.find(result => result.status === "rejected"); if (failed) report(failed.reason);
  }
  async function refresh(more = false) {
    if (refreshing || (!channel && !facebookAccount) || !active || saving) return;
    const currentEpoch = epoch;
    refreshing = true; $("line-refresh").disabled = true;
    try {
      const linePromise = channel ? Promise.all([api("account"), api(`conversations${more && conversationNext ? `?before=${encodeURIComponent(conversationNext)}` : ""}`)]) : null;
      const facebookPromise = facebookAccount ? zernioApi(`conversations${more && zernioConversationNext ? `?cursor=${encodeURIComponent(zernioConversationNext)}` : ""}`) : null;
      const [lineState, facebookState] = await Promise.allSettled([linePromise, facebookPromise]);
      const lineResult = lineState.status === "fulfilled" ? lineState.value : null;
      const facebookResult = facebookState.status === "fulfilled" ? facebookState.value : null;
      const refreshError = lineState.status === "rejected" ? lineState.reason : facebookState.status === "rejected" ? facebookState.reason : null;
      const account = lineResult?.[0], data = lineResult?.[1];
      if (account) channel = account.channel;
      replyControls();
      if (channel) {
        $("line-oa-state").textContent = channel.verifiedAt ? "Webhook 已接通" : "等待 Webhook 驗證";
        $("line-oa-state").classList.toggle("active", !!channel.verifiedAt);
      }
      if (!more) conversations.clear();
      for (const item of data?.items || []) conversations.set(item.id, item);
      for (const item of facebookResult?.items || []) conversations.set(item.id, item);
      conversationNext = data?.next || null; zernioConversationNext = facebookResult?.next || null; showConversations();
      let pendingConversation = null;
      try { pendingConversation = sessionStorage.getItem("botnest-open-conversation"); } catch { /* Storage may be unavailable. */ }
      if (pendingConversation && conversations.has(pendingConversation)) {
        try { sessionStorage.removeItem("botnest-open-conversation"); } catch { /* Storage may be unavailable. */ }
        await selectConversation(pendingConversation); status(""); return;
      }
      if (more) historyMode(true);
      await loadMessages();
      if (refreshError) report(refreshError); else status("");
    } catch (error) { report(error); }
    finally { if (currentEpoch === epoch) { refreshing = false; $("line-refresh").disabled = false; } }
  }
  async function start() {
    const currentEpoch = epoch;
    status("正在讀取 OA 連線狀態…");
    try {
      const [lineResult, zernioResult] = await Promise.allSettled([api("account"), zernioApi("account")]);
      if (lineResult.status === "fulfilled") channel = lineResult.value.channel;
      if (zernioResult.status === "fulfilled") showZernioAccount(zernioResult.value);
      showAccount();
      if (channel) {
        const ai = await api("ai-settings");
        showAiSettings(ai.settings);
        if (pageMode !== "inbox") {
          status(channel.verifiedAt ? "LINE 官方帳號已連接，Webhook 運作正常。" : "LINE 官方帳號已連接，等待 Webhook 驗證。");
        }
      } else if (!facebookAccount) status("尚未連接任何訊息渠道。請先前往渠道設定。");
      if (pageMode === "inbox" && (channel || facebookAccount)) await refresh();
      if (pageMode === "settings" && zernioResult.status === "rejected") await loadZernioAccount();
      if (currentEpoch === epoch && pageMode === "inbox") timer = setInterval(() => { if (!document.hidden && !browsingHistory) void refresh(); }, 10000);
    } catch (error) { report(error); }
  }
  async function sendReply(conversationId, text, operationId, attachment) {
    const currentConversation = conversations.get(conversationId), facebook = currentConversation?.provider === "facebook";
    const canReply = facebook ? !!facebookAccount : !!channel?.canReply;
    if (sending || !active || !canReply || !conversationId || (!text.trim() && !attachment) || (facebook && attachment)) return;
    const isRetry = !!operationId;
    operationId ||= crypto.randomUUID();
    const currentEpoch = epoch;
    sending = true; replyControls(); showMessages();
    const initial = { id: `out-${operationId}`, operationId, text, ...(attachment ? { attachment } : {}), direction: "outgoing", type: attachment?.kind || "text", status: "pending", sentAt: localReplies.get(operationId)?.message.sentAt || messages.get(`out-${operationId}`)?.sentAt || Date.now() };
    localReplies.set(operationId, { conversationId, message: initial });
    if (selected === conversationId) { historyMode(false); messages.set(initial.id, initial); showMessages("bottom"); }
    try {
      const data = facebook
        ? await zernioApi("messages", { method: "POST", body: JSON.stringify({ conversationId: currentConversation.remoteId, text, operationId }) })
        : await api(`conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ text, operationId, attachmentId: attachment?.id || null }) });
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
    if (!file || uploading || sending || !selected || !active || !channel?.canReply || conversations.get(selected)?.provider === "facebook") return;
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
    customerTags.push(tag); input.value = ""; renderCustomerTags(); queueCustomerSave();
  }
  $("customer-add-tag").addEventListener("click", addCustomerTag);
  $("customer-tag").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addCustomerTag(); } });
  function customerPayload() {
    const payload = Object.fromEntries(customerFields.map(field => [field, $(`customer-${field}`).value]));
    payload.tags = [...customerTags];
    return payload;
  }
  function persistCustomer(task) {
    customerSaveChain = customerSaveChain.catch(() => {}).then(async () => {
      if (!active || !user) return;
      if (selected === task.conversationId && task.revision === customerSaveRevision) customerStatus("自動儲存中…");
      try {
        const data = await customerRequest(task.conversationId, "", { method: "PUT", body: JSON.stringify(task.payload) });
        const item = conversations.get(task.conversationId);
        if (item) { conversations.set(task.conversationId, { ...item, customer: data.customer }); showConversations(); }
        if (selected === task.conversationId && task.revision === customerSaveRevision) customerStatus("已自動儲存");
      } catch (error) {
        if (selected === task.conversationId && task.revision === customerSaveRevision) customerStatus(error.message, true);
      }
    });
    return customerSaveChain;
  }
  function queueCustomerSave(delay = 700) {
    if (!selected || customerSaving) return;
    pendingCustomerSave = { conversationId: selected, payload: customerPayload(), revision: ++customerSaveRevision };
    clearTimeout(customerSaveTimer);
    customerSaveTimer = setTimeout(flushCustomerSave, delay);
    customerStatus("等待自動儲存…");
  }
  function flushCustomerSave() {
    clearTimeout(customerSaveTimer); customerSaveTimer = null;
    const task = pendingCustomerSave; pendingCustomerSave = null;
    return task ? persistCustomer(task) : customerSaveChain;
  }
  $("customer-form").addEventListener("input", event => {
    if (customerFields.includes(event.target.name)) queueCustomerSave();
  });
  $("customer-form").addEventListener("change", event => {
    if (customerFields.includes(event.target.name)) queueCustomerSave(0);
  });
  $("customer-form").addEventListener("submit", event => {
    event.preventDefault();
    queueCustomerSave(0);
  });
  $("customer-add-note").addEventListener("click", async () => {
    const conversationId = selected, input = $("customer-note"), text = input.value.trim();
    if (!conversationId || !text || customerSaving) return;
    await flushCustomerSave();
    if (selected !== conversationId) return;
    setCustomerBusy(true); customerStatus("正在新增記事…");
    try {
      const data = await customerRequest(conversationId, "/notes", { method: "POST", body: JSON.stringify({ text }) });
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
    const current = conversations.get(selected), canReply = current?.provider === "facebook" ? !!facebookAccount : !!channel?.canReply;
    if (sending || uploading || !selected || !canReply || (!text.trim() && !attachment) || text.length > 5000) return;
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
  $("ai-settings-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!channel || aiSaving) return;
    aiSaving = true; showAccount(); aiStatus("正在儲存…");
    try {
      const data = await api("ai-settings", { method: "PUT", body: JSON.stringify({ enabled: $("ai-enabled").checked, instructions: $("ai-instructions").value }) });
      showAiSettings(data.settings); aiStatus("AI 自動回覆設定已儲存。");
    } catch (error) { aiStatus(error.message, true); }
    finally { aiSaving = false; showAccount(); }
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
  $("facebook-connect").addEventListener("click", async () => {
    if (zernioBusy || !active) return;
    zernioBusy = true; $("facebook-connect").disabled = true; $("facebook-connect").textContent = "正在開啟授權…";
    try {
      const data = await zernioApi("connect/facebook", { method: "POST", body: "{}" });
      location.assign(data.authUrl);
    } catch (error) { report(error); zernioBusy = false; await loadZernioAccount(); }
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushCustomerSave(); });
  window.addEventListener("pagehide", () => { clearSecrets(); controller?.abort(); clearInterval(timer); messageResize.disconnect(); });
  return {
    setSession(nextUser, nextMode) {
      const nextActive = !!nextUser && !!nextMode;
      if (user?.uid === nextUser?.uid && active === nextActive && pageMode === nextMode) { user = nextUser; return; }
      epoch++; controller?.abort(); clearInterval(timer); clearTimeout(customerSaveTimer); customerSaveTimer = null; pendingCustomerSave = null; controller = new AbortController();
      messageResize.disconnect(); followLatest = true;
      user = nextUser; active = nextActive; pageMode = nextMode; channel = null; facebookAccount = null; selected = null; refreshing = false; saving = false;
      sending = false; uploading = false; customerSaving = false; aiSaving = false; zernioBusy = false; customerTags = []; attachments.clear(); drafts.clear(); localReplies.clear(); $("line-reply-text").value = ""; replyControls();
      $("line-emoji-panel").hidden = true; $("line-pick-emoji").setAttribute("aria-expanded", "false");
      conversationNext = zernioConversationNext = messageNext = null; conversations.clear(); messages.clear(); clearSecrets();
      historyMode(false);
      $("line-oa-name").textContent = $("line-webhook-url").value = $("line-channel-id").value = "";
      $("line-conversation-title").textContent = "選擇一段對話";
      $("customer-panel").hidden = true; $("customer-panel").classList.remove("open"); $("customer-toggle").setAttribute("aria-expanded", "false");
      $("line-channel-id").readOnly = false; $("line-connect-fields").disabled = false; $("line-refresh").disabled = false;
      $("line-account").hidden = $("line-inbox").hidden = $("line-connect-form").hidden = $("line-not-connected").hidden = true;
      $("line-card-state").textContent = "讀取中"; $("line-card-state").classList.remove("connected");
      $("facebook-card-state").textContent = "讀取中"; $("facebook-card-state").classList.remove("connected"); $("facebook-connect").disabled = true;
      $("ai-enabled").checked = false; $("ai-instructions").value = ""; $("ai-card-state").textContent = "讀取中"; $("ai-card-state").classList.remove("connected"); aiStatus("");
      $("ai-reply-indicator").hidden = true;
      showConversations(); showMessages(); status("");
      if (active) void start();
    },
  };
}
