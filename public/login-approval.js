const $ = id => document.getElementById(id);
// Fragments are not sent in HTTP requests or Referer headers. Drop from history immediately.
const ticket = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
let expiresAt = 0, busy = false;
const status = (text, error = false) => { $("approval-status").textContent = text; $("approval-status").classList.toggle("error", error); };
async function api(path, decision) {
  const response = await fetch(`/api/login-security/${path}`, { method: "POST", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket, ...(decision ? { decision } : {}) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "驗證暫時無法完成。");
  return data;
}
async function decide(decision) {
  if (busy) return; busy = true;
  $("approve").disabled = $("deny").disabled = true;
  try {
    await api("decision", decision);
    status(decision === "approve" ? "已核准，請回到原本登入的裝置；該頁會自動更新。" : "已拒絕，此裝置無法存取帳號資料。若不是你本人操作，請到原本的登入服務修改密碼，並檢查其他登入裝置。");
    $("approval-details").textContent = "驗證連結已使用，無法重複操作。";
  } catch (error) { status(error.name === "TimeoutError" ? "連線逾時，請重試；若已完成操作，連結會顯示已使用。" : error.message, true); busy = false; $("approve").disabled = $("deny").disabled = Date.now() >= expiresAt; }
}
$("approve").addEventListener("click", () => void decide("approve"));
$("deny").addEventListener("click", () => void decide("deny"));
try {
  const data = await api("review"); expiresAt = data.expiresAt;
  $("approval-details").textContent = `裝置：${data.label}｜網路：${data.network}｜時間：${new Date(data.at).toLocaleString("zh-TW")}。裝置與網路資訊僅供辨識參考。`;
  status("這次登入仍在等待核准。連結於 15 分鐘後失效，開啟此頁不會自動授權。");
  $("approve").disabled = $("deny").disabled = false;
} catch (error) { status(error.name === "TimeoutError" ? "讀取逾時，請重新開啟 Email 中的連結。" : error.message, true); }
