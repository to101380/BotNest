# 用戶管理

入口：`/admin.html`。主網站只對 Google Provider ID `111918945038301227460` 的 Google 登入顯示「管理者」連結；管理 API 另外驗證已簽章且未撤銷的 Firebase ID token 與同一 Google identity。不可使用 Email、Firebase UID 或前端角色旗標取得管理權限。

`GET /api/ai/admin/users` 使用 Firebase Auth 每頁 25 位用戶，按需讀取該頁帳號、連線與指定月份 AI 用量摘要。月份採 Asia/Taipei，不輪詢，不讀取聊天內容或全部用量事件。搜尋範圍為目前頁面。舊資料沒有最初註冊來源，顯示現有登入方式、註冊及最近登入時間；目前沒有正式訂閱模型，因此顯示尚未設定方案，不推測付費身分。

`PUT /api/ai/admin/access` 要求正式 Origin、10 分鐘內 Google 驗證、明確布林狀態與帳號 access revision。管理者自身與指定 Google identity 不可被修改。交易先設置 `accounts/{uid}.access.disabled` 並保留操作鎖，再同步 Firebase Auth disabled 與撤銷 refresh tokens；成功後完成狀態，失败維持停用並提供重試。操作記錄保存在 server-only 的 `botnest/state/adminAudit`。未完成操作鎖 60 秒後允許使用最新 revision 重試。

停用旗標在每次受保護 API、LINE／社群 webhook 及 AI 設定讀取時強制執行。AI 原設定不被破壞；恢復後依原設定運作。既有已送出的訊息不撤回；停用前已完成外部請求的工作無法倒轉。Firestore 客戶端規則仍全部拒絕，不開放管理資料的直接存取。

測試：`functions/test/admin-users.test.js` 涵蓋偽造／非指定身分拒絕、DTO 白名單、分頁、停用／恢復、撤銷 token、同步失敗、操作衝突、管理者保護及 API 阻擋。UI 使用 `.deploy-admin` 的本機虛構資料測試，沒有停用真實用戶。

發布需沿用各函式目前正式版本。網站/API 與兩個 AI 觸發函式的 store 曾有不同版本，不可整包覆蓋。`.deploy-admin` 保存本次各版本快照與隔離部署檔；正式網站未發布的 login-security/OAuth 改動仍不納入本次發版。
