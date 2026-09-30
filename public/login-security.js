const time = at => at ? new Date(at).toLocaleString("zh-TW", { hour12: false }) : "—";
const labels = { approval_requested: "新裝置申請登入，等待核准", approved: "Email 已核准登入", denied: "已拒絕登入", login: "已核准裝置登入", revoked: "已登出裝置", mail_sent: "驗證信已交付寄信服務", mail_failed: "驗證信寄送失敗" };
export function createLoginSecurityPanel({ onAccessChange, onSignOut }) {
  const $ = id => document.getElementById(id);
  let user = null, epoch = 0, timer, controller, access = false, currentDevice = null, loading = false, lastCheck = 0, revokeTarget = null;
  function allow(value) { if (access !== value) { access = value; onAccessChange(); } }
  function message(text, error = false) { $("login-security-status").textContent = text; $("login-security-status").classList.toggle("error", error); }
  async function api(path, method = "GET", body, version = epoch) {
    const current = user, token = await current.getIdToken();
    if (version !== epoch) throw new DOMException("Session changed", "AbortError");
    const response = await fetch(`/api/login-security/${path}`, { method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (version !== epoch) throw new DOMException("Session changed", "AbortError");
    if (!response.ok) { const error = new Error(data.error || "無法讀取登入安全資料。"); error.status = response.status; throw error; }
    return data;
  }
  function clearPrivate() { $("login-security-content").hidden = true; $("login-devices").replaceChildren(); $("login-events").replaceChildren(); revokeTarget = null; $("login-revoke-confirm").hidden = true; }
  function renderOverview(data) {
    $("login-devices").replaceChildren(); $("login-events").replaceChildren();
    for (const device of data.devices) {
      const row = document.createElement("li"), details = document.createElement("div"), title = document.createElement("strong"), meta = document.createElement("span"), button = document.createElement("button");
      title.textContent = `${device.label}${device.current ? " · 目前裝置" : ""}`;
      meta.textContent = `${device.state === "pending" ? "待核准" : "已核准"} · 最近活動 ${time(device.lastSeenAt)} · 網路 ${device.network}`;
      details.append(title, meta); button.type = "button"; button.textContent = device.current ? "登出此裝置" : device.state === "pending" ? "拒絕此裝置" : "登出裝置";
      button.addEventListener("click", () => confirmRevoke(device.id, device.current)); row.append(details, button); $("login-devices").append(row);
    }
    for (const item of data.events) {
      const row = document.createElement("tr");
      for (const value of [time(item.at), labels[item.type] || "帳號安全事件", `${item.label} · ${item.network}`]) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
      $("login-events").append(row);
    }
    $("login-security-content").hidden = false;
  }
  async function refresh(begin = false) {
    if (!user || loading || !user.emailVerified) return;
    loading = true; lastCheck = Date.now(); const version = epoch;
    controller?.abort(); controller = new AbortController();
    const requestController = controller, timeout = setTimeout(() => requestController.abort(), 20000);
    $("login-security-refresh").disabled = $("login-security-retry").disabled = true;
    try {
      const state = await api("session", begin ? "POST" : "GET", begin ? {} : undefined, version);
      currentDevice = state.deviceId;
      allow(state.access === true);
      $("login-security-retry").hidden = state.access || ["denied", "revoked"].includes(state.state);
      if (state.access) {
        message("此裝置已核准。新裝置須透過 Email 確認後才能存取帳號資料。");
        renderOverview(await api("overview", "GET", undefined, version));
      } else {
        clearPrivate();
        const notes = { pending: state.mailState === "failed" ? "驗證信尚未寄出，登入仍被阻擋。請稍候一分鐘再重試。" : state.mailState === "sending" ? "正在寄送驗證信，登入仍在等待核准。" : `新裝置尚未核准。請查看 ${user.email} 的驗證信，15 分鐘內確認後回到此頁。`,
          expired: "驗證信已過期，請重新寄送；若登入已超過 10 分鐘，請先登出再登入。", denied: "這次登入已被拒絕，無法存取帳號資料。", revoked: "此裝置已被登出，請重新登入。", missing: "此裝置尚未建立登入驗證，請按「寄送驗證信／重試」。", active: "裝置授權已過期，請登出後重新登入。" };
        message(notes[state.state] || "請完成裝置驗證。", ["denied", "revoked", "expired"].includes(state.state) || state.mailState === "failed");
      }
    } catch (error) {
      if (version === epoch) { allow(false); clearPrivate(); $("login-security-retry").hidden = false; message(error.name === "AbortError" ? "驗證連線逾時，請重試。" : error.message, true); }
    } finally {
      clearTimeout(timeout);
      if (version === epoch) { loading = false; $("login-security-refresh").disabled = $("login-security-retry").disabled = false; }
    }
  }
  function confirmRevoke(id, current = false) {
    if (loading || !access) return;
    revokeTarget = { id, current };
    $("login-revoke-message").textContent = id === "others" ? "確定登出所有其他裝置？其他裝置需再次通過 Email 驗證。" : "確定登出／拒絕這個裝置？";
    $("login-revoke-confirm").hidden = false;
    $("login-revoke-yes").focus();
  }
  async function revoke(id, current = false) {
    if (loading || !access) return;
    $("login-revoke-confirm").hidden = true; revokeTarget = null;
    loading = true; const version = epoch;
    controller?.abort(); controller = new AbortController();
    const requestController = controller, timeout = setTimeout(() => requestController.abort(), 15000);
    try {
      await api("revoke", "POST", { deviceId: id }, version);
      if (current) { allow(false); clearPrivate(); await onSignOut(); }
      else message("已撤銷裝置的存取權。");
    } catch (error) { if (version === epoch) message(error.name === "AbortError" ? "操作結果尚未確認，請重新整理。" : error.message, true); }
    finally { clearTimeout(timeout); if (version === epoch) { loading = false; void refresh(); } }
  }
  $("login-security-refresh").addEventListener("click", () => void refresh());
  $("login-security-retry").addEventListener("click", () => void refresh(true));
  $("login-revoke-others").addEventListener("click", () => confirmRevoke("others"));
  $("login-revoke-yes").addEventListener("click", () => { if (revokeTarget) void revoke(revokeTarget.id, revokeTarget.current); });
  $("login-revoke-cancel").addEventListener("click", () => { revokeTarget = null; $("login-revoke-confirm").hidden = true; });
  return {
    get allowed() { return access; },
    setSession(next) {
      epoch++; clearInterval(timer); controller?.abort(); user = next; loading = false; currentDevice = null; allow(false); clearPrivate();
      revokeTarget = null; $("login-revoke-confirm").hidden = true;
      $("login-security").hidden = !user;
      $("login-security-retry").hidden = !user?.emailVerified;
      $("login-security-refresh").disabled = !user?.emailVerified;
      message(user?.emailVerified ? "正在確認裝置登入狀態…" : "請先完成上方 Email 驗證，再驗證登入裝置。");
      if (user?.emailVerified) { void refresh(true); timer = setInterval(() => { if (!document.hidden && (!access || Date.now() - lastCheck >= 60000)) void refresh(); }, 10000); }
    },
    async logout() {
      if (!user || !access || !currentDevice) return;
      // Local sign-out still happens when the network is unavailable; report failure to revoke.
      const token = await user.getIdToken();
      const response = await fetch("/api/login-security/revoke", { method: "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: currentDevice }) });
      if (!response.ok) throw new Error("無法確認伺服器端登出，請從其他裝置檢查登入清單。");
    },
  };
}
