# Google + Meta 登入起始專案

## 登入安全功能（本機完成，待設定寄信及部署）

個人資訊新增登入紀錄、登入裝置及新裝置 Email 核准。後端會阻擋未核准或已撤銷的裝置；首次啟用時既有使用者也須完成驗證。上線前必須先設定 `BOTNEST_LOGIN_MAIL` 寄信 Secret，並一起發布後端與 Hosting。詳細範圍、限制及驗收方式見 [LOGIN_SECURITY.md](LOGIN_SECURITY.md)。

## LINE OA 收件匣（已部署，待綁定 OA）

現在支援从網頁傳送文字回覆、傳送狀態與斷線後安全重試。先前已綁定的 OA 需更新一次連線憑證，以加密保存回覆所需的 Access Token。按 Enter 或點「傳送回覆」送出，Shift＋Enter 換行；中文選字時按 Enter 不會送出。

已部署 OA 綁定、按帳號隔離的新訊息收件匣及 Webhook 接收端。Firebase Blaze 已啟用；登入正式網站後，在「AI機器人」填入 OA 憑證，再設定 LINE Webhook，詳見 [LINE_SETUP.md](LINE_SETUP.md)。本機可執行 `node scripts/preview-inbox.mjs` 查看虛構資料示範。

以下為既有登入功能文件；其中「沒有資料庫或受保護 API」描述的是先前已部署的登入版本，新的 LINE 後端與權限以 `LINE_SETUP.md` 為準。

## Email／密碼登入（已啟用）

正式站提供 Email 登入、註冊帳號、忘記密碼、Email 驗證信重寄與驗證狀態更新。只能輸入 Email，沒有自訂使用者名稱。Firebase Authentication 管理使用者與密碼；不在 Firestore 保存密碼。
伺服器已啟用 Email/Password（非免密碼 Email Link）、強制新密碼長度 12～128，以及 Email 枚舉保護。登入錯誤與密碼重設回覆避免直接暴露帳號是否存在；註冊 API 本身仍可能呈現已存在的錯誤，不代表完整防枚舉。
註冊後即有 Firebase session，但 Email 驗證狀態會顯示為未完成。這不是後端授權，未驗證帳號不能在本站流程連結第三方帳號；日後任何私有資料 API 都必須另行驗證 `email_verified` 與資源擁有權。
密碼帳號可以完成 Email 驗證後，輸入目前密碼重新驗證，再連結 Google／Facebook。已使用第三方註冊的 Email 不會被註冊流程覆蓋；使用原方式登入或由信箱持有者使用 Firebase 密碼重設流程。
前端 60 秒寄信冷卻僅防止連點，不是伺服器節流。Firebase 仍執行平台配額與限制。
自動測試未寄信或建立真實帳號；請用本人可收信的 Email 驗證註冊、收信、重新登入與密碼重設。

獨立的純 HTML/CSS/JavaScript 網頁，使用 Firebase Authentication。Meta 這裡指 **Facebook Login**，不是 Instagram 或 Meta Quest 登入。

## 本機啟動

需要 Node.js 22 以上，在本資料夾執行 `npm run dev`，開啟 http://127.0.0.1:5190 。不需要 npm install。
尚未建立 Firebase 時，可以預覽登入畫面；按鈕會停用並提示設定，不會假裝登入成功。

## 1. Firebase 網頁設定

建立自己的 Firebase 專案，新增 Web App。把控制台提供的 firebaseConfig 填入 `public/firebase-config.json`，至少包含 apiKey、authDomain、projectId、appId。
這是 Firebase 公開的網頁設定，不是 Google 服務帳戶私鑰。**不要在這裡放 Meta App Secret、服務帳戶 JSON、OpenAI 或 LINE 金鑰。**

Firebase Authentication → Sign-in method 啟用 Google，填寫支援電子郵件。
正式專案已限制為兩個 Hosting 網域，本機僅用於頁面預覽。需要本機登入測試時，請使用獨立開發專案，不要放寬正式 Key／OAuth 網域。

## 2. Meta / Facebook 設定

1. 在 Meta for Developers 建立支援 Facebook Login 的應用程式，取得 App ID 與 App Secret。
2. Firebase Authentication 的 Facebook 登入供應商設定中填入 App ID 與 App Secret。App Secret 僅填在控制台，不要傳給本網頁或提交到程式碼。
3. 從 Firebase 複製顯示的 OAuth redirect URI，加入 Meta 的 Valid OAuth Redirect URIs。通常是 `https://PROJECT_ID.firebaseapp.com/__/auth/handler`；以 Firebase 顯示值為準。
4. 依 Meta 控制台要求設定網站網址、網域與應用程式測試角色。開發階段先用有權限的測試帳號測試；正式開放一般用戶前，完成 Meta 要求的公開／審查、隱私權政策與資料刪除設定。

## 3. 驗收

- Google 登入、顯示名稱／email／UID／Google provider UID，重新整理仍保持登入，登出後清除畫面。
- Facebook 執行同樣流程；email 可能未提供，畫面有替代文字。
- 關閉彈窗、阻擋彈窗、未授權網域、登入供應商未啟用時顯示可理解的錯誤。
- 已由另一個供應商註冊的 email 發生衝突時，提示使用原方式登入；**這一版不會自動合併帳號**。
- 使用 Firebase local persistence：同一瀏覽器關閉分頁或視窗後仍保存登入；手動登出會清除登入。既有裝置核准、撤銷及後端 7 天登入期限仍適用；無痕模式或清除網站資料後須重新登入。應用程式不顯示或記錄 ID/access token。

`npm run check` 驗證語法，`npm test` 驗證設定與錯誤處理。沒有真實專案時，無法完成 Google/Meta 的端對端登入驗證。

## 日後部署

已附獨立 firebase.json。設定完成後，在本資料夾執行 `firebase deploy --only hosting --project YOUR_PROJECT_ID`。務必明確指定新的 Project ID，避免沿用上層舊專案。
已部署到 https://planning-with-ai-52d58.web.app ，使用專案 `planning-with-ai-52d58`。部署未修改上層 LINE Bot。Google／Facebook 的真實登入仍需在正式網址由使用者驗證。

## 日後後端身分驗證

前端可透過 `auth.currentUser.getIdToken()` 取得 Firebase ID token，以 HTTPS Authorization Bearer header 傳給你的後端。後端使用 Firebase Admin SDK 驗證後取出 UID，不能相信前端直接提交的 UID。
本版處理登入、身分展示與登入供應商連結，沒有資料庫或受保護 API。

## Google 與 Facebook 共用 UID

先用既有方式（例如 Google）登入，在「連結其他登入方式」點「連結 Facebook 帳號」，先重新驗證原有帳號，再於 60 秒內點「確認連結」完成 Facebook 授權。程式使用 Firebase `linkWithPopup` 綁定到目前登入的使用者，連結完成後 UID 保持不變。登出後改用 Facebook 登入，確認 UID 相同。
不因 email 相同自動合併，也不刪除既有帳號。若憑證已屬於另一個 Firebase UID，顯示衝突錯誤，保留原帳號。已連結的供應商不再顯示連結按鈕。
帳號連結單元測試以替身驗證；真實供應商授權與重新登入須由使用者完成驗收。

## 安全狀態

請先讀取 `SECURITY_STATUS.md`，其中區分已部署防護、待確認 Firestore 規則、管理員雙重驗證與受計費／平台設定限制的監控。不要把前端重新驗證當作防止被竊 ID token 的伺服器端安全邊界。

官方文件：
- https://firebase.google.com/docs/auth/web/google-signin
- https://firebase.google.com/docs/auth/web/facebook-login
- https://firebase.google.com/docs/auth/web/account-linking
- https://firebase.google.com/docs/auth/admin/verify-id-tokens

### 圖片、文件與 Emoji

輸入框旁可選取圖片、文件或 Emoji。附件上傳後仍需按「傳送回覆」或 Enter；可先移除，亦可附上文字。圖片在瀏覽器轉為 JPEG（最長邊 1600px、1 MB 以下，透明背景轉白），原檔限制 20 MB。文件支援 PDF、Office、TXT、CSV、ZIP，上限 5 MB；LINE 以文字下載連結接收文件。Emoji 插入文字游標處。

附件使用專用私人 GCS bucket `planning-with-ai-52d58-botnest-media`，不開放 bucket 公開讀取。後端簽發 30 天有效的持有者連結（取得連結者即可讀取），31 天自動清理檔案。下載文件強制 attachment 與 sandbox。每 OA 每 24 小時限制 100 次上傳及 100 MB；失敗嘗試也計入預留額度。附件須屬於目前 OA 及對話；重試沿用已保存的 LINE 訊息內容和 retry key。LINE API 查閱：[支援的訊息](https://developers.line.biz/en/docs/messaging-api/sending-messages)、[圖片格式](https://developers.line.biz/en/reference/messaging-api/nojs/#image-message)。

收到的 LINE JPEG/PNG 圖片會在開啟對話時自動讀取並快取（每輪最多 3 張、單張上限 10 MB），不再只顯示 [圖片]。暫時失敗 1 分鐘後重試；LINE 已刪除的舊圖片無法恢復，顯示重新傳送提示。使用者收回圖片後不再顯示，既有媒體連結亦停止提供。Emoji 選單使用可縮放欄位，避免按鈕溢出。

## AI 客服設定

登入後使用左側「AI 客服設定」（`#assistant`），依序設定身分與語氣、知識庫、回覆規則，再到測試對話確認。設定需按「儲存設定」；知識內容獨立儲存。既有的客服指示詞與總開關會保留。

- 知識庫支援文字、PDF、Word `.docx`、TXT、Markdown、HTTPS 公開網頁。每筆 5 MB / 40,000 字，每帳號最多 40 筆 / 80 萬字。文件只保留擷取文字，不保存原始檔。匯入先存為草稿，確認後再啟用。掃描 PDF 沒有 OCR；網址是當次文字快照，不會自動爬取整站、登入頁或執行網頁 JavaScript。
- LINE 與 Messenger 的新文字訊息使用同一套設定與知識檢索。回覆時段可指定時區、營業日及跨日時間。片段透過文字關鍵字排序，答案記錄實際引用的來源；來源不足、無效引用、退款、客訴或要求真人會轉交真人。這是依據檢查，並非保證模型永不出錯。
- 訊息中心每段對話可選「交回 AI」「真人接手」「關閉 AI」。轉真人後持續暫停，直到手動交回 AI。從 BotNest 手動回覆會先暫停 AI，預設 30 分鐘，可設 1～1440 分鐘；直接在 LINE OA / Facebook 官方介面回覆不包含在這個偵測範圍。
- 回覆前重新檢查總開關、渠道、時段及對話控制，避免 AI 生成期間真人接手後仍送出。已交給外部渠道的請求無法撤銷。失敗會留下紀錄供真人接手，不自動無限重試；每渠道既有 20 次/分鐘、500 次/24 小時額度仍有效。
- 測試區使用正式設定與同一模型，只忽略自動回覆總開關；仍遵守渠道與時段限制，不傳送訊息、不改變真正顧客的接手狀態。測試使用 OpenAI API 額度，每帳號限 10 次/分鐘。

AI 設定位於既有 Firestore `(default)` 的 `botnest/state/accounts/{uid}`，知識、逐段控制及紀錄分別在 `aiKnowledge`、`aiConversations`、`aiLogs` 子集合。瀏覽器只經過驗證 Firebase ID token 的 API，不能指定其他帳號 UID。OpenAI Key 仍留在 Secret Manager。知識文字、近期對話及商家設定會傳給 OpenAI 產生回覆，API 使用 `store: false`。記錄保留當次引用文字快照；刪除知識會停止未來檢索，不會抹除舊回覆紀錄。

`npm test` 包含匯入、租戶隔離、時段、引用及接手測試；`npm run check` 檢查全部 JS 語法。`node scripts/preview-inbox.mjs` 提供虛構資料預覽，不發送渠道訊息。選擇性執行 `node scripts/check-ai-live.mjs` 可驗證真正模型，須透過環境變數 `BOTNEST_CHECK_OPENAI_KEY` 提供金鑰；只使用虛構商家資料。
