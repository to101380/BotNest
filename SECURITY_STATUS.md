# 安全處理狀態

更新：依使用者要求新增 Email／密碼供應商，保持匿名登入關閉。密碼政策在 Firebase 強制為 12～128 字元，Email 枚舉保護已啟用；使用者可註冊、登入、收驗證信及重設密碼。此流程不會自動部署尚待確認的 Firestore 規則，原先資料授權風險仍未關閉。

範圍：`google-meta-login` 與 Firebase `planning-with-ai-52d58`。未宣稱完成滲透測試，也未修改上層 LINE Bot。

## 已部署與驗證

1. 帳號連結 UI 先使用 `reauthenticateWithPopup` 驗證原有供應商，再由第二次明確點擊新增供應商；驗證憑據只在記憶體保存 60 秒、綁定 UID 與目標供應商、使用一次。取消、逾時或帳號改變則拒絕。**這是前端流程防護，不是 Firebase REST API 的伺服器端連結限制；被竊的 bearer token 仍有風險。** Google 重新驗證可能透過現有 Google session 完成，不保證每次輸入密碼／MFA。
2. Hosting 已新增 CSP、X-Frame-Options DENY、Permissions-Policy；保留 HSTS、nosniff 與 Referrer-Policy。允許指定 Firebase OAuth helper 與必要 Google SDK 網域，未設定會破壞 OAuth popup 的 COOP same-origin。
3. 網頁 API Key 僅允許 `identitytoolkit.googleapis.com`、`securetoken.googleapis.com`，來源僅兩個正式 HTTPS 網域。Key 本身仍公開；Referrer 限制不是身分驗證，也不能防止偽造 HTTP header 的攻擊者。
4. 專案 IAM 只有一位人類 Owner，其餘是 Firebase 系統服務帳戶。未擅自刪除系統角色。管理員 MFA 尚未啟用／未確認。
5. 停用匿名登入；供應商僅啟用 Google／Facebook；Firebase OAuth 授權網域只保留 `planning-with-ai-52d58.web.app` 與 `.firebaseapp.com`。本機已不允許真實登入，使用正式站測試。Meta 控制台端的完整權限、角色、MFA 尚待本人核對。
6. 發現現行 Firestore 規則允许所有已登入使用者讀寫所有文件直到 2026-09-18。已準備 `firestore.rules` 全面拒絕用戶端讀寫，**尚未部署：自動審核要求使用者確認無其他資料功能依賴**。不刪除資料；Admin/IAM 存取不受該規則控制。此登入頁沒有受保護 API，不以未驗證的 UID 授權任何後端操作。未来新增 API 必须在服務端驗證 token、撤銷狀態、資源擁有者，不能把本頁當成授權閘門。
7. 已建立 Email 通知管道與「Identity security configuration changed」日誌告警，偵測 Auth/API Key/IAM 的管理異動。收件人為使用者指定地址；尚未做端對端測試信驗收。HTTPS uptime check 被 Google 以未啟用 billing 拒絕。登入活動 request logging 被目前 FIREBASE_AUTH 設定以 FAILED_PRECONDITION 拒絕。**沒有建立異常登入／大量註冊自訂偵測，也沒有自訂伺服器節流；Firebase 內建配額不能取代這些控制。**

## 驗證範圍

- 語法檢查與 6 項單元測試通過，包括拒絕過期／錯誤 UID／重用的連結驗證。
- REST 讀回確認 API Key 與 Auth 設定；線上頁面可初始化 Firebase。
- 真實 Google／Facebook 重新驗證、帳號連結與登出重登需要本人測試，未代替用戶完成授權。

## 需要本人完成

- Google： https://myaccount.google.com/security → 兩步驟驗證。設定驗證器或安全金鑰並安全保存備用碼，不貼入聊天。
- Facebook：設定 → 帳號管理中心 → 密碼和帳號安全 → 雙重驗證。核對管理員角色，移除確定不需要的成員。
- 確認是否可關閉 Firestore 所有用戶端存取。確認後再部署 `firebase deploy --only firestore:rules --project planning-with-ai-52d58`。
- 若要完整登入日誌、uptime 與伺服器控制，另行評估 Identity Platform／計費設定及成本，未自動升級或綁信用卡。

## 帳號事件處理

1. 先在 Firebase Users 核對受影響的 UID，保存非秘密的時間與事件描述。
2. `node scripts/security-user.cjs disable UID` 預覽；確認對象後加 `--apply` 才會停用並撤銷 refresh session。腳本只在本機由已登入的管理員 CLI 使用，沒有公開管理 API。
3. 修復 Google／Facebook 原始帳號、重設被竊憑證、移除陌生裝置、檢查新增登入方式。不得只靠同 email 為使用者合併或接管帳號。
4. `revoke UID --apply` 可撤銷 refresh tokens；已發出的 ID token 需後端檢查撤銷狀態或等待到期。本站無私人 API／資料，因此不要聲稱登出能立刻使所有 token 無效。
5. 確認復原後才 `enable UID --apply`。本次未對任何真實用戶執行停用、撤銷或啟用。

## 回復與維護

`security/cloud-before.json` 保存非秘密的修改前網域、匿名登入設定及 key restrictions。不要直接全部回復，避免重開不必要登入／API 存取。
`scripts/cloud-security-audit.cjs` 是唯讀稽核，輸出採欄位白名單，不輸出 IDP client secret、password hash signer 或登入 token。

Firestore prototype review note: I've set up prototype Security Rules to keep the data in Firestore safe. They are designed to be secure for this login-only app because no client database access is needed and every read/write is denied. However, you should review and verify them before broadly sharing your app. If you'd like, I can help you harden these rules.
