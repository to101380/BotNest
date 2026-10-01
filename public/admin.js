import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, reauthenticateWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import { createAdminPanel } from "./admin-panel.js";
let auth;
const panel = createAdminPanel(async (url, options = {}) => {
  const user = auth?.currentUser;
  if (!user) throw new Error("請先使用指定的 Google 帳號登入。");
  const token = await user.getIdToken();
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(25000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "管理服務暫時無法使用。");
  return data;
});
document.getElementById("login").onclick = async () => {
  try {
    const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: "select_account" });
    if (auth.currentUser) { await reauthenticateWithPopup(auth.currentUser, provider); await panel.load(); }
    else await signInWithPopup(auth, provider);
  } catch { panel.status("Google 驗證未完成，請確認使用指定管理者帳號。", true); }
};
document.getElementById("logout").onclick = () => signOut(auth);
try {
  const response = await fetch("/firebase-config.json"); if (!response.ok) throw new Error();
  auth = getAuth(initializeApp(await response.json()));
  onAuthStateChanged(auth, user => {
    panel.reset(); document.getElementById("logout").hidden = !user;
    if (user) void panel.load(); else panel.status("請使用指定的 Google 管理者帳號登入。");
  });
} catch { panel.status("登入服務初始化失敗，請重新整理。", true); }
