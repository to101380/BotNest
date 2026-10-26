# Messenger / Instagram 重複回覆修正（2026-10-26）

正式紀錄確認相同 Meta 訊息識別碼分別進入兩個 BotNest 帳號，兩邊各自產生一次 AI 回覆。原本依 BotNest 帳號、Zernio accountId、對話識別的防重複，無法處理同一實體收件匣的重複連接。

`claimZernioAiReply` 現在以平台與原始訊息識別碼的 SHA-256，在 `botnest/state/socialAiReplies` 取得跨帳號的一次性回覆權。此寫入與原有訊息處理鎖、用量計數在同一筆 Firestore 交易完成。搶不到權的接收流程標記為 skipped，不呼叫 AI，也不發送。

識別文件只保存 claimedAt，不保存訊息、客戶資料或帳號資訊。沿用既有服務端存取及用戶端禁止存取的規則，無須修改 Security Rules。已取得的權不會逾時轉交，避免發送結果不確定時再次發送；失敗不會自動重試。這是對每則平台訊息的防重複，不以文字或時間窗吞掉顧客真正的新問題，也不改動正常分段回覆。

回歸測試對 Messenger、IG 各模擬兩個帳號、不同 Zernio accountId 和對話，同時接收相同平台訊息。確認僅產生一次推論及發送，重送不再發送，內容相同但訊息識別不同的新訊息仍正常回覆。

部署從 `facebookAiAutoReply` 最新正式原始碼快照開始，只替換 `claimZernioAiReply` 方法並部署該函式；此函式同時處理 Messenger 與 IG。
