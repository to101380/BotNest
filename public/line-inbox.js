const $ = id => document.getElementById(id);
const formatTime = value => new Date(value).toLocaleString("zh-TW", { hour12: false });
export function createLineInbox() {
  let user = null, active = false, epoch = 0, controller, timer, channel = null;
  let selected = null, conversationNext = null, messageNext = null, refreshing = false, saving = false, browsingHistory = false;
  const conversations = new Map(), messages = new Map();
  const status = (text, error = false) => { $("line-status").textContent = text; $("line-status").classList.toggle("error", error); };
  const clearSecrets = () => { $("line-channel-secret").value = $("line-access-token").value = ""; };
  function historyMode(value) {
    browsingHistory = value;
    $("line-polling-note").textContent = value ? "正在瀏覽較早紀錄，自動更新已暫停；按「重新整理」回到最新訊息。" : "每 10 秒更新。";
  }
  const label = item => `${({ user: "使用者", group: "群組", room: "聊天室" })[item.sourceType] || "對話"} · ${item.sourceId.slice(-8)}`;
  async function api(path, options = {}) {
    const currentEpoch = epoch, currentUser = user, signal = controller.signal;
    if (!active || !currentUser) throw new DOMException("Inactive", "AbortError");
    const token = await currentUser.getIdToken();
    if (currentEpoch !== epoch) throw new DOMException("Session changed", "AbortError");
    const response = await fetch(`/api/line/${path}`, { ...options, signal, cache: "no-store", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({ error: "LINE 接收服務尚未部署。本機靜態預覽不支援 OA 連線，請於後端部署後使用正式網站。" }));
    if (currentEpoch !== epoch) throw new DOMException("Session changed", "AbortError");
    if (!response.ok || data.error) throw new Error(data.error || "LINE 服務暫時無法使用。");
    return data;
  }
  function report(error) { if (error.name !== "AbortError") status(error.message, true); }
  function showAccount() {
    $("line-account").hidden = $("line-inbox").hidden = !channel;
    $("line-connect-form").hidden = !!channel;
    $("line-settings-toggle").setAttribute("aria-expanded", "false");
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
      time.dateTime = new Date(item.updatedAt).toISOString(); time.textContent = formatTime(item.updatedAt);
      button.append(name, preview, time);
      button.addEventListener("click", () => selectConversation(item.id));
      $("line-conversations").append(button);
    }
    $("line-more-conversations").hidden = !conversationNext;
  }
  function showMessages() {
    $("line-messages").replaceChildren();
    for (const item of [...messages.values()].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id))) {
      const bubble = document.createElement("article"), text = document.createElement("p"), time = document.createElement("time");
      bubble.className = `message-bubble${item.unsent ? " unsent" : ""}`;
      text.textContent = item.text; time.textContent = formatTime(item.sentAt); time.dateTime = new Date(item.sentAt).toISOString();
      bubble.append(text, time); $("line-messages").append(bubble);
    }
    $("line-more-messages").hidden = !messageNext;
  }
  async function loadMessages(older = false) {
    const id = selected;
    if (!id) return;
    const data = await api(`conversations/${id}/messages${older && messageNext ? `?before=${encodeURIComponent(messageNext)}` : ""}`);
    if (selected !== id) return;
    if (older) historyMode(true);
    // Refresh replaces the window, including any retracted messages.
    if (!older) messages.clear();
    for (const item of data.items) messages.set(item.id, item);
    messageNext = data.next; showMessages();
  }
  async function selectConversation(id) {
    selected = id; messages.clear(); messageNext = null;
    $("line-conversation-title").textContent = label(conversations.get(id));
    showConversations(); showMessages();
    try { await loadMessages(); } catch (error) { report(error); }
  }
  async function refresh(more = false) {
    if (refreshing || !channel || !active || saving) return;
    const currentEpoch = epoch;
    refreshing = true; $("line-refresh").disabled = true;
    try {
      const [account, data] = await Promise.all([api("account"), api(`conversations${more && conversationNext ? `?before=${encodeURIComponent(conversationNext)}` : ""}`)]);
      channel = account.channel;
      if (channel) {
        $("line-oa-state").textContent = channel.verifiedAt ? "Webhook 已接通" : "等待 Webhook 驗證";
        $("line-oa-state").classList.toggle("active", !!channel.verifiedAt);
      }
      if (!more) conversations.clear();
      for (const item of data.items) conversations.set(item.id, item);
      conversationNext = data.next; showConversations();
      if (more) historyMode(true);
      await loadMessages();
      status(`已更新 · ${new Date().toLocaleTimeString("zh-TW", { hour12: false })}`);
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
  $("line-connect-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (saving || !active) return;
    const currentEpoch = epoch;
    saving = true; $("line-connect-fields").disabled = true;
    status("正在向 LINE 驗證 OA 身分…");
    const body = JSON.stringify({ channelId: $("line-channel-id").value.trim(), channelSecret: $("line-channel-secret").value.trim(), accessToken: $("line-access-token").value.trim() });
    clearSecrets();
    try {
      channel = (await api("account", { method: "POST", body })).channel;
      showAccount(); status("OA 已綁定。請將上方網址填入 LINE Developers，按 Verify 完成接通。");
    } catch (error) { report(error); }
    finally { if (currentEpoch === epoch) { saving = false; $("line-connect-fields").disabled = false; } }
  });
  $("line-settings-toggle").addEventListener("click", () => {
    $("line-connect-form").hidden = !$("line-connect-form").hidden;
    $("line-settings-toggle").setAttribute("aria-expanded", String(!$("line-connect-form").hidden)); clearSecrets();
  });
  $("line-refresh").addEventListener("click", () => { historyMode(false); void refresh(); });
  $("line-more-conversations").addEventListener("click", () => void refresh(true));
  $("line-more-messages").addEventListener("click", async () => { try { await loadMessages(true); } catch (error) { report(error); } });
  $("line-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("line-webhook-url").value); status("已複製 Webhook URL。"); }
    catch { $("line-webhook-url").select(); status("請手動複製已選取的網址。"); }
  });
  window.addEventListener("pagehide", () => { clearSecrets(); controller?.abort(); clearInterval(timer); });
  return {
    setSession(nextUser, visible) {
      const nextActive = !!nextUser && visible;
      if (user?.uid === nextUser?.uid && active === nextActive) { user = nextUser; return; }
      epoch++; controller?.abort(); clearInterval(timer); controller = new AbortController();
      user = nextUser; active = nextActive; channel = null; selected = null; refreshing = false; saving = false;
      conversationNext = messageNext = null; conversations.clear(); messages.clear(); clearSecrets();
      historyMode(false);
      $("line-oa-name").textContent = $("line-webhook-url").value = $("line-channel-id").value = "";
      $("line-conversation-title").textContent = "選擇一段對話";
      $("line-channel-id").readOnly = false; $("line-connect-fields").disabled = false; $("line-refresh").disabled = false;
      $("line-account").hidden = $("line-inbox").hidden = $("line-connect-form").hidden = true;
      showConversations(); showMessages(); status("");
      if (active) void start();
    },
  };
}
