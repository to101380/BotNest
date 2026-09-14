# BotNest LINE 收件匣（第一版）

## 目前狀態

已完成原始碼、單元測試、本機示範與正式部署。
Firebase `planning-with-ai-52d58` 已啟用 Blaze；BotNest 規則、`botnestApi` 與 Hosting 路由均已部署。
正式 `/api/line/health` 回 200；未登入的 account/conversations 回 401；未綁定 OA 的 Webhook 回 404。
`BOTNEST_ENCRYPTION_KEY` 已建立於 Secret Manager。建置映像設定保留 7 天。
部署修正：資料庫物件延後到首個請求才建立，避免部署分析階段初始化逾時。
沒有更改既有 LINE Webhook，也沒有輸入或儲存使用者的 LINE 憑證。

## 功能與範圍

- 每個 Firebase 登入帳號可綁定一個 OA；不同帳號隔離。OA 不能被另一個網站帳號接管。
- 使用長期 Access Token 驗證 Channel ID 與 OA 身分，完成後即丟棄 Token。
- Channel Secret 使用 AES-256-GCM 加密，金鑰另放 Firebase Secret Manager，密文以 Channel ID 綁定。
- LINE 簽章以原始 HTTP body 驗證，並檢查 destination，成功持久化後才回應 200。
- 接收新的文字訊息、其他訊息類型的佔位文字、unsend 收回事件；支援事件去重與亂序處理。
- 顯示對話與分頁訊息，每 10 秒更新。讀取較早分頁會暫停更新，手動重新整理返回最新資料。
- 尚未串接使用者暱稱／頭像；對話先用 LINE ID 末八碼標示。
- 不下載媒體、不發送訊息、不接 AI 回覆；LINE 內建自動回應、管理後台人工回覆和串接前的舊紀錄不會同步。

## 資料與權限

使用現有 `(default)` Firestore Standard 資料庫，位置 `nam5`；後端使用 `us-central1`。
所有資料都在 `botnest/state` 的子集合中：`accounts`、`channels`、`bindingLimits`。
Channel 下方保存 `conversations/{id}/messages/{messageId}` 與 `receipts/{webhookEventId}`。
對話 ID 是來源類型與 LINE 來源 ID 的 SHA-256；API 從已驗證 UID 查出 Channel，絕不採信前端提交的 ownerUid。

前端不直接使用 Firestore。`firestore.botnest.rules` 拒絕所有 BotNest 用戶端讀寫，後端 Admin SDK 使用 IAM 存取；API 每次驗證 ID token（含撤銷檢查）及擁有權。
綁定需最近 10 分鐘內登入；Email 密碼使用者需驗證 Email。綁定有每 UID 每分鐘 5 次限制。
此規則檔只保護新資料區，保留其他資料目前的臨時規則與 2026-09-18 到期日，沒有把舊規則套用到 BotNest。
原本全面拒絕的 `firestore.rules` 仍是尚待另行決定的舊提案，現在部署設定使用 `firestore.botnest.rules`。

I've set up prototype Security Rules to keep the data in Firestore safe. They are designed to be secure for BotNest by denying direct client access and requiring authenticated, owner-checked backend requests. However, you should review and verify them before broadly sharing your app. If you'd like, I can help you harden these rules.

## 本機驗證

```sh
npm run check
npm test
node scripts/preview-inbox.mjs
```

示範網址為 `http://127.0.0.1:5191`，全部是虛構資料，不會呼叫 LINE。勿在示範表單輸入真實憑證。
一般 `npm run dev` 仍是 `http://127.0.0.1:5190` 靜態預覽，沒有 API 代理，也不會放寬正式 Firebase 的登入來源限制。
後端交易測試使用記憶體 adapter，尚未完成 Firestore 真實寫入或真實 LINE 端對端驗證。
`node scripts/test-line-rules.cjs` 使用 Firebase 官方 Rules API 模擬直接讀寫，需管理員的 Firebase CLI 登入；不部署、不寫入文件。

## 正式啟用順序

1. （已完成）專案擁有者已自行將 `planning-with-ai-52d58` 升級到 Blaze，採按量計費。
2. 在 `functions` 執行 `npm ci`。使用管理員 CLI 初始化 Secret Manager 中的 `BOTNEST_ENCRYPTION_KEY`：32 個隨機 bytes 的 Base64 字串。值只透過標準輸入或 Secret Manager 提供，不能提交 Git 或放入 `public/`。若金鑰已存在，必須沿用；直接輪替會讓既有 Secret 無法解密。
3. 重新讀取現行 Firestore 規則，確認沒有其他人修改；測試新規則，先部署 `firebase deploy --only firestore:rules --project planning-with-ai-52d58`。
4. 部署 `firebase deploy --only functions:botnest,hosting --project planning-with-ai-52d58`。確認 API health 回 200、未登入的 account 回 401，然後才開始綁定。
5. 在正式網站重新登入 → AI機器人，填 Channel ID、Channel Secret、長期 Access Token，按「驗證並連接 OA」。Token 需與 Channel 同一帳號。
6. 備份 LINE Developers 的原 Webhook URL，再貼上網站產生的網址，開啟 Use webhook，按 Verify。Secret 是否正確會由這次簽章驗證確認。
7. 從 LINE 傳送新訊息，確認網站收到；用第二個網站帳號確認無法讀取第一個 OA。測試收回訊息後文字移除。

網址格式為 `https://planning-with-ai-52d58.web.app/line-webhook/{Channel ID}`。接收端已部署；先在網站完成 OA 綁定，再使用網站產生的網址設定 LINE Webhook。
若需要切回，使用備份的舊網址；切回後新訊息會回到原服務。

參考：[LINE Webhook](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)、[簽章驗證](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)、[Firebase 部署前提](https://firebase.google.com/docs/functions/get-started)。
