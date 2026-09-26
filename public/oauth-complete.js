import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const status = document.getElementById("status");
try {
  const configResponse = await fetch("/firebase-config.json", { cache: "no-store" });
  if (!configResponse.ok) throw new Error("設定暫時無法讀取。");
  const auth = getAuth(initializeApp(await configResponse.json()));
  await auth.authStateReady();
  if (!auth.currentUser) throw new Error("請回到開始連接的原帳號與裝置，重新進行連接。");
  const response = await fetch("/api/zernio/complete", { method: "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await auth.currentUser.getIdToken()}` },
    body: JSON.stringify(Object.fromEntries(params)) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "連接未完成，請回渠道設定重試。");
  const redirect = new URL(data.redirectUrl);
  if (redirect.origin !== "https://planning-with-ai-52d58.web.app" || redirect.pathname !== "/") throw new Error("回傳網址無效。");
  location.replace(redirect.href);
} catch (error) {
  status.textContent = error.name === "TimeoutError" ? "驗證逾時，請返回渠道設定確認連接狀態。" : "連接未完成。請使用原本已核准的登入裝置返回渠道設定重試。";
}
