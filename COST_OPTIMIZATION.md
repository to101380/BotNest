# 成本優化（2026-09-26）

適用於本資料夾的 BotNest。沿用 `planning-with-ai-52d58` 的 `(default)` Standard Firestore；未修改帳單方案、資料庫規則或其他專案。

## 修改

- LINE AI 回覆：驗證簽章後，將原始文字事件的 Reply Token 加密存入訊息，與渠道及訊息 ID 綁定，不回傳收件匣。僅在首次接收後 45 秒內且事件不超過 19 分鐘時使用 Reply；沒有 Token、Webhook 重送或準備傳送時已超過安全時限，仍使用原有 Push 及 Retry Key。人工回覆維持 Push。
- Reply 發送方式在既有 outbox 交易中先保存；若工作中斷、逾時或被 LINE 拒絕，不自動重送或轉 Push，以免同一回覆送兩次。錯誤留下供人工確認的紀錄。這可能需要人工處理偶發的 Reply 失敗，不能保證每次都免額度或送達。
- 閒置收件匣：選定對話的更新間隔由最多 30 秒調整為 60 秒；未選對話的列表由最多 60 秒調整為 120 秒。偵測到變化後回到 10 秒，切回頁面與手動重新整理仍立即更新，背景分頁仍暫停。穩定閒置時每小時輪詢約由 120→60 或 60→30 次；這是輪詢次數減半，不代表總帳單減半。新訊息在閒置畫面可能較晚出現，伺服器的 AI 自動回覆不依賴輪詢。
- 明確命中轉真人關鍵字時，省略讀取知識庫。保留現有模型、對話歷史、知識檢索與安全規則。

## 驗證與上線

本機測試涵蓋 Token 加密與前端隔離、重送、Reply 成功、推論期間 Token 到期、Push Retry Key、併發去重、Reply 拒絕／逾時／工作中斷、真人接手與輪詢退避。全部使用模擬 LINE／AI，未向真實顧客發送訊息。

部署範圍為 `botnestApi`（接收 Token）、`lineAiAutoReply`（Reply）、`facebookAiAutoReply`（延遲知識庫讀取）及 Hosting。發布使用 `.deploy-cost` 獨立目錄，以現行線上原始碼為基礎加入此次修改；原始三個函式 ZIP 與 Hosting 版本資訊保留在該目錄供回復。本機其他尚未發布的登入裝置安全功能未包含在這次部署包中。正式部署包另通過 84 項後端測試。

Hosting 同時加入 12px 紫色圓角「載入更早訊息」按鈕與 Firebase `browserLocalPersistence`。先前提到的 7 天登入期限屬於尚未部署的 `login-security.js`，並非目前正式站期限；本次保持正式站既有授權規則。手動登出會清除持續登入狀態。

實際發布結果見 `DEPLOYMENT_20260926.md`。以 LINE 訊息用量及 Cloud Billing 服務明細比較實際節省；模擬測試不能代替真實 OA 端對端驗收。

官方依據：
- https://developers.line.biz/en/docs/messaging-api/pricing/ ：Reply 不計入方案訊息通數，Push 計入。
- https://developers.line.biz/en/reference/messaging-api/nojs/#send-reply-message ：Token 一次使用，應盡快使用，超過接收後一分鐘不保證有效。
