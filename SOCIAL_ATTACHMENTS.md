# Messenger 與 Instagram 附件

Messenger 對話可用原有工具列上傳圖片或文件；Instagram 僅顯示圖片按鈕，後端也拒絕文件。選取附件後按傳送才會送出，可附帶文字。沒有新增圖片庫、商品庫或卡片功能。

圖片沿用前端 JPEG 壓縮（原圖最多 20 MB、最長邊 1600px、壓縮後最多 1 MB）。文件最多 5 MB，允許 PDF、Office、TXT、CSV、ZIP。附件上傳到既有私有媒體 bucket，以 30 天簽章連結交給 Zernio；Messenger 使用原生 file 附件，LINE 文件仍為原有連結形式。每個網站帳號每天最多 100 次／100 MB 社群附件上傳。

附件只可由原上傳者在原社群帳號、平台及對話使用。上傳前透過已綁定 accountId 的訊息端點確認對話存取；社群附件不依賴 LINE 帳號。所有 metadata 由後端儲存，前端送出時只提供 attachmentId，不接受任意圖片或檔案網址。

社群附件的 operationId 與內容綁定。成功傳送重複請求會回傳原結果；網路逾時、5xx、部分成功或不明結果都保留狀態，不會再次呼叫傳送 API。「重試確認」只讀回該次操作結果，需要到原平台確認是否收到。這是因為供應商只保留成功回應的 idempotency 結果，無法保證上游接受後發生的錯誤不會重複發送。

相關官方規格：https://docs.zernio.com/messages/send-inbox-message （attachmentUrl、attachmentType、partialFailure、Idempotency-Key）。

驗證：完整測試 243 項通過，包含三種允許的附件组合、未綁 LINE 的社群帳號、帳號／平台／對話隔離、簽章／到期、IG 文件拒絕、併發送出、重送、平台拒絕與部分成功。虛構資料的瀏覽器預覽確認 Messenger 圖片上傳與 IG 圖片上傳／傳送、IG 隱藏文件按鈕；修正暫存訊息與正式 ID 不同造成的畫面重複。未向真實客戶傳送測試訊息。

本機預覽：`node scripts/preview-social-attachments.mjs`，預設 http://127.0.0.1:5193 ，只有虛構帳號與模擬平台傳送。
