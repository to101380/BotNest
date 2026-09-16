import { hasFirebaseConfig, providerName, authErrorMessage, linkProviderAccount, reauthenticateForLink, validateEmailRegistration, reauthenticatePasswordForLink, linkEmailPassword } from "./auth-helpers.js";
import { createLineInbox } from "./line-inbox.js";
import { createCustomerManager } from "./customer-manager.js";
const $ = id => document.getElementById(id);
const lineInbox = createLineInbox();
const customerManager = createCustomerManager();
let auth;
let sdk;
let busy = false;
let emailMode = "login";
let mailReadyAt = 0;
let linkProof = null;
let proofTimeout;
function renderPage(moveFocus = false) {
  const signedIn = !!auth?.currentUser;
  const aiPage = signedIn && location.hash === "#ai-robot";
  const customersPage = signedIn && location.hash === "#customers";
  $("app-nav").hidden = !signedIn;
  document.body.classList.toggle("authenticated", signedIn);
  $("account-page").hidden = aiPage || customersPage;
  $("ai-page").hidden = !aiPage;
  $("customers-page").hidden = !customersPage;
  const pageTitle = aiPage ? "ai-title" : customersPage ? "customers-title" : "welcome";
  $("signed-in").setAttribute("aria-labelledby", pageTitle);
  document.querySelector(".login-card").setAttribute("aria-labelledby", signedIn ? pageTitle : "title");
  document.body.classList.toggle("inbox-open", aiPage || customersPage);
  document.body.classList.toggle("customers-open", customersPage);
  lineInbox.setSession(auth?.currentUser || null, aiPage);
  customerManager.setSession(auth?.currentUser || null, customersPage);
  for (const [id, active] of [["nav-account", !aiPage && !customersPage], ["nav-ai", aiPage], ["nav-customers", customersPage]]) {
    if (signedIn && active) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
  document.title = signedIn ? `${aiPage ? "AI機器人" : customersPage ? "顧客管理" : "帳號資訊"}｜Identity` : "登入｜Identity";
  if (moveFocus && (aiPage || customersPage)) $(pageTitle).focus();
}
window.addEventListener("hashchange", () => renderPage(true));
function clearLinkProof() {
  linkProof = null;
  clearTimeout(proofTimeout);
  $("link-google").textContent = "連結 Google 帳號";
  $("link-facebook").textContent = "連結 Facebook 帳號";
}
const setStatus = (text, error = false) => { $("status").textContent = text; $("status").classList.toggle("error", error); };
function controls() {
  $("google").disabled = $("facebook").disabled = !auth || busy;
  $("logout").disabled = busy;
  $("add-password-fields").disabled = busy || !auth?.currentUser?.emailVerified;
  $("email-fields").disabled = !auth || busy;
  $("mode-login").disabled = $("mode-register").disabled = busy;
  $("send-verification").disabled = $("refresh-verification").disabled = !auth?.currentUser || busy;
  $("link-google").disabled = $("link-facebook").disabled = !auth?.currentUser || busy;
}
function renderAvatar(user) {
  const avatar = $("avatar");
  avatar.replaceChildren();
  const initial = Array.from(user?.displayName || user?.email || "U")[0].toUpperCase();
  avatar.textContent = user ? initial : "";
  const photos = [...new Set([user?.photoURL, ...(user?.providerData || []).map(p => p.photoURL)])].filter(value => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password &&
        ["googleusercontent.com", "facebook.com", "fbcdn.net"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
    } catch { return false; }
  });
  const loadNext = () => {
    if (!photos.length) return;
    const photo = document.createElement("img");
    photo.alt = "你的大頭照";
    photo.referrerPolicy = "no-referrer";
    photo.onload = () => { if (avatar.dataset.uid === user.uid) avatar.replaceChildren(photo); };
    photo.onerror = () => { if (avatar.dataset.uid === user.uid) loadNext(); };
    photo.src = photos.shift();
  };
  avatar.dataset.uid = user?.uid || "";
  loadNext();
}
function render(user) {
  clearLinkProof();
  $("account-password").value = $("confirm-password").value = $("reauth-password").value = $("new-password").value = $("new-password-confirm").value = "";
  $("signed-out").hidden = !!user;
  $("signed-in").hidden = !user;
  renderPage();
  $("state").textContent = user ? "已登入" : "尚未登入";
  $("state").classList.toggle("active", !!user);
  $("welcome").textContent = user?.displayName ? `你好，${user.displayName}` : "登入成功";
  $("email").textContent = user ? (user.email || "此登入方式未提供電子郵件") : "";
  renderAvatar(user);
  $("uid").value = user?.uid || "";
  $("provider-list").replaceChildren();
  const linked = new Set(user?.providerData.map(provider => provider.providerId) || []);
  $("add-password-panel").hidden = !user?.email || linked.has("password");
  $("password-email").value = user?.email || "";
  $("email-verification").hidden = !user?.email || user.emailVerified;
  $("password-reauth-group").hidden = !user || !linked.has("password") || linked.has("google.com") || linked.has("facebook.com");
  $("link-google").hidden = !user || linked.has("google.com");
  $("link-facebook").hidden = !user || linked.has("facebook.com");
  $("link-panel").hidden = !user || (linked.has("google.com") && linked.has("facebook.com"));
  for (const provider of user?.providerData || []) {
    const item = document.createElement("li");
    const id = document.createElement("code");
    item.append(document.createTextNode(providerName(provider.providerId)));
    id.textContent = `Provider ID：${provider.uid}`;
    item.append(id);
    $("provider-list").append(item);
  }
  setStatus(user ? "登入成功。你的帳號身分由 Firebase Authentication 管理。" : "請選擇登入方式。");
  controls();
}
async function initialize() {
  if (auth || busy) return;
  busy = true;
  $("retry").hidden = true;
  setStatus("正在讀取登入設定…");
  try {
    const response = await fetch("/firebase-config.json", { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("config");
    const config = await response.json();
    if (!hasFirebaseConfig(config)) {
      $("setup").hidden = false;
      $("state").textContent = "尚未設定";
      setStatus("尚未連接 Firebase，完成下方設定後即可登入。");
      $("retry").hidden = false;
      return;
    }
    // Load pinned official SDK modules only after a real project is configured.
    const [appSdk, authSdk] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js"),
    ]);
    sdk = authSdk;
    const candidate = sdk.getAuth(appSdk.getApps()[0] || appSdk.initializeApp(config));
    candidate.languageCode = "zh-TW";
    await sdk.setPersistence(candidate, sdk.browserSessionPersistence);
    auth = candidate;
    $("setup").hidden = true;
    sdk.onAuthStateChanged(auth, render, () => setStatus("無法讀取登入狀態，請重新整理頁面。", true));
  } catch {
    $("setup").hidden = false;
    $("state").textContent = "連線未完成";
    $("retry").hidden = false;
    setStatus("無法載入登入服務，請確認 Firebase 設定及網路連線。", true);
  } finally { busy = false; controls(); }
}
function makeProvider(kind) {
  const provider = kind === "google" ? new sdk.GoogleAuthProvider() : new sdk.FacebookAuthProvider();
  if (kind === "google") provider.setCustomParameters({ prompt: "select_account" });
  else provider.addScope("email");
  return provider;
}
async function linkAccount(kind) {
  if (!auth?.currentUser || busy) return;
  busy = true;
  controls();
  try {
    const target = makeProvider(kind);
    if (!linkProof || linkProof.uid !== auth.currentUser.uid || linkProof.target !== target.providerId || Date.now() - linkProof.at > 60000) {
      clearLinkProof();
      const existing = auth.currentUser.providerData.find(p => ["google.com", "facebook.com"].includes(p.providerId));
      if (!existing) {
        try { linkProof = await reauthenticatePasswordForLink(auth, sdk, $("reauth-password").value, target.providerId); }
        finally { $("reauth-password").value = ""; }
      } else {
      setStatus(`請先透過已連結的 ${providerName(existing.providerId)} 重新驗證身分。`);
      const original = makeProvider(existing.providerId === "google.com" ? "google" : "facebook");
      if (existing.providerId === "facebook.com") original.setCustomParameters({ auth_type: "reauthenticate" });
      linkProof = await reauthenticateForLink(auth, sdk, original, target.providerId);
      }
      $(kind === "google" ? "link-google" : "link-facebook").textContent = `確認連結 ${kind === "google" ? "Google" : "Facebook"}`;
      setStatus("身分已重新驗證。請在 60 秒內點「確認連結」，再授權要新增的帳號。");
      proofTimeout = setTimeout(() => { clearLinkProof(); if (!busy) setStatus("連結驗證已逾時，請重新開始。"); }, 60000);
      return;
    }
    setStatus("正在開啟新登入方式的授權視窗…");
    const proof = linkProof;
    clearLinkProof();
    const user = await linkProviderAccount(auth, sdk, target, proof);
    render(user);
    setStatus("連結成功！已連結的登入方式共用同一個 Firebase UID。");
  } catch (error) { clearLinkProof(); setStatus(authErrorMessage(error), true); }
  finally { busy = false; controls(); }
}
async function signIn(kind) {
  if (!auth || busy) return;
  busy = true;
  controls();
  const provider = makeProvider(kind);
  setStatus(`正在開啟 ${kind === "google" ? "Google" : "Facebook"} 登入視窗…`);
  try { await sdk.signInWithPopup(auth, provider); }
  catch (error) { setStatus(authErrorMessage(error), true); }
  finally { busy = false; controls(); }
}
$("google").addEventListener("click", () => signIn("google"));
$("facebook").addEventListener("click", () => signIn("facebook"));
$("link-google").addEventListener("click", () => linkAccount("google"));
$("link-facebook").addEventListener("click", () => linkAccount("facebook"));
$("logout").addEventListener("click", async () => {
  if (!auth || busy) return;
  busy = true;
  controls();
  try { await sdk.signOut(auth); }
  catch (error) { setStatus(authErrorMessage(error), true); }
  finally { busy = false; controls(); }
});
$("copy").addEventListener("click", async () => {
  if (!auth?.currentUser) return;
  try { await navigator.clipboard.writeText(auth.currentUser.uid); setStatus("已複製 Firebase UID。"); }
  catch { $("uid").select(); setStatus("請手動複製已選取的 UID。"); }
});
$("retry").addEventListener("click", initialize);
function setEmailMode(mode) {
  if (busy) return;
  emailMode = mode;
  $("mode-login").setAttribute("aria-pressed", String(mode === "login"));
  $("mode-register").setAttribute("aria-pressed", String(mode === "register"));
  $("password-group").hidden = mode === "reset";
  $("account-password").required = mode !== "reset";
  $("account-password").autocomplete = mode === "register" ? "new-password" : "current-password";
  $("account-password").minLength = mode === "register" ? 12 : 1;
  $("confirm-group").hidden = mode !== "register";
  $("confirm-password").required = mode === "register";
  $("account-password").value = $("confirm-password").value = "";
  $("email-submit").textContent = {login:"使用 Email 登入", register:"註冊 Email 帳號", reset:"寄送密碼重設信"}[mode];
  $("forgot-password").hidden = mode === "reset";
  setStatus(mode === "reset" ? "輸入 Email 後，我們會透過 Firebase 寄送密碼重設指引。" : mode === "register" ? "請使用你能收信的 Email 註冊。" : "請輸入 Email 與密碼。");
}
$("mode-login").addEventListener("click", () => setEmailMode("login"));
$("mode-register").addEventListener("click", () => setEmailMode("register"));
$("forgot-password").addEventListener("click", () => setEmailMode("reset"));
const emailActionSettings = {url:"https://planning-with-ai-52d58.web.app/", handleCodeInApp:false};
$("email-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!auth || busy) return;
  const email = $("account-email").value.trim();
  const password = $("account-password").value;
  const mode = emailMode;
  if (mode === "register") {
    const error = validateEmailRegistration(email, password, $("confirm-password").value);
    if (error) return setStatus(error, true);
  }
  if (mode === "reset" && Date.now() < mailReadyAt) return setStatus("請稍候一分鐘再寄送郵件。", true);
  busy = true;
  controls();
  setStatus(mode === "register" ? "正在建立帳號…" : mode === "reset" ? "正在處理重設要求…" : "正在登入…");
  try {
    if (mode === "register") {
      const policy = await sdk.validatePassword(auth, password);
      if (!policy.isValid) throw {code:"auth/password-does-not-meet-requirements"};
      const result = await sdk.createUserWithEmailAndPassword(auth, email, password);
      render(result.user);
      try {
        mailReadyAt = Date.now() + 60000;
        await sdk.sendEmailVerification(result.user, emailActionSettings);
        setStatus("帳號已建立，驗證信已寄出。請檢查收件匣與垃圾郵件。");
      } catch { setStatus("帳號已建立，但驗證信尚未寄出。請稍後使用「重新寄送驗證信」。", true); }
    } else if (mode === "reset") {
      mailReadyAt = Date.now() + 60000;
      await sdk.sendPasswordResetEmail(auth, email, emailActionSettings);
      setStatus("若此 Email 可重設密碼，你將收到操作指引。請檢查收件匣與垃圾郵件。");
    } else {
      const result = await sdk.signInWithEmailAndPassword(auth, email, password);
      render(result.user);
      if (!result.user.emailVerified) setStatus("登入成功，請先完成 Email 驗證。");
    }
  } catch (error) {
    if (mode === "reset" && ["auth/user-not-found", "auth/invalid-email"].includes(error.code)) {
      setStatus("若此 Email 可重設密碼，你將收到操作指引。請檢查收件匣與垃圾郵件。");
    } else if (mode === "register" && error.code === "auth/email-already-in-use") {
      setStatus("無法用此 Email 建立新帳號。若曾用 Google／Facebook 登入，請先用原方式登入，再到帳號頁「設定 Email 登入密碼」；已有密碼可使用忘記密碼。", true);
    } else setStatus(authErrorMessage(error), true);
  } finally {
    $("account-password").value = $("confirm-password").value = "";
    busy = false;
    controls();
  }
});
$("send-verification").addEventListener("click", async () => {
  const user = auth?.currentUser;
  if (!user || user.emailVerified || busy) return;
  if (Date.now() < mailReadyAt) return setStatus("請稍候一分鐘再寄送郵件。", true);
  busy = true; controls(); mailReadyAt = Date.now() + 60000;
  try { await sdk.sendEmailVerification(user, emailActionSettings); setStatus("驗證信已寄出，請檢查收件匣與垃圾郵件。"); }
  catch (error) { setStatus(authErrorMessage(error), true); }
  finally { busy = false; controls(); }
});
$("refresh-verification").addEventListener("click", async () => {
  const user = auth?.currentUser;
  if (!user || busy) return;
  busy = true; controls();
  try {
    await sdk.reload(user);
    await user.getIdToken(true);
    if (auth.currentUser?.uid !== user.uid) return;
    render(user);
    setStatus(user.emailVerified ? "Email 驗證完成。" : "Email 尚未驗證，請先點擊信中的驗證連結。");
  } catch (error) { setStatus(authErrorMessage(error), true); }
  finally { busy = false; controls(); }
});
$("add-password-form").addEventListener("submit", async event => {
  event.preventDefault();
  const user = auth?.currentUser;
  if (!user || busy) return;
  const email = user.email;
  const password = $("new-password").value;
  const confirmation = $("new-password-confirm").value;
  const validation = validateEmailRegistration(email || "", password, confirmation);
  if (validation) return setStatus(validation, true);
  if (!user.emailVerified) return setStatus(authErrorMessage({code:"auth/email-not-verified"}), true);
  const existing = user.providerData.find(p => ["google.com", "facebook.com"].includes(p.providerId));
  if (!existing) return setStatus("請先使用原本的 Google／Facebook 帳號登入。", true);
  busy = true;
  clearLinkProof();
  controls();
  try {
    const provider = makeProvider(existing.providerId === "google.com" ? "google" : "facebook");
    if (existing.providerId === "facebook.com") provider.setCustomParameters({auth_type:"reauthenticate"});
    setStatus(`請透過 ${providerName(existing.providerId)} 重新驗證目前帳號，完成後會設定密碼。`);
    const proof = await reauthenticateForLink(auth, sdk, provider, "password");
    proof.email = email;
    const linkedUser = await linkEmailPassword(auth, sdk, password, confirmation, proof);
    render(linkedUser);
    setStatus("Email 登入密碼已設定！現在可用 Email／密碼或已連結的第三方帳號登入，UID 與原有資料保持相同。");
  } catch (error) { setStatus(authErrorMessage(error), true); }
  finally {
    $("new-password").value = $("new-password-confirm").value = "";
    busy = false;
    controls();
  }
});
window.addEventListener("pagehide", () => {
  $("account-password").value = $("confirm-password").value = $("reauth-password").value = $("new-password").value = $("new-password-confirm").value = "";
  clearLinkProof();
});
initialize();

