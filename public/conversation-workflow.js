export const workflowIcons = { follow: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="m12 12 8-8M16 4h4v4"/>', link: '<path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>', trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>', assign: '<circle cx="9" cy="7" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3m2-10 4 4-4 4m-4-4h8"/>', complete: '<path d="m4 12 5 5L20 6"/>' };
export function workflowMatches(state = {}, view = "active", uid) {
  if (state.purgedAt) return false;
  if (view === "trash") return !!state.trashed;
  if (state.trashed) return false;
  if (view === "completed") return !!state.completed;
  if (state.completed) return false;
  return view === "followed" ? !!state.followed : view === "assigned" ? state.assignee === uid : true;
}
export function createConversationWorkflow({ request, changed, feedback, getUser }) {
  const style = document.createElement("link"); style.rel = "stylesheet"; style.href = "/conversation-workflow.css"; document.head.append(style);
  const filter = document.createElement("select"); filter.className = "workflow-filter"; filter.setAttribute("aria-label", "對話工作狀態");
  for (const [value, text] of [["active", "處理中"], ["followed", "追蹤中"], ["assigned", "指派給我"], ["completed", "已完成"], ["trash", "垃圾匣"]]) filter.add(new Option(text, value));
  document.querySelector(".conversation-toolbar").append(filter); filter.onchange = changed;
  let retention = null;
  let states = new Map(), busy = new Set(), generation = 0, lastLoad = 0;
  const state = id => states.get(id) || {};
  async function load(force = false) {
    if (!force && Date.now() - lastLoad < 30000) return;
    const version = generation; const data = await request(); if (version !== generation) return;
    retention = data.retention || retention;
    for (const item of data.items) if ((item.revision || 0) >= (states.get(item.id)?.revision || 0)) states.set(item.id, item); lastLoad = Date.now(); changed();
  }
  async function act(id, action, value, quiet = false) {
    if (action === "link") { const url = new URL(location.href); url.searchParams.set("conversation", id); url.hash = "ai-robot"; try { await navigator.clipboard.writeText(url.href); feedback("已複製對話連結；開啟時需登入原帳號。"); } catch { feedback("無法複製，請確認瀏覽器的剪貼簿權限。"); } return; }
    if (busy.has(id)) return;
    const current = state(id), version = generation; const field = ({ follow: "followed", trash: "trashed", complete: "completed", assign: "assignee" })[action];
    busy.add(id); changed();
    try { const data = await request({ method: "PUT", body: JSON.stringify({ id, action, value: value ?? !current[field], revision: current.revision || 0 }) }); if (version !== generation) return; states.set(id, data.item); if (!quiet) feedback(({ follow: data.item.followed ? "已標記追蹤。" : "已取消追蹤。", trash: data.item.trashed ? "已移至垃圾匣，訊息保留，可從垃圾匣還原。" : "已還原對話。", complete: data.item.completed ? "已完成此對話。" : "已重新開啟對話。", assign: data.item.assignee ? "已指派給自己。" : "已取消指派。" })[action]); return data.item; }
    catch (e) { if (quiet) { if (version === generation && e.status === 409) try { await load(true); } catch {} throw e; } if (version === generation) { feedback(e.message); try { await load(true); } catch {} } }
    finally { if (version === generation) { busy.delete(id); changed(); } }
  }
  async function messageAct(id, action, messageId, value = true) {
    if (busy.has(id)) return;
    const version = generation; busy.add(id); changed();
    try {
      const data = await request({ method: "PUT", body: JSON.stringify({ id, action, messageId, value, revision: state(id).revision || 0 }) });
      if (version !== generation) return;
      states.set(id, data.item); feedback(action === "pin" ? value ? "已釘選訊息。" : "已取消釘選。" : action === "unread" ? "已標記未讀，下次開啟對話會清除標記。" : "");
      return data.item;
    } catch (e) { if (version === generation) { feedback(e.message); await load(true).catch(() => {}); } }
    finally { if (version === generation) { busy.delete(id); changed(); } }
  }
  return { load, act, messageAct, state: id => ({ ...state(id), busy: busy.has(id) }), view: () => filter.value, reveal(id) { const s = state(id); filter.value = s.trashed ? "trash" : s.completed ? "completed" : "active"; }, filter: items => items.filter(item => workflowMatches(state(item.id), filter.value, getUser()?.uid)),
    toolbar(id) {
      const row = document.createElement("div"); row.className = "workflow-actions"; row.setAttribute("role", "group"); row.setAttribute("aria-label", "對話操作");
      const s = state(id);
      for (const [action, label, active] of [["follow", s.followed ? "取消追蹤" : "標記追蹤", s.followed], ["link", "複製對話連結", false], ["trash", s.trashed ? "還原對話" : "移至垃圾匣", s.trashed], ["assign", s.assignee ? "取消指派給自己" : "指派給自己", !!s.assignee], ["complete", s.completed ? "重新開啟對話" : "完成此對話", s.completed]]) {
        const button = document.createElement("button"); button.type = "button"; button.title = label; button.setAttribute("aria-label", label); if (action !== "link") button.setAttribute("aria-pressed", String(!!active)); button.disabled = busy.has(id); button.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${workflowIcons[action]}</svg>`; button.onclick = event => { event.stopPropagation(); void act(id, action); }; row.append(button);
      }
      if (s.trashed) { const note = document.createElement("span"); note.className = "workflow-trash-deadline";
        const deadline = retention ? Math.max(s.trashedAt || retention.preparedAt, retention.preparedAt) + retention.trashDays * 86400000 : null;
        note.textContent = s.purging ? "正在永久清除" : !retention?.enabled ? "自動清除尚未啟用 · 可還原" : `最早 ${new Date(Math.max(deadline, retention.effectiveAt)).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" })} 清除 · 可還原`;
        row.append(note); }
      return row;
    }, clear() { generation++; states.clear(); retention = null; busy.clear(); lastLoad = 0; filter.value = "active"; }
  };
}
