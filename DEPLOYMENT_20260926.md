# BotNest 發布紀錄：2026-09-26（Asia/Taipei）

正式網站：https://planning-with-ai-52d58.web.app

已完成 Hosting 與 `botnest` codebase 的 `botnestApi`、`lineAiAutoReply`、`facebookAiAutoReply` 更新。三個函式均為 ACTIVE，更新時間約 UTC 2026-09-25 17:14（台北 2026-09-26 01:14）。

本次內容：
- 「載入更早訊息」12px 字體、淡紫色圓角按鈕。
- 同一瀏覽器關閉後保留 Firebase 登入，保留正式站原有授權檢查和手動登出。
- LINE AI 優先 Reply、安全時限外使用 Push；Reply 不確定結果不自動補送。
- 閒置對話／列表輪詢最多 60／120 秒。
- 命中轉真人關鍵字時不讀取知識庫。

部署從 `.deploy-cost` 執行，以下載的線上版本為底。未發布本機另外的登入裝置核准功能，未修改 Firestore 規則或帳單方案。原線上 Hosting 版本為 `sites/planning-with-ai-52d58/versions/f7c3782eef6b650c`；三個原始函式 ZIP 保留於該隔離目錄。

驗證：正式部署包 84 項後端測試通過、JavaScript 語法通過；正式站 `app.js`、`line-inbox.css`、`inbox-polling.js`、`line-inbox.js`、`index.html` 與部署檔 SHA-256 完全一致；健康端點 200，未登入私人資料 API 401，三個函式 ACTIVE。

未傳送真實 LINE 訊息，也未替使用者登入，真實 OA Reply 與瀏覽器關閉重開的登入保存尚需使用者實際驗收。無痕模式、刪除網站資料、主動登出或 Firebase 撤銷登入仍會要求重新登入。
