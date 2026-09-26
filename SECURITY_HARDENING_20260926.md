# 安全修補（2026-09-26）

已修補社群帳號綁定的 callback 狀態驗證、重播與跨登入完成風險，並新增業務 API 每帳號每分鐘 120 次、社群連接每分鐘 5 次的交易式限制。隨機 state 只保存雜湊、10 分鐘過期、交易中只可消耗一次；GET callback 僅導向同源完成頁，POST 完成時驗證登入 UID、Profile、平台以及第三方 account 歸屬。

Firestore 規則改為所有用戶端請求皆拒絕，移除已過期的 legacy 例外。Hosting 新增 HSTS，部署與 Git 排除秘密檔案，新增 `.firebaserc` 明確指向本專案，避免繼承上層的另一個專案。

## 驗證與限制

- 工作目錄 139 項測試通過，含 nonce 偽造／過期／重播／跨帳號、併發消耗、API 限流、未登入拒絕與既有功能測試。
- `npm audit --omit=dev --json` 回報 0 已知漏洞；不等於沒有零日或供應鏈風險。
- 已检查秘密格式、前端文字輸出、身份/資源授權、附件限制與 SSRF 既有防護。
- Firebase CLI 登入憑證失效，官方規則模擬、實際 IAM/Storage/Auth 檢查與部署未完成。沒有宣稱修補已在線上生效。
- 此工作目錄還有使用者先前未提交的登入裝置驗證等變更；本次 Git 提交不混入這些變更。

## 部署順序

重新登入 Firebase 後，先驗證 Rules API 和線上 IAM/規則，再一起發佈 `botnestApi` 與含 `oauth-complete.html`/`.js` 的 Hosting。使用明確的 `--project planning-with-ai-52d58`。不要再用相同專案的舊 `google-meta-login` 覆蓋正式程式。既有 OAuth 授權連結失效時，請回到渠道設定重新發起。

正式驗收需本人完成社群授權流程。沒有代替使用者向真實顧客傳送訊息、刪除遠端資料或更動帳戶 MFA。
