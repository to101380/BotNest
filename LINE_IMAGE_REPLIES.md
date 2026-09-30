# LINE 圖片回覆與輕量素材

## 使用方式

在 LINE 對話按「圖片」上傳，預設以圖片卡片呈現。可填 80 字內的標題、500 字內的說明，確認預覽後按「傳送」。卡片以 LINE Flex bubble 傳送，保留圖片完整比例並附「查看圖片」按鈕；原有文字輸入框的文字另外傳送。亦可切換「一般圖片」。一次傳送一張圖片卡片。

按「加入圖片素材」可收藏自己上傳的圖片。日後從「圖片素材」選取，可在同一 OA 的其他對話重複使用。提供檔名搜尋（已載入的圖片）、分頁與移出素材。這是客服手動選圖的功能，沒有商品、庫存或 AI 自動選圖系統。

沿用現有儲存政策：上傳連結有效 30 天，bucket 約 31 天刪除原檔。收藏不延長期限，到期前一天不再列入可選素材。正式長期素材庫需另外調整儲存生命週期與連結設計，不能只把前端到期提示拿掉。移出素材僅停止後續跨對話使用，不撤回已傳送連結；要再次使用已移出的圖片，請重新上傳。

## 授權與重試

- 素材 API 沿用登入、裝置驗證與 OA 擁有權檢查；不接收任意外部圖片網址。
- 顧客傳入的圖片與一般文件不可收藏，避免私人附件成為共用素材。
- 素材只公開顯示所需欄位，不回傳 Storage 路徑或來源對話 ID。
- 卡片內容與附件、收件對象一起綁定 operationId；改內容不能沿用同一筆傳送 ID。重試使用原始 Flex payload 與 LINE retry key，收藏移除也不會改動已送出的 payload。
- 前端切換帳號會清除素材與草稿，忽略前次登入的延遲結果。

## 驗證與發布

執行 `npm run check`、`npm test`。`node scripts/preview-inbox.mjs` 提供只綁定 loopback 的虛構資料預覽，所有 LINE 傳送皆為模擬；可用 `BOTNEST_PREVIEW_PORT` 指定 port。預覽専用的假身分、媒體網域替換不會進入正式 Hosting。

發布需同時更新 Functions 的 `core.js`、`store.js`、`image-card.js` 與 Hosting 的 `index.html`、`line-inbox.js`、`line-inbox.css`、`image-reply.js`。沿用既有 Firebase 媒體 bucket，不需新增商品系統或複合索引。應依 DESIGN_SYSTEM.md 的正式快照流程部署，避免把其他本機差異一併上線。完成本機驗證不代表已部署或已在 LINE 真實裝置驗收。

LINE 官方規格：https://developers.line.biz/en/docs/messaging-api/using-flex-messages/

修改前備份：GitHub tag `backup-before-line-image-cards-20260930`，commit `6da55d9`。備份包含現況程式與文件，不包含憑證、顧客資料與本機診斷暫存。
