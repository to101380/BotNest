# 登入紀錄、裝置管理及 Email 登入核准

此功能已完成本機實作；尚未部署或驗證真實寄信。部署前需設定寄件網域及 Secret，並恢復 Firebase CLI 登入。不要只部署前端：後端 gate、Hosting rewrite 與前端必須一起發布。

## 實際行為

- Firebase 驗證登入憑證後，瀏覽器向 `/api/login-security/session` 申請本站裝置存取。第一次使用、清除 Cookie、無痕模式、失去信任或被撤銷的裝置，都需 Email 核准。尚未核准者只能查看基本帳號身分及信箱驗證提示，無法取得本站的 LINE、AI、Zernio、顧客或安全報告 API 資料。
- 寄信對象只取自後端驗證的 Firebase token；所有供應商均要求 `email_verified=true`。沒有 Email 或未驗證的 Facebook 帳號需先處理信箱，不能跳過此限制。
- 新裝置信任為 30 天，單次本站存取最長 7 天，以 Firebase `auth_time` 而非刷新 token 的 `iat` 計算。新建或重建裝置申請要求 10 分鐘內登入。Cookie 為 HttpOnly、Secure、SameSite=Strict、無 Domain 的 `__session`；Firebase Hosting 只轉送此特殊 Cookie。不同 Hosting 網域會分別驗證。
- 登入核准頁不會自動核准；使用者必須按「這是我」或「不是我」。連結 15 分鐘有效、一次性、只對應指定 UID、裝置及當次登入。核准後回到原裝置，頁面每 10 秒檢查；已核准後每分鐘检查。
- 單裝置或「所有其他裝置」撤銷會立即阻止後續本站 API 請求，並取消對應待核准連結；已執行中的請求無法收回。畫面最遲下次狀態檢查清除。正常登出也會嘗試撤銷目前裝置；網路失敗時仍會清除本機 Firebase 登入，並提示撤銷未確認。
- 同一帳號安全信最短間隔 60 秒、每小時最多 3 封，跨裝置共用額度。相同登入重複請求不重寄；寄信失敗或寄信程序中斷會保持阻擋，可於冷卻後重試。寄信服务接受信件不代表已送達收件匣。
- 紀錄顯示近 90 天且最多 100 筆事件；儲存最多 30 個裝置。事件在新事件寫入時裁切，並不是到期排程永久刪除。只保存 Cookie／驗證連結的 SHA-256 摘要，原始祕密不入庫。IP 部分隱藏；使用伺服器看到的 `req.ip` 作為參考，沒有信任前端位置或以 IP 決定授權，也沒有城市定位。

## 安全範圍

這是本站 API 的第二道授權，不是 Firebase Authentication 的原生 MFA 或 `beforeSignIn` 阻擋：Firebase 仍先發出 token。登入裝置代表瀏覽器儲存區，不是硬體識別碼。裝置資訊可偽造，Cookie 與 token 同時外洩仍有風險；不能宣稱可偵測所有異常登入。

Firebase 直接處理的密碼錯誤、Google／Facebook 登入失敗，不會通過本站後端，故不顯示為已驗證的失敗登入日誌，也不寄「密碼輸錯」通知。未來需要此功能應另接 Identity Platform 稽核記錄或可信任的驗證代理，不能靠前端上報 Email 來對任意帳號寄信。

Webhook、OAuth callback、公開 health check 及原有持有者附件下載連結沿用各自簽章／狀態驗證，不依賴瀏覽器裝置 Cookie。撤銷裝置不會取消已分享的附件連結，也不撤销整個 Firebase 帳號的 refresh tokens；每次本站請求仍使用 Admin `verifyIdToken(token, true)` 檢查 Firebase 全域撤銷。

## 設定及發布

沿用專案 `planning-with-ai-52d58` 的現有 `(default)` Firestore 和 `botnest/state/accounts/{uid}/security/login` 路徑。既有 `match /botnest/{document=**}` 已禁止客戶端存取，不需增加讀寫規則或複合索引。雲端資料庫 edition 未能重新查證，因本機 CLI 登入已過期；沒有建立或切換資料庫。

1. 由管理者恢復 `firebase login --reauth`，確認 `(default)` 資料庫可用與現有 deny-client 規則。
2. 在 Resend 驗證寄件網域，建立僅寄信用途 API Key，設定 `BOTNEST_LOGIN_MAIL` Secret，內容為 JSON：`{"apiKey":"<Resend API Key>","from":"BotNest Security <security@你的已驗證網域>"}`。使用 Secret Manager 或 `firebase functions:secrets:set BOTNEST_LOGIN_MAIL --project planning-with-ai-52d58` 互動輸入，不將金鑰寫入前端或提交檔案。新 Secret 已綁定 `botnestApi`。
3. 未設定或無法寄信會拒絕新裝置，沒有自動略過驗證的 fallback。先確認可收信與正式設定，再部署 `botnestApi` 及 Hosting。舊版使用者第一次回站也需驗證裝置，應安排可支援的上線時間。
4. 在正式網域以本人測試帳號驗收：首登、Email 收信、拒絕／核准、一次性與過期連結、跨瀏覽器、撤銷其他裝置、重新驗證和帳號連結。只有這些完成後才算正式啟用。

## 本機驗證

執行 `npm test`、`npm run check`。`node scripts/preview-login-security.mjs` 在 `127.0.0.1:5196` 提供完整登入安全面板，使用模擬 SDK、記憶體交易與假信箱 `/preview-mail`，不會寄真實信或寫雲端。此預覽使用與正式版相同的面板和安全服務；不模擬其餘業務 API。預覽檔在 scripts/，不屬 Hosting public 內容。

官方參考：[Firebase Hosting Cookie](https://firebase.google.com/docs/hosting/manage-cache)、[Firebase session revocation](https://firebase.google.com/docs/auth/admin/manage-sessions)、[Firebase blocking functions](https://firebase.google.com/docs/functions/auth-blocking-events)、[Resend idempotency](https://resend.com/changelog/idempotency-keys)。
