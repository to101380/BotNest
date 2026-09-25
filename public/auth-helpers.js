export function hasFirebaseConfig(config) {
  return ["apiKey", "authDomain", "projectId", "appId"].every(key => typeof config?.[key] === "string" && config[key].trim().length > 0);
}
export function providerName(id) {
  return { "google.com": "Google", "password": "Email／密碼" }[id] || id;
}
export function authErrorMessage(error) {
  return {
    "auth/invalid-email": "請輸入有效的電子郵件地址。",
    "auth/invalid-credential": "登入失敗，請確認 Email 與密碼，或使用原本的第三方登入方式。",
    "auth/wrong-password": "登入失敗，請確認 Email 與密碼，或使用原本的第三方登入方式。",
    "auth/user-not-found": "登入失敗，請確認 Email 與密碼，或使用原本的第三方登入方式。",
    "auth/weak-password": "密碼需至少 12 個字元，請使用更長的密碼。",
    "auth/password-does-not-meet-requirements": "密碼不符合要求，請使用至少 12 個字元。",
    "auth/email-not-verified": "請先完成 Email 驗證，再新增登入方式。",
    "auth/popup-closed-by-user": "登入視窗已關閉，你可以重新選擇登入方式。",
    "auth/cancelled-popup-request": "已取消先前的登入要求。",
    "auth/popup-blocked": "瀏覽器阻擋了登入視窗，請允許彈出視窗後重試。",
    "auth/unauthorized-domain": "此網站尚未加入 Firebase 的授權網域，請管理員完成設定。",
    "auth/operation-not-allowed": "這個登入方式尚未啟用，請管理員檢查 Firebase 設定。",
    "auth/account-exists-with-different-credential": "這個電子郵件已使用另一種方式註冊。請先用原本的方式（例如 Google）登入，再點「連結 Google 帳號」。",
    "auth/credential-already-in-use": "這個第三方帳號已連結另一個使用者，無法直接合併。請使用該帳號原本的登入方式。",
    "auth/email-already-in-use": "此憑證已屬於另一個使用者，未合併帳號。請使用原本的登入方式。",
    "auth/provider-already-linked": "此登入方式已連結，請重新整理查看最新狀態。",
    "auth/requires-recent-login": "請先登出並重新登入，再連結其他帳號。",
    "auth/network-request-failed": "網路連線失敗，請確認網路後重試。",
    "auth/user-disabled": "這個帳號已停用，請聯絡管理員。",
    "auth/too-many-requests": "嘗試次數過多，請稍後再試。",
    "auth/invalid-api-key": "Firebase 網頁設定不正確，請管理員檢查 API Key。",
    "auth/web-storage-unsupported": "瀏覽器無法保存登入狀態，請檢查隱私設定或換個瀏覽器。",
  }[error?.code] || "無法完成登入操作，請稍後再試或聯絡管理員。";
}

export function validateEmailRegistration(email, password, confirmation) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "請輸入有效的電子郵件地址。";
  if (password.length < 12 || password.length > 128) return "密碼長度需為 12～128 個字元。";
  if (password !== confirmation) return "兩次輸入的密碼不一致。";
  return null;
}

export async function reauthenticatePasswordForLink(auth, sdk, password, target) {
  const user = auth.currentUser;
  if (!user?.emailVerified) throw {code:"auth/email-not-verified"};
  if (!user.email || !password || !user.providerData.some(p => p.providerId === "password")) throw {code:"auth/requires-recent-login"};
  const uid = user.uid;
  const credential = sdk.EmailAuthProvider.credential(user.email, password);
  const result = await sdk.reauthenticateWithCredential(user, credential);
  if (auth.currentUser?.uid !== uid || result.user.uid !== uid) throw new Error("Account changed");
  return {uid, target, at:Date.now(), used:false};
}

// Linking must target an authenticated user, never an email lookup or a new sign-in.
export async function linkProviderAccount(auth, sdk, provider, proof) {
  const user = auth.currentUser;
  if (!user) throw Object.assign(new Error("Sign in required"), { code: "auth/requires-recent-login" });
  if (user.providerData.some(item => item.providerId === provider.providerId)) {
    throw Object.assign(new Error("Already linked"), { code: "auth/provider-already-linked" });
  }
  if (!proof || proof.uid !== user.uid || proof.target !== provider.providerId ||
      proof.used || !Number.isFinite(proof.at) || Date.now() - proof.at > 60000 || Date.now() < proof.at) {
    throw Object.assign(new Error("Reauthentication required"), { code: "auth/requires-recent-login" });
  }
  proof.used = true;
  const uid = user.uid;
  const result = await sdk.linkWithPopup(user, provider);
  if (result.user.uid !== uid || auth.currentUser?.uid !== uid) throw new Error("Account session changed");
  return result.user;
}

export async function reauthenticateForLink(auth, sdk, existingProvider, target) {
  const user = auth.currentUser;
  if (!user || !user.providerData.some(p => p.providerId === existingProvider.providerId)) {
    throw Object.assign(new Error("Existing provider required"), { code: "auth/requires-recent-login" });
  }
  const uid = user.uid;
  const result = await sdk.reauthenticateWithPopup(user, existingProvider);
  if (auth.currentUser?.uid !== uid || result.user.uid !== uid) throw new Error("Account changed");
  return { uid, target, at: Date.now(), used: false };
}

export async function linkEmailPassword(auth, sdk, password, confirmation, proof) {
  const user = auth.currentUser;
  if (!user || !proof || proof.uid !== user.uid || proof.target !== "password" ||
      proof.email !== user.email || proof.used || !Number.isFinite(proof.at) ||
      Date.now() - proof.at > 60000 || Date.now() < proof.at) throw {code:"auth/requires-recent-login"};
  if (!user.emailVerified || !user.email) throw {code:"auth/email-not-verified"};
  if (user.providerData.some(p => p.providerId === "password")) throw {code:"auth/provider-already-linked"};
  if (validateEmailRegistration(user.email, password, confirmation)) throw {code:"auth/password-does-not-meet-requirements"};
  proof.used = true;
  const policy = await sdk.validatePassword(auth, password);
  if (!policy.isValid) throw {code:"auth/password-does-not-meet-requirements"};
  if (auth.currentUser?.uid !== user.uid || user.email !== proof.email || !user.emailVerified || Date.now() - proof.at > 60000) throw {code:"auth/requires-recent-login"};
  const credential = sdk.EmailAuthProvider.credential(user.email, password);
  const result = await sdk.linkWithCredential(user, credential);
  if (result.user.uid !== proof.uid || auth.currentUser?.uid !== proof.uid) throw new Error("Account changed");
  return result.user;
}
