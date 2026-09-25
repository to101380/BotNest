import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
const $ = id => document.getElementById(id);
let auth, timer, generation = 0, loading = false;
const status = (message, error = false) => { $("status").textContent = message; $("status").classList.toggle("error", error); };
const clock = at => new Date(at).toLocaleString("zh-TW", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" });
function render(data) {
  const audit = data.permissions;
  $("permission-status").textContent = audit?.available ? `已接入 Cloud Audit Logs · 近 24 小時 ${audit.more ? "至少 " : ""}${audit.events.length} 筆 IAM 政策設定事件。事件不代表一定授予外人權限；請核對操作者及資源。雲端紀錄可能延遲。` : audit?.reason || "尚未接收到雲端 IAM 稽核狀態。";
  $("permission-status").classList.toggle("error", !audit?.available || !!audit?.events.length);
  $("permission-events").replaceChildren();
  for (const item of audit?.events || []) { const li = document.createElement("li"); li.textContent = `${clock(item.at)} · ${item.actor} · ${item.failed ? "變更失敗" : "政策設定"} · ${item.resource} · ${(item.changes || []).map(change => `${change.action === "ADD" ? "新增授權" : change.action === "REMOVE" ? "移除授權" : change.action}：${change.member} (${change.role})`).join("；") || "此紀錄未提供權限差異，需到 Cloud Audit Logs 核對"}`; $("permission-events").append(li); }
  $("cards").replaceChildren();
  for (const [key, label] of Object.entries(data.labels)) {
    const card = document.createElement("article"); card.className = "card";
    const value = data.totals[key] || 0;
    if (value && ["denied","webhookRejected","errors","aiFailed","aiLimited","injection","monitorDenied","throttled"].includes(key)) card.classList.add("alert");
    const title = document.createElement("span"), number = document.createElement("strong"); title.textContent = label; number.textContent = value.toLocaleString(); card.append(title, number); $("cards").append(card);
  }
  $("events").replaceChildren();
  const rows = data.buckets.filter(row => Object.keys(row.counts).some(key => !["requests","aiSent","downloads"].includes(key))).slice(-60).reverse();
  for (const row of rows) { const tr = document.createElement("tr"); for (const value of [clock(row.bucket * 300000), Object.entries(row.counts).filter(([key]) => key !== "requests").map(([key, count]) => `${data.labels[key] || key} × ${count}`).join(" · "), row.counts.requests || 0]) { const td = document.createElement("td"); td.textContent = value; tr.append(td); } $("events").append(tr); }
  if (!rows.length) { const tr = document.createElement("tr"), td = document.createElement("td"); td.colSpan = 3; td.textContent = "此期間尚無異常或設定操作紀錄；不等於已確認安全。"; tr.append(td); $("events").append(tr); }
}
async function refresh() {
  if (!auth?.currentUser || loading) return;
  loading = true; const version = generation; $("refresh").disabled = true;
  try {
    const token = await auth.currentUser.getIdToken();
    const response = await fetch("/api/security-monitor", { headers: { Authorization: `Bearer ${token}` }, cache:"no-store", signal:AbortSignal.timeout(15000) });
    const data = await response.json(); if (version !== generation) return;
    if (!response.ok) throw new Error(data.error || "無法讀取監控資料。");
    render(data); $("dashboard").hidden = false;
    status(`更新時間 ${clock(data.now)} · ${data.lastObservedAt ? `最近訊號 ${clock(data.lastObservedAt)}` : "尚未收到訊號，請勿視為系統正常"}`);
  } catch (error) { if (version === generation) { $("dashboard").hidden = true; clearInterval(timer); status(error.message || "監測中斷，請重新整理。", true); } }
  finally { loading = false; $("refresh").disabled = false; }
}
$("refresh").onclick = () => void refresh();
$("login").onclick = async () => { try { const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt:"select_account" }); await signInWithPopup(auth, provider); } catch { status("Google 驗證未完成，請重試。", true); } };
$("logout").onclick = () => signOut(auth);
try {
  const response = await fetch("/firebase-config.json"); if (!response.ok) throw new Error();
  auth = getAuth(initializeApp(await response.json()));
  onAuthStateChanged(auth, user => { generation++; clearInterval(timer); $("dashboard").hidden = true; $("cards").replaceChildren(); $("events").replaceChildren(); $("logout").hidden = !user; status(user ? "正在驗證監看權限…" : "請使用指定的 Google 帳號登入。"); if (user) { void refresh(); timer = setInterval(() => { if (!document.hidden) void refresh(); }, 60000); } });
} catch { status("登入服務初始化失敗，請重新整理。", true); }
