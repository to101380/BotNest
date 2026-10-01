const $ = id => document.getElementById(id);
const methods = { "google.com": "Google", password: "Email／密碼", "facebook.com": "Facebook", phone: "手機" };
const date = value => value ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "short" }) : "未記錄";
const number = value => Number(value || 0).toLocaleString("zh-TW");
export function createAdminPanel(request) {
  let items = [], cursors = [null], page = 0, next = null, busy = false, generation = 0, target = null;
  const status = (message, error = false) => { $("status").textContent = message; $("status").classList.toggle("error", error); };
  $("month").value = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
  function controls() {
    $("refresh").disabled = $("month").disabled = busy;
    $("prev").disabled = busy || page === 0; $("next").disabled = busy || !next;
    for (const button of $("users").querySelectorAll("button")) button.disabled = busy;
  }
  function cell(tr, primary, secondary) {
    const td = document.createElement("td"), title = document.createElement("span"); title.textContent = primary; td.append(title);
    if (secondary) { const small = document.createElement("small"); small.textContent = secondary; td.append(small); }
    tr.append(td); return td;
  }
  function render() {
    $("count").textContent = number(items.length); $("active").textContent = number(items.filter(u => !u.disabled).length);
    $("disabled").textContent = number(items.filter(u => u.disabled).length); $("requests").textContent = number(items.reduce((sum, u) => sum + u.usage.requests, 0));
    $("month-label").textContent = `${$("month").value} · 台北時間`;
    $("page-label").textContent = `第 ${page + 1} 頁 · 本頁 ${items.length} 位`;
    const query = $("search").value.trim().toLocaleLowerCase(); $("users").replaceChildren();
    for (const user of items.filter(u => [u.name, u.email, u.uid].some(v => v.toLocaleLowerCase().includes(query)))) {
      const tr = document.createElement("tr");
      cell(tr, user.name, `${user.email || "未提供 Email"} · UID ${user.uid}`);
      cell(tr, user.providers.map(p => methods[p] || p).join("、") || "未提供登入方式", `註冊 ${date(user.createdAt)}；最近登入 ${date(user.lastSignInAt)}；最初註冊來源未記錄`);
      cell(tr, user.platforms.map(p => p.provider).join("、") || "尚未連線", user.platforms.map(p => p.name).join("、"));
      cell(tr, "尚未設定方案", "訂閱與配額尚未啟用");
      const u = user.usage;
      cell(tr, `${number(u.requests)} 次 AI 請求`, `${number(u.images)} 張圖片 · ${(u.audioMs / 60000).toFixed(1)} 分鐘語音 · ${number(u.inputTokens + u.outputTokens)} AI tokens · 估算 US$ ${(u.nanoUsd / 1e9).toFixed(4)}${u.unknownCost ? `（${u.unknownCost} 次成本未知）` : ""} · ${u.pending} 次待確認${user.usageRecorded ? "" : "；此月尚無用量紀錄"}`);
      const state = cell(tr, "", user.syncError || user.pending ? "同步未完成，請重新整理後重試" : user.protected ? "指定管理者" : "");
      state.firstChild.className = `badge${user.disabled ? " off" : ""}`; state.firstChild.textContent = user.disabled ? "已停用" : "可使用";
      const action = cell(tr, "");
      if (!user.protected) {
        const retry = (user.syncError || user.pending) && typeof user.desiredDisabled === "boolean";
        const disabled = retry ? user.desiredDisabled : !user.disabled;
        const button = document.createElement("button"); button.textContent = retry ? "重試同步" : user.disabled ? "恢復使用" : "停用帳號";
        button.addEventListener("click", () => {
          target = { ...user, nextDisabled: disabled };
          $("confirm-title").textContent = disabled ? "停用此帳號？" : "恢復帳號使用？";
          $("confirm-user").textContent = `${user.name} · ${user.email || user.uid}`;
          $("confirm-detail").textContent = !disabled ? "用戶需重新登入。恢復後，AI 將依原本設定繼續運作。" : "將阻擋登入、網站操作與新的 AI 自動回覆，保留帳號資料。已送出的訊息不會撤回。你可隨時恢復使用。";
          $("confirm").showModal();
        }); action.append(button);
      }
      $("users").append(tr);
    }
    if (!$("users").children.length) { const tr = document.createElement("tr"); cell(tr, "沒有符合條件的用戶").colSpan = 7; $("users").append(tr); }
    controls();
  }
  async function load() {
    if (busy) return;
    busy = true; controls(); const version = generation;
    status("正在讀取用戶資料…");
    try {
      const query = new URLSearchParams({ month: $("month").value }); if (cursors[page]) query.set("cursor", cursors[page]);
      const data = await request(`/api/ai/admin/users?${query}`);
      if (version !== generation) return;
      items = data.items; next = data.next; render(); $("dashboard").hidden = false;
      status(`更新於 ${date(data.updatedAt)} · 僅指定 Google 管理者可存取`);
    } catch (error) { if (version === generation) { $("dashboard").hidden = true; items = []; $("users").replaceChildren(); status(error.message, true); } }
    finally { if (version === generation) { busy = false; controls(); } }
  }
  $("confirm").addEventListener("close", async () => {
    const user = target; target = null;
    if ($("confirm").returnValue !== "confirm" || !user || busy) return;
    const version = generation; busy = true; controls(); status("正在更新帳號狀態…");
    let error;
    try { await request("/api/ai/admin/access", { method: "PUT", body: JSON.stringify({ uid: user.uid, disabled: user.nextDisabled, revision: user.revision }) }); }
    catch (e) { error = e; }
    finally { if (version === generation) { busy = false; await load(); if (error) status(error.message, true); } }
  });
  $("search").addEventListener("input", render);
  $("refresh").onclick = () => void load();
  $("month").onchange = () => { page = 0; cursors = [null]; void load(); };
  $("prev").onclick = () => { if (!busy && page > 0) { page--; void load(); } };
  $("next").onclick = () => { if (!busy && next) { cursors[++page] = next; void load(); } };
  return { load, status, reset() { generation++; items = []; page = 0; cursors = [null]; next = null; busy = false; target = null; if ($("confirm").open) $("confirm").close("cancel"); $("users").replaceChildren(); $("dashboard").hidden = true; controls(); } };
}
