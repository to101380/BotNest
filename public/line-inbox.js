import { lineStickerUrl } from "./stickers.js";
import { messageToolbar, quotedReply } from "./message-actions.js";
import { createAudioPlayer } from "./audio-player.js";
import { createConversationWorkflow, workflowIcons } from "./conversation-workflow.js";
import { filterConversations, inboxMode } from "./inbox-filters.js";
import { showAiModel } from "./ai-model.js";
import { watchHistoryScroll } from "./history-scroll.js";
import { pollDelay, conversationVersion, needsMessageRefresh } from "./inbox-polling.js";
import { runBulkAi } from "./inbox-bulk.js";
import { installConversationLongPress } from "./inbox-long-press.js";
const $ = id => document.getElementById(id);
const isSocial = item => ["facebook", "instagram"].includes(item?.provider);
const channelName = item => item?.provider === "instagram" ? "Instagram" : item?.provider === "facebook" ? "Facebook Messenger" : "LINE";
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
  let selected = null, conversationNext = null, zernioConversationNext = null, instagramNext = null, messageNext = null, refreshing = false, saving = false, browsingHistory = false;
  let messageLoading = false, messageRequest = 0;
  let unchangedRounds = 0, lastListVersion = "", messageSnapshot = null, lastResume = 0;
  let bulkMode = false, bulkBusy = false, bulkAnchor = null;
  const bulkIds = new Set();
  function scheduleRefresh() {
    clearTimeout(timer);
    if (!active || pageMode !== "inbox" || document.hidden) return;
    const scheduledEpoch = epoch;
    timer = setTimeout(async () => {
      if (scheduledEpoch !== epoch) return;
      if (!browsingHistory) await refresh(false, false);
      if (scheduledEpoch === epoch) scheduleRefresh();
    }, pollDelay(unchangedRounds, !!selected));
  }
  function resumeRefresh() {
    if (!active || pageMode !== "inbox" || document.hidden || browsingHistory || Date.now() - lastResume < 1000) return;
    lastResume = Date.now(); unchangedRounds = 0;
    clearTimeout(timer);
    const resumedEpoch = epoch;
    void refresh(false, true).finally(() => { if (resumedEpoch === epoch) scheduleRefresh(); });
  }
  const conversations = new Map(), messages = new Map();
  const workflow = createConversationWorkflow({ request: options => aiApi("workflow", options), changed: () => { if (active) { showConversations(); if (selected) showMessages("keep"); } }, feedback: text => status(text), getUser: () => user });
  const quoteDrafts = new Map();
  const actionStyle = document.createElement("link"); actionStyle.rel = "stylesheet"; actionStyle.href = "/message-actions.css"; document.head.append(actionStyle);
  const quotePanel = document.createElement("div"); quotePanel.className = "message-quote-composer"; quotePanel.hidden = true;
  const quoteLabel = document.createElement("span"), quoteCancel = document.createElement("button"); quoteCancel.type = "button"; quoteCancel.textContent = "×"; quoteCancel.setAttribute("aria-label", "取消引用回覆"); quotePanel.append(quoteLabel, quoteCancel);
  $("line-reply-text").before(quotePanel);
  quoteCancel.onclick = () => { quoteDrafts.delete(selected); renderQuote(); $("line-reply-text").focus(); };
  const pinsPanel = document.createElement("div"); pinsPanel.className = "message-pins"; pinsPanel.hidden = true; $("line-messages").before(pinsPanel);
  function renderQuote() { if (messages.get(quoteDrafts.get(selected)?.id)?.unsent) quoteDrafts.delete(selected); const quote = quoteDrafts.get(selected); quotePanel.hidden = !quote; quoteLabel.textContent = quote ? `回覆：${quote.text}` : ""; }
  function decorateMessage(bubble, item) {
    bubble.querySelector('.message-actions')?.remove();
    const state = workflow.state(selected), pinned = (state.pinnedMessages || []).includes(item.id);
    bubble.classList.toggle('message-pinned', pinned && !item.unsent); bubble.classList.toggle('message-unread', state.unreadMessageId === item.id);
    if (item.unsent || item.direction === 'outgoing' && item.status && item.status !== 'sent') return;
    bubble.prepend(messageToolbar({ pinned, unread: state.unreadMessageId === item.id, disabled: state.busy, onAction: action => {
      if (action === 'reply') { if ($('line-reply-text').disabled) { status('請先完成渠道連線才能回覆。', true); return; } quoteDrafts.set(selected, { id: item.id, text: item.text || '[附件]' }); renderQuote(); $('line-reply-text').focus(); return; }
      void workflow.messageAct(selected, action, item.id, action === 'pin' ? !pinned : true);
    } }));
  }
  function renderPins() {
    const state = workflow.state(selected), ids = state.pinnedMessages || [];
    pinsPanel.hidden = !selected || !ids.length; pinsPanel.replaceChildren();
    for (const id of ids) {
      const item = messages.get(id), button = document.createElement('button'); button.type = 'button'; button.className = 'message-pin-link';
      button.textContent = `📌 ${item?.unsent ? '訊息已收回' : item?.text || '釘選訊息（較早）'}`;
      button.disabled = !!item?.unsent; button.onclick = async () => {
        const conversationId = selected; historyMode(true);
        try { for (let page = 0; !messages.has(id) && messageNext && page < 20 && selected === conversationId; page++) await loadMessages(true, 'older');
          if (selected !== conversationId) return;
          const bubble = [...messageArea.children].find(node => node.dataset.messageId === id);
          if (bubble) { bubble.scrollIntoView({ block: 'center', behavior: 'auto' }); bubble.focus({ preventScroll: true }); } else status('訊息已到期或尚未載入，可載入更早訊息後再試。');
        } catch (error) { report(error); }
      };
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', '取消釘選'); remove.disabled = state.busy; remove.onclick = () => void workflow.messageAct(selected, 'pin', id, false);
      const chip = document.createElement('div'); chip.append(button, remove); pinsPanel.append(chip);
    }
  }
  let linkedScanPages = 0;
  const linkedConversation = new URL(location.href).searchParams.get("conversation");
  if (linkedConversation && linkedConversation.length <= 512) try { sessionStorage.setItem("botnest-open-conversation", linkedConversation); } catch {}
  let filterMode = "all", searchQuery = "", filterTimer, scanning = false, scanEpoch = 0, listLoaded = false;
  const filtering = () => filterMode !== "all" || !!searchQuery.trim();
  const filterStyle = document.createElement("link"); filterStyle.rel = "stylesheet"; filterStyle.href = "/inbox-filters.css"; document.head.append(filterStyle);
  const filters = document.createElement("div"); filters.className = "inbox-filters";
  filters.innerHTML = '<label class="sr-only" for="inbox-name-search">搜尋用戶名字</label><input id="inbox-name-search" type="search" placeholder="搜尋用戶名字…" autocomplete="off"><div class="inbox-status-filters" role="group" aria-label="篩選回覆狀態"><button type="button" data-filter="all" aria-pressed="true">全部</button><button type="button" data-filter="auto" aria-pressed="false">AI 回覆中</button><button type="button" data-filter="human" aria-pressed="false">真人接手</button><button type="button" data-filter="off" aria-pressed="false">關閉 AI</button></div><p id="inbox-filter-summary" class="inbox-filter-summary" role="status" aria-live="polite"></p>';
  document.querySelector(".conversation-toolbar").append(filters);
  const bulkStyle = document.createElement("link"); bulkStyle.rel = "stylesheet"; bulkStyle.href = "/inbox-bulk.css"; document.head.append(bulkStyle);
  const bulkPanel = document.createElement("div"); bulkPanel.id = "inbox-bulk-panel"; bulkPanel.className = "inbox-bulk-panel"; bulkPanel.hidden = true;
  const bulkIcon = action => '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + workflowIcons[action] + '</svg>';
  bulkPanel.innerHTML = '<input type="checkbox" class="inbox-bulk-all" aria-label="全選目前對話"><span class="inbox-bulk-count" role="status" aria-live="polite">已選擇 (0)</span><div class="inbox-bulk-actions" role="group" aria-label="批量操作">' + [['follow', '標記追蹤'], ['assign', '指派給自己'], ['complete', '完成對話'], ['trash', '移至垃圾匣']].map(([action, title]) => '<button type="button" data-bulk-workflow="' + action + '" title="' + title + '" aria-label="' + title + '">' + bulkIcon(action) + '</button>').join('') + '<button type="button" data-bulk-mode="auto" title="交回 AI" aria-label="交回 AI">AI</button><button type="button" data-bulk-mode="human" title="真人接手" aria-label="真人接手">' + bulkIcon('assign') + '</button></div><button type="button" data-bulk-select="exit" class="inbox-bulk-cancel">取消</button>';
  const bulkAll = bulkPanel.querySelector('.inbox-bulk-all');
  bulkAll.onchange = () => { if (bulkBusy) return; bulkAnchor = null; bulkIds.clear(); if (bulkAll.checked) for (const item of workflow.filter(filterConversations([...conversations.values()], searchQuery, filterMode))) bulkIds.add(item.id); clearBulkResult(); showConversations(); };
  const bulkResult = document.createElement("div"); bulkResult.className = "inbox-bulk-result"; bulkResult.hidden = true;
  const bulkSummary = document.createElement("p"); bulkSummary.setAttribute("role", "status"); bulkSummary.setAttribute("aria-live", "polite");
  const bulkErrors = document.createElement("details"); bulkErrors.className = "inbox-bulk-errors"; bulkErrors.hidden = true;
  const errorTitle = document.createElement("summary"); errorTitle.textContent = "查看未完成項目";
  const errorList = document.createElement("ul"); bulkErrors.append(errorTitle, errorList); bulkResult.append(bulkSummary, bulkErrors);
  filters.after(bulkPanel, bulkResult);
  function clearBulkResult() { bulkResult.hidden = true; bulkErrors.hidden = true; bulkErrors.open = false; errorList.replaceChildren(); bulkSummary.textContent = ""; }
  function renderBulk() {
    document.querySelector(".conversation-panel").classList.toggle("bulk-selection-active", bulkMode);
    document.querySelector(".inbox-grid").classList.toggle("bulk-selection-active", bulkMode);
    bulkPanel.hidden = !bulkMode; bulkPanel.setAttribute("aria-busy", String(bulkBusy));
    bulkPanel.querySelector(".inbox-bulk-count").textContent = `已選擇 (${bulkIds.size})`;
    for (const button of bulkPanel.querySelectorAll("button")) button.disabled = bulkBusy || (button.dataset.bulkMode || button.dataset.bulkWorkflow ? !bulkIds.size || refreshing || changingAi || sending : button.dataset.bulkSelect === "clear" && !bulkIds.size);
    const visibleCount = workflow.filter(filterConversations([...conversations.values()], searchQuery, filterMode)).length;
    bulkAll.checked = visibleCount > 0 && bulkIds.size === visibleCount; bulkAll.indeterminate = bulkIds.size > 0 && bulkIds.size < visibleCount; bulkAll.disabled = bulkBusy || !visibleCount;
    const view = workflow.view();
    for (const button of bulkPanel.querySelectorAll('[data-bulk-workflow]')) { const action = button.dataset.bulkWorkflow; const title = action === 'trash' && view === 'trash' ? '還原對話' : action === 'complete' && view === 'completed' ? '重新開啟對話' : ({ follow: '標記追蹤', assign: '指派給自己', complete: '完成對話', trash: '移至垃圾匣' })[action]; button.title = title; button.setAttribute('aria-label', title); }
    $("inbox-name-search").disabled = bulkBusy;
    for (const button of filters.querySelectorAll("[data-filter]")) button.disabled = bulkBusy;
    $("line-refresh").disabled = refreshing || bulkBusy;
    $("line-more-conversations").disabled = bulkBusy;
  }
  function setBulkSelection(id = null) {
    if (bulkBusy || (id && !conversations.has(id))) return;
    bulkMode = !!id; bulkAnchor = id; bulkIds.clear(); if (id) bulkIds.add(id); clearBulkResult();
    document.querySelector(".conversation-panel").scrollTop = 0;
    scanEpoch++; scanning = false; clearTimeout(filterTimer);
    showConversations();
    if (id) conversationRows.get(id)?.button.querySelector(".conversation-bulk-check")?.focus({ preventScroll: true });
  }
  const longPress = installConversationLongPress($("line-conversations"), {
    enabled: () => active && pageMode === "inbox" && !bulkMode && !bulkBusy,
    select: id => setBulkSelection(id),
  });
  const selectionHelp = document.createElement("p"); selectionHelp.className = "note";
  selectionHelp.textContent = "滑鼠移到對話後勾選可批量操作；手機可長按對話選取。按住 Shift 點選可選取連續範圍。鍵盤可使用 Shift＋空白鍵進入選取模式。";
  document.querySelector(".conversation-toolbar .inbox-help").append(selectionHelp);
  bulkPanel.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button || button.disabled || bulkBusy) return;
    if (button.dataset.bulkWorkflow) { void changeBulkWorkflow(button.dataset.bulkWorkflow); return; }
    if (button.dataset.bulkMode) { void changeBulkMode(button.dataset.bulkMode); return; }
    if (button.dataset.bulkSelect === "exit") { setBulkSelection(); return; }
    bulkAnchor = null;
    if (button.dataset.bulkSelect === "clear") bulkIds.clear();
    else for (const item of filterConversations([...conversations.values()], searchQuery, filterMode)) bulkIds.add(item.id);
    clearBulkResult(); showConversations();
  });
  function applyAiResult(id, data) {
    const item = conversations.get(id); if (!item) return;
    conversations.set(id, { ...item, ai: data });
    if (selected === id) { selectedAi = { ...data, id }; renderAiControl(); }
  }
  async function changeBulkMode(mode) {
    if (bulkBusy || refreshing || changingAi || sending || !bulkIds.size || !active) return;
    const generation = epoch, items = [...bulkIds].map(id => conversations.get(id)).filter(Boolean);
    const current = () => generation === epoch && active;
    bulkBusy = true; aiRequest++; clearTimeout(timer); scanEpoch++; scanning = false; clearTimeout(filterTimer);
    clearBulkResult(); bulkResult.hidden = false; bulkResult.classList.remove("error");
    bulkSummary.textContent = `正在處理 0／${items.length} 段對話…`; showConversations(); renderAiControl();
    try {
      const results = await runBulkAi(items, mode, async (input, item) => {
        try { return await aiApi("conversation", { method: "PUT", body: JSON.stringify(input) }); }
        catch (error) {
          // A conflict is refreshed for review, never automatically overwritten.
          if (error.status === 409 && current()) {
            try {
              const data = await aiApi(`conversation?provider=${input.provider}&conversationId=${encodeURIComponent(input.conversationId)}`);
              if (current()) applyAiResult(item.id, data);
            } catch { /* Retain the failed selection for an explicit retry. */ }
          }
          throw error;
        }
      }, {
        isCurrent: current,
        onResult(result) { if (result.ok) { bulkIds.delete(result.id); applyAiResult(result.id, result.data); } showConversations(); },
        onProgress(done, total) { bulkSummary.textContent = `正在處理 ${done}／${total} 段對話…`; },
      });
      if (!current()) return;
      const succeeded = results.filter(result => result.ok), failed = results.filter(result => !result.ok);
      const paused = mode === "auto" ? succeeded.filter(result => !result.data.state.allowed).length : 0;
      bulkSummary.textContent = `已將 ${succeeded.length} 段設為${mode === "auto" ? " AI 模式" : "真人接手"}。${paused ? `其中 ${paused} 段仍依 AI 設定暫停回覆。` : ""}${failed.length ? ` ${failed.length} 段未完成，保留選取供重試。` : ""}`;
      bulkResult.classList.toggle("error", !!failed.length); bulkErrors.hidden = !failed.length;
      for (const result of failed) {
        const item = items.find(item => item.id === result.id), row = document.createElement("li");
        row.textContent = `${label(item)}（${channelName(item)}）：${result.error}`; errorList.append(row);
      }
    } catch (error) { if (current()) { bulkSummary.textContent = error.message; bulkResult.classList.add("error"); } }
    finally { if (current()) { bulkBusy = false; showConversations(); renderAiControl(); scheduleRefresh(); } }
  }
  async function changeBulkWorkflow(action) {
    if (bulkBusy || refreshing || changingAi || sending || !bulkIds.size || !active) return;
    const generation = epoch, current = () => generation === epoch && active, ids = [...bulkIds], failures = [];
    const value = action === 'trash' ? workflow.view() !== 'trash' : action === 'complete' ? workflow.view() !== 'completed' : true;
    const title = bulkPanel.querySelector('[data-bulk-workflow="' + action + '"]').title;
    bulkBusy = true; clearTimeout(timer); scanEpoch++; scanning = false; clearTimeout(filterTimer); clearBulkResult(); bulkResult.hidden = false; bulkResult.classList.remove('error'); showConversations();
    let done = 0, succeeded = 0;
    try {
      for (const id of ids) {
        if (!current()) return;
        try { await workflow.act(id, action, value, true); if (!current()) return; succeeded++; bulkIds.delete(id); }
        catch (error) { failures.push({ id, error: error.message }); if ([401, 403, 429].includes(error.status)) { for (const pending of ids.slice(done + 1)) failures.push({ id: pending, error: '尚未執行，請稍後重試。' }); break; } }
        done++; bulkSummary.textContent = '正在處理 ' + done + '／' + ids.length + ' 段對話…'; showConversations();
      }
      if (!current()) return;
      bulkSummary.textContent = '已' + title + ' ' + succeeded + ' 段對話。' + (failures.length ? ' ' + failures.length + ' 段未完成，保留選取供重試。' : '');
      bulkResult.classList.toggle('error', !!failures.length); bulkErrors.hidden = !failures.length;
      for (const result of failures) { const row = document.createElement('li'); row.textContent = label(conversations.get(result.id)) + '：' + result.error; errorList.append(row); }
    } finally { if (current()) { bulkBusy = false; showConversations(); scheduleRefresh(); } }
  }
  const hasMore = () => !!(conversationNext || zernioConversationNext || instagramNext);
  function applyFilter() {
    scanEpoch++; scanning = false; clearTimeout(filterTimer); showConversations();
    if (filtering() && !bulkMode) filterTimer = setTimeout(() => void scanMore(), 250);
  }
  $("inbox-name-search").addEventListener("input", event => { searchQuery = event.target.value; applyFilter(); });
  filters.addEventListener("click", event => {
    const mode = event.target.closest("[data-filter]")?.dataset.filter; if (!mode) return;
    filterMode = mode;
    for (const button of filters.querySelectorAll("[data-filter]")) button.setAttribute("aria-pressed", String(button.dataset.filter === mode));
    applyFilter();
  });
  async function scanMore() {
    const generation = epoch, scan = scanEpoch, visited = new Set();
    scanning = true; showConversations();
    try {
      while (active && generation === epoch && scan === scanEpoch && filtering() && hasMore()) {
        if (refreshing) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
        const before = JSON.stringify([conversationNext, zernioConversationNext, instagramNext]);
        if (visited.has(before)) break; visited.add(before);
        await refresh(true, false, true);
        if (before === JSON.stringify([conversationNext, zernioConversationNext, instagramNext])) break;
      }
    } finally { if (generation === epoch && scan === scanEpoch) { scanning = false; showConversations(); } }
  }

  const drafts = new Map(), localReplies = new Map();
  const attachments = new Map();
  let sending = false, uploading = false, customerSaving = false, zernioBusy = false, facebookAccount = null, instagramAccount = null;
  let customerTags = [];
  let customerSaveTimer = null, pendingCustomerSave = null, customerSaveRevision = 0;
  let customerSaveChain = Promise.resolve();
  let followLatest = true;
  let selectedAi = null, changingAi = false, aiRequest = 0, aiEnabled = false;
  let channelAiSettings = null, channelAiSaving = false;
  const aiBar = document.createElement("div"); aiBar.className = "conversation-ai-controls"; aiBar.hidden = true;
  aiBar.innerHTML = '<span id="conversation-ai-state" class="assistant-badge"></span><button type="button" data-ai-mode="auto">交回 AI</button><button type="button" data-ai-mode="human">真人接手</button><button type="button" data-ai-mode="off">關閉 AI</button>';
  $("customer-toggle").before(aiBar);
  function renderAiControl() {
    aiBar.hidden = !selected;
    const current = selectedAi?.id === selected ? selectedAi : null;
    const globallyOff = current && ["AI 自動回覆已關閉", "此渠道未啟用 AI"].includes(current.state.reason);
    const humanMode = !globallyOff && current?.control.mode === "human";
    const displayMode = globallyOff ? "off" : current?.control.mode;
    $("conversation-ai-state").textContent = globallyOff ? "AI 已關閉" : humanMode ? "已轉真人，AI 暫停" : current ? current.state.reason : "讀取 AI 狀態…";
    $("conversation-ai-state").title = globallyOff ? "請到渠道設定或 AI 客服設定開啟自動回覆。" : humanMode ? `${current.control.reason || "真人客服處理中"}；按「交回 AI」可恢復自動回覆。` : current?.control.pausedUntil > Date.now() ? `暫停至 ${new Date(current.control.pausedUntil).toLocaleString("zh-TW")}` : current?.state.reason || "";
    $("conversation-ai-state").classList.toggle("active", !!current?.state.allowed);
    const labels = { auto: ["交回 AI", "AI 回覆中"], human: ["真人接手", "真人接手中"], off: ["關閉 AI", "AI 已關閉"] };
    for (const button of aiBar.querySelectorAll("button")) {
      const pressed = displayMode === button.dataset.aiMode && (displayMode !== "auto" || current?.state.allowed);
      button.disabled = !current || changingAi || bulkBusy || !!globallyOff;
      button.setAttribute("aria-pressed", String(pressed));
      button.textContent = labels[button.dataset.aiMode][pressed ? 1 : 0];
    }
    $("ai-reply-indicator").hidden = selected ? !current?.state.allowed : !aiEnabled;
  }
  async function loadAiControl() {
    const id = selected, item = conversations.get(id), requestId = ++aiRequest;
    if (!item) { selectedAi = null; renderAiControl(); return; }
    const provider = isSocial(item) ? item.provider : "line", conversationId = isSocial(item) ? item.remoteId : id;
    const data = await aiApi(`conversation?provider=${provider}&conversationId=${encodeURIComponent(conversationId)}`);
    if (id !== selected || requestId !== aiRequest) return;
    selectedAi = { ...data, id }; conversations.set(id, { ...conversations.get(id), ai: data }); showConversations(); renderAiControl();
  }
  aiBar.addEventListener("click", async event => {
    const mode = event.target.closest("button")?.dataset.aiMode, item = conversations.get(selected), id = selected;
    if (!mode || !item || changingAi || bulkBusy || selectedAi?.id !== selected) return;
    changingAi = true; aiRequest++; renderAiControl();
    try {
      const data = await aiApi("conversation", { method: "PUT", body: JSON.stringify({ provider: isSocial(item) ? item.provider : "line", conversationId: isSocial(item) ? item.remoteId : id, mode, revision: selectedAi.control.revision || 0 }) });
      if (id === selected) selectedAi = { ...data, id }; conversations.set(id, { ...conversations.get(id), ai: data }); showConversations(); status(data.state.reason);
    } catch (error) { report(error); } finally { changingAi = false; if (id === selected) { renderAiControl(); void loadAiControl().catch(report); } }
  });
  const messageArea = $("line-messages");
  messageArea.addEventListener("scroll", () => {
    followLatest = messageArea.scrollHeight - messageArea.clientHeight - messageArea.scrollTop < 40;
  }, { passive: true });
  const historyScroll = watchHistoryScroll(messageArea, {
    canLoad: () => active && pageMode === "inbox" && !document.hidden && !!selected && !!messageNext && !messageLoading && !refreshing && !saving,
    load: () => loadMessages(true), onError: error => report(error),
  });
  const messageResize = new ResizeObserver(() => {
    if (active && followLatest) messageArea.scrollTop = messageArea.scrollHeight;
  });
  function replyControls() {
    const current = conversations.get(selected), facebook = isSocial(current);
    const canReply = facebook ? !!(current?.provider === "instagram" ? instagramAccount : facebookAccount) : !!channel?.canReply;
    const enabled = active && !!selected && canReply && !saving && !sending && !uploading;
    $("line-reply-text").disabled = $("line-send").disabled = !enabled;
    for (const id of ["line-pick-image", "line-remove-attachment"]) $(id).disabled = !enabled;
    $("line-pick-file").hidden = current?.provider === "instagram";
    $("line-pick-file").disabled = !enabled || current?.provider === "instagram";
    $("line-pick-file").title = facebook ? "傳送文件" : "傳送文件連結";
    $("line-pick-emoji").disabled = !enabled;
    $("line-attachment-preview").hidden = !attachments.has(selected) && !uploading;
    $("line-attachment-name").textContent = uploading ? "正在準備附件…" : attachments.has(selected) ? `${attachments.get(selected).kind === "image" ? "圖片" : "文件"}：${attachments.get(selected).name}（待傳送）` : "";
    $("line-send").textContent = sending ? "傳送中…" : "傳送";
    $("line-reply-hint").textContent = !selected ? "先選擇一段對話。" : !canReply ? "請先到渠道設定完成連線。" : facebook ? `${channelName(current)} · 最多 5000 字` : "最多 5000 字";
    $("reply-channel-note").textContent = facebook ? `Enter 傳送，Shift＋Enter 換行。回覆會透過 ${channelName(current)} 傳送。` : "Enter 傳送，Shift＋Enter 換行。回覆會使用 OA 的 LINE 訊息額度。";
    $("reply-attachment-note").hidden = false;
    $("reply-attachment-note").textContent = current?.provider === "instagram" ? "圖片會自動壓縮；選取後按傳送才會送出。" : facebook ? "圖片會自動壓縮；文件上限 5 MB，以附件傳送。" : "圖片自動壓縮；文件上限 5 MB，以 90 天有效的下載連結傳送。";
  }
  const status = (text, error = false) => {
    for (const id of ["line-status", "channel-status"]) { $(id).textContent = text; $(id).classList.toggle("error", error); }
  };
  const clearSecrets = () => { $("line-channel-secret").value = $("line-access-token").value = ""; };
  function historyMode(value) {
    browsingHistory = value;
    $("line-polling-note").textContent = value ? "正在瀏覽較早紀錄，自動更新已暫停；按「重新整理」回到最新訊息。" : "自動更新：有變化時每 10 秒；無變化時，對話最長 60 秒、列表最長 2 分鐘。回到頁面立即更新，AI 回覆不受影響。";
  }
  const label = item => item?.customer?.name || item?.displayName || `${({ user: "使用者", group: "群組", room: "聊天室" })[item?.sourceType] || "對話"} · ${(item?.sourceId || "").slice(-8)}`;
  function avatar(item) {
    const frame = document.createElement("span"); frame.className = "chat-avatar";
    frame.textContent = item.displayName ? [...item.displayName][0] : "人";
    frame.setAttribute("aria-hidden", "true");
    let trustedPicture = false;
    try { const url = new URL(item.pictureUrl); trustedPicture = url.protocol === "https:" && (isSocial(item) ? /(^|\.)(fbcdn\.net|facebook\.com|fbsbx\.com|cdninstagram\.com|instagram\.com)$/i.test(url.hostname) : /(^|\.)line-scdn\.net$/i.test(url.hostname)); } catch { /* Invalid profile image. */ }
    if (item.pictureUrl && trustedPicture) {
      const image = document.createElement("img"); image.alt = ""; image.src = item.pictureUrl;
      image.loading = "lazy"; image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true }); frame.append(image);
    }
    const badge = document.createElement("span"); badge.className = item.provider === "instagram" ? "instagram-avatar-badge" : isSocial(item) ? "facebook-avatar-badge" : "line-avatar-badge"; badge.title = channelName(item); frame.append(badge);
    return frame;
  }
  let headerAvatarVersion = "";
  function showConversationHeader() {
    const item = conversations.get(selected);
    $("line-chat-empty").hidden = !!item;
    $("line-chat-empty").parentElement.classList.toggle("has-conversation", !!item);
    $("line-conversation-title").textContent = item ? label(item) : "選擇一段對話";
    const avatarVersion = JSON.stringify([item?.id, item?.pictureUrl, item?.displayName, item?.provider, item?.sourceType]);
    if (headerAvatarVersion !== avatarVersion) {
      $("line-chat-avatar").replaceChildren(...(item ? [avatar(item)] : [])); headerAvatarVersion = avatarVersion;
    }
    $("line-chat-source").textContent = item ? `來自 ${channelName(item)}` : "在左側選擇聊天者，開始回覆";
    renderAiControl();
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
    $("customer-source").textContent = `來自 ${channelName(item)}`;
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
  async function aiApi(path, options = {}) {
    const currentEpoch = epoch, currentUser = user, signal = controller.signal;
    if (!active || !currentUser) throw new DOMException("Inactive", "AbortError");
    const token = await currentUser.getIdToken();
    if (currentEpoch !== epoch) throw new DOMException("Session changed", "AbortError");
    const response = await fetch(`/api/ai/${path}`, { ...options, signal, cache: "no-store", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({ error: "AI 設定服務暫時無法使用。" }));
    if (currentEpoch !== epoch) throw new DOMException("Session changed", "AbortError");
    if (!response.ok || data.error) { const error = new Error(data.error || "AI 設定服務暫時無法使用。"); error.status = response.status; throw error; }
    return data;
  }
  function customerRequest(conversationId, suffix = "", options = {}) {
    const item = conversations.get(conversationId);
    if (isSocial(item)) return zernioApi(`customer${suffix}?platform=${item.provider}&conversationId=${encodeURIComponent(item.remoteId)}`, options);
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
    const ig = data.instagram; instagramAccount = ig || null;
    $("instagram-card-state").textContent = ig ? "已綁定" : data.configured ? "未綁定" : "尚未設定";
    $("instagram-card-state").classList.toggle("connected", !!ig);
    $("instagram-account-name").textContent = ig?.displayName || "尚未綁定 Instagram 帳號";
    $("instagram-account-detail").textContent = ig ? `@${ig.username || "Instagram"} · 帳號已授權` : "請使用 Instagram 商業或創作者帳號授權";
    $("instagram-connect").textContent = ig ? "重新授權" : "綁定 Instagram";
    $("instagram-connect").disabled = !data.configured || zernioBusy;
    showAccount(); replyControls();
  }
  async function loadZernioAccount() {
    try {
      const data = await zernioApi("account"); showZernioAccount(data);
      const callback = new URLSearchParams(location.search).get("zernio");
      if (callback === "connected") status(new URLSearchParams(location.search).get("platform") === "instagram" ? "Instagram 帳號已成功綁定。" : "Facebook Messenger 粉絲專頁已成功連接。");
      else if (callback === "error") status("社群帳號授權未完成，請重新操作。", true);
      if (callback) history.replaceState(null, "", `${location.pathname}${location.hash}`);
    } catch (error) {
      $("facebook-card-state").textContent = "讀取失敗"; $("facebook-card-state").classList.remove("connected");
      $("facebook-connect").disabled = true; $("instagram-connect").disabled = true; $("instagram-card-state").textContent = "讀取失敗"; report(error);
    }
  }
  function report(error) { if (error.name !== "AbortError") status(error.message, true); }
  function showAccount() {
    $("line-connection-details").open = false;
    $("line-step5-guide").hidden = !!channel;
    $("line-account").hidden = !channel;
    $("line-inbox").hidden = !channel && !facebookAccount && !instagramAccount;
    $("line-connect-form").hidden = !!channel;
    $("line-step5-webhook").hidden = !channel;
    $("line-step5-webhook-url").value = channel?.webhookUrl || "";
    $("line-step5-copy-status").textContent = "";
    $("line-not-connected").hidden = !!channel || !!facebookAccount || !!instagramAccount;
    $("line-settings-toggle").setAttribute("aria-expanded", "false");
    $("line-card-state").textContent = channel ? "已連接" : "未連接";
    $("line-card-state").classList.toggle("connected", !!channel);
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
    channelAiSettings = settings;
    showAiModel($("ai-model-name"), settings.model);
    aiEnabled = !!settings.configured && !!settings.enabled;
    $("ai-key-state").textContent = settings.configured ? "OpenAI API 已安全設定於 Firebase 後端。" : "尚未設定 OpenAI API Key。";
    $("ai-card-state").textContent = !settings.configured ? "待設定 API Key" : settings.enabled ? "自動回覆中" : "已關閉";
    $("ai-card-state").classList.toggle("connected", !!settings.configured && !!settings.enabled);
    renderChannelAiToggle();
    renderAiControl();
  }
  function renderChannelAiToggle() {
    const toggle = $("ai-channel-toggle");
    toggle.setAttribute("aria-checked", String(!!channelAiSettings?.enabled));
    toggle.setAttribute("aria-busy", String(channelAiSaving));
    toggle.disabled = !active || pageMode !== "settings" || !channelAiSettings || channelAiSaving || (!channelAiSettings.configured && !channelAiSettings.enabled);
  }
  function channelAiFeedback(message, error = false) {
    const feedback = $("ai-channel-feedback");
    feedback.hidden = !message; feedback.textContent = message; feedback.classList.toggle("error", error);
  }
  $("ai-channel-toggle").addEventListener("click", async () => {
    if (!channelAiSettings || channelAiSaving || $("ai-channel-toggle").disabled) return;
    const currentEpoch = epoch, enabled = !channelAiSettings.enabled;
    channelAiSaving = true; renderChannelAiToggle(); channelAiFeedback(enabled ? "正在開啟 AI 自動回覆…" : "正在關閉 AI 自動回覆…");
    try {
      const data = await aiApi("settings", { method: "PUT", body: JSON.stringify({ enabled }) });
      if (currentEpoch !== epoch) return;
      showAiSettings(data.settings); channelAiFeedback(data.settings.enabled ? "已開啟 AI 自動回覆，依已設定的渠道與規則生效。" : "已關閉 AI 自動回覆。");
    } catch (error) {
      if (currentEpoch !== epoch || error.name === "AbortError") return;
      // Re-read after an uncertain request so the switch reflects the saved server state.
      try { showAiSettings((await aiApi("settings")).settings); }
      catch { if (currentEpoch !== epoch) return; channelAiSettings = null; showAiModel($("ai-model-name")); $("ai-card-state").textContent = "狀態待確認"; $("ai-card-state").classList.remove("connected"); }
      if (currentEpoch === epoch) channelAiFeedback(`切換未確認：${error.message} 請重新整理確認狀態。`, true);
    } finally { if (currentEpoch === epoch) { channelAiSaving = false; renderChannelAiToggle(); } }
  });
  const conversationRows = new Map();
  function showConversations() {
    const list = $("line-conversations");
    const visible = workflow.filter(filterConversations([...conversations.values()], searchQuery, filterMode));
    $("line-empty").hidden = visible.length > 0;
    $("line-empty").textContent = filtering() ? scanning || hasMore() ? "正在尋找符合條件的對話；可載入更多繼續搜尋。" : "沒有符合條件的對話，請試試其他名字或狀態。" : (conversations.size ? "此分類目前沒有對話，可切換其他分類。" : "還沒有對話。完成連線後，傳一則訊息給你的帳號。");
    $("inbox-filter-summary").textContent = filtering() ? `${visible.length} 段符合 · 已搜尋 ${conversations.size} 段${scanning ? " · 搜尋其他對話中…" : hasMore() ? " · 尚有更多對話" : ""}` : "";
    const visibleIds = new Set(visible.map(item => item.id));
    if (!visibleIds.has(bulkAnchor)) bulkAnchor = null;
    if (!bulkBusy) for (const id of bulkIds) if (!visibleIds.has(id)) bulkIds.delete(id);
    for (const [id, row] of conversationRows) if (!visibleIds.has(id)) { row.button.remove(); conversationRows.delete(id); }
    let position = 0;
    for (const item of visible.sort((a, b) => b.updatedAt - a.updatedAt)) {
      const version = JSON.stringify([label(item), item.displayName, item.pictureUrl, item.provider, item.sourceType,
        item.lastText, item.updatedAt, inboxMode(item.ai), item.ai?.state.reason, selected === item.id, dayKey(Date.now()), bulkMode, bulkBusy, bulkIds.has(item.id), workflow.state(item.id)]);
      const prior = conversationRows.get(item.id);
      if (prior?.version === version) {
        if (list.children[position] !== prior.button) list.insertBefore(prior.button, list.children[position] || null);
        position++; continue;
      }
      const button = document.createElement("button");
      button.type = "button"; button.className = "conversation-item";
      button.classList.toggle("conversation-unread", !!workflow.state(item.id).unreadMessageId);
      button.dataset.conversationId = item.id;
      if (!bulkMode) { button.title = "開啟對話；勾選可批量操作"; button.setAttribute("aria-keyshortcuts", "Shift+Space"); }
      if (bulkMode) {
        button.classList.add("bulk-selectable"); button.setAttribute("aria-pressed", String(bulkIds.has(item.id))); button.disabled = bulkBusy;

      } else button.setAttribute("aria-pressed", String(selected === item.id));
      const name = document.createElement("strong"), preview = document.createElement("span"), time = document.createElement("time");
      name.textContent = label(item); preview.textContent = item.lastText;
      if (workflow.state(item.id).unreadMessageId) { const unread = document.createElement('span'); unread.className = 'sr-only'; unread.textContent = ' 未讀'; name.append(unread); }
      time.dateTime = new Date(item.updatedAt).toISOString(); time.textContent = formatConversationTime(item.updatedAt);
      const details = document.createElement("span"); details.className = "conversation-details";
      preview.className = "conversation-preview";
      const heading = document.createElement("span"); heading.className = "conversation-title-row"; heading.append(name, time);
      const aiLabel = document.createElement("span"); aiLabel.className = "conversation-ai-label";
      const mode = inboxMode(item.ai); aiLabel.dataset.mode = mode;
      aiLabel.textContent = ({ auto: "AI 回覆中", human: "真人接手", off: "關閉 AI", unknown: "AI 狀態待確認" })[mode];
      aiLabel.title = item.ai?.state.reason || "重新整理以取得狀態";
      details.append(heading, preview, aiLabel); button.append(avatar(item), details);
      button.addEventListener("click", event => {
        if (bulkMode) {
          if (bulkBusy) return;
          const ids = [...list.children].map(row => row.dataset.conversationId);
          if (event.shiftKey && bulkAnchor && ids.includes(bulkAnchor)) {
            const from = ids.indexOf(bulkAnchor), to = ids.indexOf(item.id);
            for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) bulkIds.add(id);
          } else {
            if (bulkIds.has(item.id)) bulkIds.delete(item.id); else bulkIds.add(item.id);
            bulkAnchor = item.id;
          }
          clearBulkResult(); showConversations();
        }
        else void selectConversation(item.id);
      });
      const focused = prior?.button.contains(document.activeElement);
      const row = document.createElement("div"); row.className = "conversation-workflow-row"; row.dataset.conversationId = item.id; row.append(button);
      const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'conversation-bulk-check'; check.checked = bulkIds.has(item.id); check.disabled = bulkBusy; check.setAttribute('aria-label', '選取 ' + label(item) + ' 以批量操作');
      check.onclick = event => { event.stopPropagation(); if (!bulkMode) { setBulkSelection(item.id); return; } if (check.checked) bulkIds.add(item.id); else bulkIds.delete(item.id); bulkAnchor = item.id; clearBulkResult(); showConversations(); };
      row.prepend(check);
      if (!bulkMode) row.append(workflow.toolbar(item.id));
      prior?.button.remove();
      list.insertBefore(row, list.children[position] || null);
      if (focused) button.focus({ preventScroll: true });
      conversationRows.set(item.id, { version, button: row }); position++;
    }
    $("line-more-conversations").hidden = !conversationNext && !zernioConversationNext && !instagramNext;
    renderBulk();
    showConversationHeader();
  }
  const trustedMediaUrl = attachment => {
    try {
      const url = new URL(attachment.url, location.origin);
      if (url.origin === "https://planning-with-ai-52d58.web.app" && ["/api/line/media/", "/api/zernio/media/"].some(prefix => url.pathname.startsWith(prefix))) return url;
      if (attachment.external && url.protocol === "https:" && /(^|\.)(fbcdn\.net|cdninstagram\.com|fbsbx\.com)$/i.test(url.hostname)) return url;
      return null;
    } catch { return null; }
  };
  const audioRows = new Map();
  function clearAudio() { for (const row of audioRows.values()) row.player.dispose(); audioRows.clear(); }
  function audioRow(item) {
    let row = audioRows.get(item.id);
    if (!row) {
      const conversationId = selected, conversation = conversations.get(selected);
      row = { item, bubble: document.createElement("article") };
      row.bubble.className = `message-bubble audio-message${item.direction === "outgoing" ? " outgoing" : ""}`;
      row.bubble.dataset.messageId = item.id; row.bubble.tabIndex = -1;
      row.player = createAudioPlayer(async () => {
        if (isSocial(conversation)) {
          if (!row.item.audioTicket) throw new Error("語音連結尚未就緒，請重新整理對話。");
          return zernioApi(`audio?platform=${conversation.provider}`, { method: "POST", body: JSON.stringify({ ticket: row.item.audioTicket }) });
        }
        return api(`conversations/${conversationId}/messages/${encodeURIComponent(item.id)}/audio`);
      }, current => { for (const other of audioRows.values()) if (other.player.audio !== current) other.player.audio.pause(); });
      const time = document.createElement("time"); time.textContent = formatClock(item.sentAt); time.dateTime = new Date(item.sentAt).toISOString();
      row.bubble.append(row.player.root);
      if (item.text && item.text !== "[語音]") { const caption = document.createElement("p"); caption.textContent = item.text; row.bubble.append(caption); }
      row.bubble.append(time); audioRows.set(item.id, row);
    }
    row.item = item; return row.bubble;
  }
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
    const focusedAction = document.activeElement?.dataset.messageAction, focusedMessage = document.activeElement?.closest('.message-bubble')?.dataset.messageId;
    const previousTop = messageArea.scrollTop, previousHeight = messageArea.scrollHeight;
    const scrollToLatest = scrollMode === "bottom" || (["auto", "keep"].includes(scrollMode) && followLatest);
    messageResize.disconnect();
    const desired = [], activeAudio = new Set();
    let renderedDay = null;
    for (const item of [...messages.values()].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id))) {
      const itemDay = dayKey(item.sentAt);
      if (itemDay !== renderedDay) {
        const divider = document.createElement("div"), label = document.createElement("span");
        divider.className = "message-date-divider"; divider.setAttribute("role", "separator");
        label.textContent = formatDay(item.sentAt); divider.append(label); desired.push(divider);
        renderedDay = itemDay;
      }
      if (item.type === "audio" && !item.unsent && !item.attachmentExpired) { activeAudio.add(item.id); const row = audioRow(item); decorateMessage(row, item); desired.push(row); continue; }
      const bubble = document.createElement("article"), text = document.createElement("p"), time = document.createElement("time");
      bubble.className = `message-bubble${item.unsent ? " unsent" : ""}${item.direction === "outgoing" ? " outgoing" : ""}`;
      bubble.dataset.messageId = item.id; bubble.tabIndex = -1;
      text.textContent = item.text; time.textContent = formatClock(item.sentAt); time.dateTime = new Date(item.sentAt).toISOString();
      bubble.append(text, time);
      if (item.type === 'sticker' && !item.unsent && !item.attachmentExpired && !item.attachment) {
        const url = lineStickerUrl(item.sticker);
        if (url) {
          const img = document.createElement('img'); img.className = 'sticker-image'; img.src = url; img.alt = item.sticker.text || 'LINE 貼圖'; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
          img.addEventListener('error', () => { img.remove(); text.hidden = false; text.textContent = '貼圖暫時無法預覽'; }, { once: true }); bubble.prepend(img); text.hidden = !item.sticker.text; if (item.sticker.text) text.textContent = item.sticker.text;
        } else text.textContent = isSocial(conversations.get(selected)) ? '平台未提供可預覽的貼圖圖片' : item.sticker ? '此貼圖無法預覽' : '貼圖（舊訊息未保存貼圖 ID）';
      }
      if (item.type === "image" && !item.attachment && !item.unsent && !item.attachmentExpired) {
        const note = document.createElement("p"); note.className = "note";
        note.textContent = item.imageNote || "正在讀取 LINE 圖片…"; bubble.append(note);
      }
      if (item.attachmentExpired) { const expired = document.createElement("p"); expired.className = "message-expired"; expired.textContent = `附件已到期${item.attachment?.name ? `：${item.attachment.name}` : ""}`; bubble.append(expired); }
      if (item.attachment && !item.attachmentExpired) {
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
            if (["[圖片]", "[貼圖]"].includes(item.text)) text.hidden = true;
            if (item.type === "sticker") { img.classList.add("sticker-image"); bubble.classList.add("sticker-message"); }
            imageMeta = document.createElement("div");
            imageMeta.className = "image-message-meta";
            imageMeta.append(time);
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
          retry.textContent = "重試確認"; retry.disabled = sending || (["facebook", "instagram"].includes(selectedProvider) ? !(selectedProvider === "instagram" ? instagramAccount : facebookAccount) : !channel?.canReply) || Date.now() - item.sentAt >= 23 * 60 * 60 * 1000;
          retry.addEventListener("click", () => void sendReply(selected, item.text, item.operationId, item.attachment)); bubble.append(retry);
        }
        if (item.status !== "sent" && item.note) { const note = document.createElement("p"); note.className = "note"; note.textContent = item.note; bubble.append(note); }
      }
      decorateMessage(bubble, item); desired.push(bubble);
    }
    for (const [id, row] of audioRows) if (!activeAudio.has(id)) { row.player.dispose(); audioRows.delete(id); }
    // Keep audio rows connected while polling so playback and seeking are preserved.
    const target = $("line-messages"), retained = new Set(desired);
    for (const child of [...target.children]) if (!retained.has(child)) child.remove();
    desired.forEach((node, index) => { if (target.children[index] !== node) target.insertBefore(node, target.children[index] || null); });
    followLatest = scrollToLatest;
    messageArea.scrollTop = scrollToLatest ? messageArea.scrollHeight : scrollMode === "older" ? previousTop + messageArea.scrollHeight - previousHeight : previousTop;
    historyScroll.sync();
    messageResize.observe(messageArea);
    for (const bubble of messageArea.children) messageResize.observe(bubble);
    renderPins(); renderQuote();
    if (focusedAction && focusedMessage) {
      const row = [...messageArea.children].find(node => node.dataset.messageId === focusedMessage);
      row?.querySelector(`[data-message-action="${focusedAction}"]`)?.focus({ preventScroll: true });
    }
  }
  async function loadMessages(older = false, scrollMode = "auto") {
    const id = selected, messageEpoch = epoch;
    if (!id || messageLoading || (older && !messageNext)) return;
    const request = ++messageRequest, cursor = messageNext;
    messageLoading = true;
    messageArea.setAttribute("aria-busy", "true");
    const wasBrowsing = browsingHistory;
    if (older) historyMode(true);
    try {
    const current = conversations.get(id);
    const requestedVersion = conversationVersion(current);
    const data = isSocial(current)
      ? await zernioApi(`messages?platform=${current.provider}&conversationId=${encodeURIComponent(current.remoteId)}${older && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      : await api(`conversations/${id}/messages${older && cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`);
    if (selected !== id || messageEpoch !== epoch || request !== messageRequest) return;
    if (!older) messageSnapshot = { id, version: requestedVersion, at: Date.now() };
    // Refresh replaces the window, including any retracted messages.
    if (!older) messages.clear();
    for (const item of data.items) messages.set(item.id, item);
    for (const [operationId, local] of localReplies) {
      if (local.conversationId !== id) continue;
      if (!messages.has(local.message.id)) messages.set(local.message.id, local.message);
      else if (["sent", "failed"].includes(messages.get(local.message.id).status)) localReplies.delete(operationId);
    }
    messageNext = older && data.next === cursor ? null : data.next; showMessages(older ? "older" : scrollMode);
    } catch (error) {
      if (selected !== id || messageEpoch !== epoch || request !== messageRequest) return;
      if (older) historyMode(wasBrowsing);
      throw error;
    } finally {
      if (request === messageRequest) { messageLoading = false; messageArea.removeAttribute("aria-busy"); }
    }
  }
  async function selectConversation(id) {
    flushCustomerSave();
    messageRequest++; messageLoading = false; messageArea.removeAttribute("aria-busy");
    clearAudio(); selected = id; messages.clear(); messageNext = null; messageSnapshot = null; unchangedRounds = 0; scheduleRefresh();
    historyMode(false);
    $("line-reply-text").value = drafts.get(id) || ""; replyControls(); renderQuote();
    const unreadId = workflow.state(id).unreadMessageId;
    if (unreadId) void workflow.messageAct(id, 'read', unreadId);
    $("line-conversation-title").textContent = label(conversations.get(id));
    showConversations(); showMessages(); showCustomerPanel();
    const tasks = [loadMessages(false, "bottom"), loadAiControl()];
    if (isSocial(conversations.get(id))) tasks.push(customerRequest(id).then(data => {
      if (selected !== id) return;
      const item = conversations.get(id); conversations.set(id, { ...item, customer: data.customer || {} }); showCustomerPanel(); showConversations();
    }));
    const results = await Promise.allSettled(tasks);
    const failed = results.find(result => result.status === "rejected"); if (failed) report(failed.reason);
  }
  async function refresh(more = false, force = true, filterScan = false) {
    if (refreshing || bulkBusy || (!channel && !facebookAccount && !instagramAccount) || !active || saving) return;
    const currentEpoch = epoch, currentAiRequest = aiRequest;
    const resetPages = !more && (force || !filtering() || !listLoaded);
    refreshing = true; renderBulk();
    try {
      const workflowPromise = workflow.load().catch(error => { if (currentEpoch === epoch) report(error); });
      const linePromise = channel && (!more || conversationNext) ? api(`conversations${more && conversationNext ? `?before=${encodeURIComponent(conversationNext)}` : ""}`) : null;
      const facebookPromise = facebookAccount && (!more || zernioConversationNext) ? zernioApi(`conversations${more && zernioConversationNext ? `?cursor=${encodeURIComponent(zernioConversationNext)}` : ""}`) : null;
      const instagramPromise = instagramAccount && (!more || instagramNext) ? zernioApi(`conversations?platform=instagram${more && instagramNext ? `&cursor=${encodeURIComponent(instagramNext)}` : ""}`) : null;
      const [lineState, facebookState, instagramState] = await Promise.allSettled([linePromise, facebookPromise, instagramPromise, workflowPromise]);
      if (currentEpoch !== epoch) return;
      const instagramResult = instagramState.status === "fulfilled" ? instagramState.value : null;
      const lineResult = lineState.status === "fulfilled" ? lineState.value : null;
      const facebookResult = facebookState.status === "fulfilled" ? facebookState.value : null;
      const refreshError = lineState.status === "rejected" ? lineState.reason : facebookState.status === "rejected" ? facebookState.reason : instagramState.status === "rejected" ? instagramState.reason : null;
      const data = lineResult;
      replyControls();
      if (channel) {
        $("line-oa-state").textContent = channel.verifiedAt ? "Webhook 已接通" : "等待 Webhook 驗證";
        $("line-oa-state").classList.toggle("active", !!channel.verifiedAt);
      }
      // Keep a provider's existing list on transient failure.
      if (resetPages) for (const [id, item] of conversations) {
        const result = item.provider === "instagram" ? instagramResult : item.provider === "facebook" ? facebookResult : data;
        if (result) conversations.delete(id);
      }
      for (const item of data?.items || []) conversations.set(item.id, item);
      for (const item of facebookResult?.items || []) conversations.set(item.id, item);
      for (const item of instagramResult?.items || []) conversations.set(item.id, item);
      if (instagramResult && (more || resetPages)) instagramNext = instagramResult.next || null;
      if (data && (more || resetPages)) conversationNext = data.next || null;
      if (facebookResult && (more || resetPages)) zernioConversationNext = facebookResult.next || null;
      listLoaded = true;
      if (filtering() && !bulkMode && hasMore() && !scanning && !filterScan) { clearTimeout(filterTimer); filterTimer = setTimeout(() => void scanMore(), 250); }
      const listVersion = JSON.stringify([...conversations.values()].map(conversationVersion).sort());
      if (!more) { unchangedRounds = listVersion === lastListVersion ? unchangedRounds + 1 : 0; lastListVersion = listVersion; }
      showConversations();
      let pendingConversation = null;
      try { pendingConversation = sessionStorage.getItem("botnest-open-conversation"); } catch { /* Storage may be unavailable. */ }
      if (pendingConversation && !conversations.has(pendingConversation) && hasMore() && linkedScanPages++ < 30) setTimeout(() => { if (active && epoch === currentEpoch) void refresh(true, false, true).catch(report); }, 0);
      if (pendingConversation && conversations.has(pendingConversation)) {
        workflow.reveal(pendingConversation); showConversations();
        try { sessionStorage.removeItem("botnest-open-conversation"); } catch { /* Storage may be unavailable. */ }
        await selectConversation(pendingConversation); status(""); return;
      }
      if (more && !filterScan) historyMode(true);
      if (!more && needsMessageRefresh(messageSnapshot, conversations.get(selected), Date.now(), force)) await loadMessages();
      if (currentEpoch !== epoch) return;
      if (!changingAi && currentAiRequest === aiRequest) {
        const fresh = [data, facebookResult, instagramResult].flatMap(result => result?.items || []).find(item => item.id === selected)?.ai;
        if (fresh && (selectedAi?.id !== selected || (fresh.control.revision || 0) >= (selectedAi.control.revision || 0))) {
          selectedAi = { ...fresh, id: selected }; renderAiControl();
        } else await loadAiControl();
      }
      if (refreshError) report(refreshError); else status("");
    } catch (error) { report(error); }
    finally { if (currentEpoch === epoch) { refreshing = false; renderBulk(); } }
  }
  async function start() {
    const currentEpoch = epoch;
    status("正在讀取 OA 連線狀態…");
    // The settings card must not delay the conversation list.
    const settingsReady = aiApi("settings").then(data => {
      if (currentEpoch === epoch) showAiSettings(data.settings);
    }).catch(error => {
      if (currentEpoch !== epoch || error.name === "AbortError") return;
      $("ai-card-state").textContent = "讀取失敗"; $("ai-key-state").textContent = "暫時無法讀取 AI 設定，請稍後再試。"; showAiModel($("ai-model-name"), null, "暫時無法讀取模型");
    });
    try {
      const [lineResult, zernioResult] = await Promise.allSettled([api("account"), zernioApi("account"), workflow.load(true).catch(report)]);
      if (currentEpoch !== epoch) return;
      if (lineResult.status === "fulfilled") channel = lineResult.value.channel;
      if (zernioResult.status === "fulfilled") showZernioAccount(zernioResult.value);
      showAccount();
      if (channel || facebookAccount || instagramAccount) {
        if (channel && pageMode !== "inbox") {
          status(channel.verifiedAt ? "LINE 官方帳號已連接，Webhook 運作正常。" : "LINE 官方帳號已連接，等待 Webhook 驗證。");
        }
      } else if (!facebookAccount && !instagramAccount) status("尚未連接任何訊息渠道。請先前往渠道設定。");
      if (pageMode === "inbox" && (channel || facebookAccount || instagramAccount)) await refresh();
      if (pageMode === "settings" && zernioResult.status === "rejected") await loadZernioAccount();
      if (currentEpoch === epoch && pageMode === "inbox") scheduleRefresh();
    } catch (error) { report(error); }
    await settingsReady;
  }
  async function sendReply(conversationId, text, operationId, attachment) {
    const currentConversation = conversations.get(conversationId), facebook = isSocial(currentConversation);
    const canReply = facebook ? !!(currentConversation?.provider === "instagram" ? instagramAccount : facebookAccount) : !!channel?.canReply;
    if (sending || !active || !canReply || !conversationId || (!text.trim() && !attachment) || (currentConversation?.provider === "instagram" && attachment?.kind === "file")) return;
    const isRetry = !!operationId;
    operationId ||= crypto.randomUUID();
    const currentEpoch = epoch;
    sending = true; replyControls(); showMessages();
    const initial = { id: `out-${operationId}`, operationId, text, ...(attachment ? { attachment } : {}), direction: "outgoing", type: attachment?.kind || "text", status: "pending", sentAt: localReplies.get(operationId)?.message.sentAt || messages.get(`out-${operationId}`)?.sentAt || Date.now() };
    localReplies.set(operationId, { conversationId, message: initial });
    if (selected === conversationId) { historyMode(false); messages.set(initial.id, initial); showMessages("bottom"); }
    try {
      const data = facebook
        ? await zernioApi(`messages?platform=${currentConversation.provider}`, { method: "POST", body: JSON.stringify({ conversationId: currentConversation.remoteId, text, operationId, attachmentId: attachment?.id || null }) })
        : await api(`conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ text, operationId, attachmentId: attachment?.id || null }) });
      localReplies.set(operationId, { conversationId, message: data.message });
      if (selected === conversationId) void loadAiControl().catch(report);
      if (selected === conversationId) { if (data.message.id !== initial.id) messages.delete(initial.id); messages.set(data.message.id, data.message); showMessages(); }
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
    const currentConversation = conversations.get(selected), social = isSocial(currentConversation);
    const canReply = social ? !!(currentConversation.provider === "instagram" ? instagramAccount : facebookAccount) : !!channel?.canReply;
    if (!file || uploading || sending || !selected || !active || !canReply || (currentConversation?.provider === "instagram" && kind !== "image")) return;
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
      const data = social
        ? await zernioApi(`attachments?platform=${currentConversation.provider}`, { method: "POST", body: JSON.stringify({ conversationId: currentConversation.remoteId, name, kind, data: btoa(binary) }) })
        : await api(`conversations/${conversationId}/attachments`, { method: "POST", body: JSON.stringify({ name, kind, data: btoa(binary) }) });
      if (currentEpoch !== epoch) return;
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
    const text = quotedReply($("line-reply-text").value, quoteDrafts.get(selected)?.text);
    const attachment = attachments.get(selected);
    const current = conversations.get(selected), canReply = isSocial(current) ? !!(current.provider === "instagram" ? instagramAccount : facebookAccount) : !!channel?.canReply;
    if (sending || uploading || !selected || !canReply || (!$("line-reply-text").value.trim() && !attachment)) return;
    if (text.length > 5000) { status('含引用文字最多 5000 字，請縮短回覆。', true); return; }
    quoteDrafts.delete(selected); renderQuote();
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
    $("line-step5-guide").hidden = $("line-connect-form").hidden;
    $("line-settings-toggle").setAttribute("aria-expanded", String(!$("line-connect-form").hidden)); clearSecrets();
  });
  $("line-refresh").addEventListener("click", () => { historyMode(false); void refresh(); });
  $("line-more-conversations").addEventListener("click", () => void refresh(true));
  $("line-image-close").addEventListener("click", () => $("line-image-viewer").close());
  $("line-image-prev").addEventListener("click", () => moveImageViewer(-1));
  $("line-image-next").addEventListener("click", () => moveImageViewer(1));
  $("line-image-viewer").addEventListener("click", event => { if (event.target === $("line-image-viewer")) $("line-image-viewer").close(); });
  $("line-image-viewer").addEventListener("close", () => { $("line-image-full").removeAttribute("src"); viewerItems = []; });
  $("line-connection-details").addEventListener("toggle", () => {
    if (channel && !$("line-connection-details").open) {
      $("line-connect-form").hidden = $("line-step5-guide").hidden = true;
      $("line-settings-toggle").setAttribute("aria-expanded", "false");
      clearSecrets();
    }
  });
  $("line-step5-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("line-step5-webhook-url").value); $("line-step5-copy-status").textContent = "已複製 Webhook URL。"; }
    catch { $("line-step5-webhook-url").select(); $("line-step5-copy-status").textContent = "請手動複製已選取的網址。"; }
  });
  $("line-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("line-webhook-url").value); status("已複製 Webhook URL。"); }
    catch { $("line-webhook-url").select(); status("請手動複製已選取的網址。"); }
  });
  for (const platform of ["facebook", "instagram"]) $(`${platform}-connect`).addEventListener("click", async () => {
    if (zernioBusy || !active) return;
    zernioBusy = true; $("facebook-connect").disabled = $("instagram-connect").disabled = true; $(`${platform}-connect`).disabled = true; $(`${platform}-connect`).textContent = "正在開啟授權…";
    try {
      const data = await zernioApi(`connect/${platform}`, { method: "POST", body: "{}" });
      location.assign(data.authUrl);
    } catch (error) { report(error); zernioBusy = false; await loadZernioAccount(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { flushCustomerSave(); clearTimeout(timer); }
    else resumeRefresh();
  });
  window.addEventListener("focus", resumeRefresh);
  window.addEventListener("pagehide", () => { longPress.reset(); clearAudio(); clearSecrets(); controller?.abort(); clearTimeout(timer); messageResize.disconnect(); });
  return {
    setSession(nextUser, nextMode) {
      const nextActive = !!nextUser && !!nextMode;
      if (user?.uid === nextUser?.uid && active === nextActive && pageMode === nextMode) { user = nextUser; return; }
      clearAudio(); epoch++; controller?.abort(); clearTimeout(timer); clearTimeout(customerSaveTimer); customerSaveTimer = null; pendingCustomerSave = null; controller = new AbortController();
      longPress.reset(); bulkMode = false; bulkBusy = false; bulkAnchor = null; bulkIds.clear(); clearBulkResult();
      messageRequest++; messageLoading = false; messageArea.removeAttribute("aria-busy");
      messageResize.disconnect(); followLatest = true;
      user = nextUser; active = nextActive; pageMode = nextMode; channel = null; facebookAccount = null, instagramAccount = null; selected = null; refreshing = false; saving = false;
      unchangedRounds = 0; lastListVersion = ""; messageSnapshot = null; lastResume = 0;
      selectedAi = null; changingAi = false; aiEnabled = false; aiRequest++;
      channelAiSettings = null; channelAiSaving = false; renderChannelAiToggle(); channelAiFeedback("");
      sending = false; uploading = false; customerSaving = false; zernioBusy = false; customerTags = []; attachments.clear(); drafts.clear(); localReplies.clear(); $("line-reply-text").value = ""; replyControls();
      $("line-emoji-panel").hidden = true; $("line-pick-emoji").setAttribute("aria-expanded", "false");
      scanEpoch++; scanning = false; listLoaded = false; clearTimeout(filterTimer); searchQuery = ""; filterMode = "all"; $("inbox-name-search").value = "";
      for (const button of filters.querySelectorAll("[data-filter]")) button.setAttribute("aria-pressed", String(button.dataset.filter === "all"));
      conversationNext = zernioConversationNext = instagramNext = messageNext = null; conversations.clear(); messages.clear(); clearSecrets();
      workflow.clear();
      quoteDrafts.clear(); renderQuote(); renderPins();
      historyMode(false);
      $("line-oa-name").textContent = $("line-webhook-url").value = $("line-channel-id").value = "";
      $("line-step5-webhook").hidden = true;
      $("line-step5-webhook-url").value = $("line-step5-copy-status").textContent = "";
      $("line-conversation-title").textContent = "選擇一段對話";
      $("customer-panel").hidden = true; $("customer-panel").classList.remove("open"); $("customer-toggle").setAttribute("aria-expanded", "false");
      $("line-channel-id").readOnly = false; $("line-connect-fields").disabled = false; $("line-refresh").disabled = false;
      $("line-account").hidden = $("line-inbox").hidden = $("line-connect-form").hidden = $("line-not-connected").hidden = true;
      $("line-card-state").textContent = "讀取中"; $("line-card-state").classList.remove("connected");
      $("instagram-card-state").textContent = "讀取中"; $("instagram-card-state").classList.remove("connected"); $("instagram-connect").disabled = true; $("instagram-account-name").textContent = "尚未綁定 Instagram 帳號"; $("instagram-account-detail").textContent = "請使用 Instagram 商業或創作者帳號授權";
      $("facebook-card-state").textContent = "讀取中"; $("facebook-card-state").classList.remove("connected"); $("facebook-connect").disabled = true;
      $("ai-card-state").textContent = "讀取中"; $("ai-card-state").classList.remove("connected"); $("ai-key-state").textContent = "正在確認 API 連線…"; showAiModel($("ai-model-name"), null, "正在讀取模型…");
      $("ai-reply-indicator").hidden = true;
      showConversations(); showMessages(); status("");
      if (active) void start();
    },
  };
}
