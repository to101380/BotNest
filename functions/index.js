import { onSchedule } from "firebase-functions/v2/scheduler";
import { validateRequestEnvelope, secureResponse } from "./request-security.js";
import { createRetentionService } from "./data-retention.js";
import { createRetentionHandler } from "./retention-api.js";
import { onRequest } from "firebase-functions/v2/https";
import { createWorkflowHandler } from "./conversation-workflow.js";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { createHandler } from "./core.js";
import { createStore } from "./store.js";
import { createAdminUsers, createAdminStore } from "./admin-users.js";
import { createProfileHandler, createProfileStore } from "./account-profile.js";
import { createAiResponder, createZernioAiResponder } from "./ai.js";
import { createLoginSecurity, createLoginSecurityStore, createLoginMailer } from "./login-security.js";

initializeApp();
const encryptionKey = defineSecret("BOTNEST_ENCRYPTION_KEY");
const openAiKey = defineSecret("OPENAI_API_KEY");
const zernioApiKey = defineSecret("ZERNIO_API_KEY");
const loginMail = defineSecret("BOTNEST_LOGIN_MAIL");
function loginMailConfig() {
  try { return JSON.parse(loginMail.value()); } catch { return {}; }
}
const loginSecurity = createLoginSecurity({
  store: createLoginSecurityStore(getFirestore()), verifyToken: token => getAuth().verifyIdToken(token, true),
  mailReady: () => !!(loginMailConfig().apiKey && loginMailConfig().from),
  sendMail: createLoginMailer({ config: loginMailConfig }),
});
import { createMonitor, canMonitor, requestMetrics, readPermissionAudit } from "./security-monitor.js";
const monitor = createMonitor(getFirestore());
let handler;
let adminUsers;
let accountProfile;
let conversationWorkflow;
let retentionService, retentionHandler;
function dataService() { return retentionService ||= createRetentionService({ db: getFirestore(), bucket: getStorage().bucket("planning-with-ai-52d58-botnest-media") }); }
export const dataRetentionMaintenance = onSchedule({ schedule: "every 60 minutes", timeZone: "Asia/Taipei", serviceAccount: "botnest-worker-runtime@planning-with-ai-52d58.iam.gserviceaccount.com", region: "us-central1", timeoutSeconds: 540, memory: "512MiB", maxInstances: 1, secrets: [zernioApiKey, encryptionKey], retryCount: 1 }, () => dataService().scheduled());
export const dataRetentionJob = onDocumentCreated({ document: "botnest/state/accounts/{uid}/dataJobs/{jobId}", serviceAccount: "botnest-worker-runtime@planning-with-ai-52d58.iam.gserviceaccount.com", region: "us-central1", timeoutSeconds: 540, memory: "512MiB", maxInstances: 2, secrets: [zernioApiKey, encryptionKey], retry: true }, event => dataService().processJob(event.params.uid, event.params.jobId));
export const botnestApi = onRequest({
  serviceAccount: "botnest-api-runtime@planning-with-ai-52d58.iam.gserviceaccount.com", region: "us-central1", maxInstances: 3, minInstances: 0, concurrency: 20,
  timeoutSeconds: 60, memory: "512MiB", cors: false, invoker: "public",
  secrets: [encryptionKey, openAiKey, zernioApiKey, loginMail],
}, async (req, res) => {
  secureResponse(res);
  let path;
  try { path = validateRequestEnvelope(req); }
  catch (error) { return res.status(error.status || 400).json({ error: error.status ? error.message : '請求格式錯誤。' }); }
  if (path.startsWith("/api/ai/retention")) {
    retentionHandler ||= createRetentionHandler({ service: dataService(), bucket: getStorage().bucket("planning-with-ai-52d58-botnest-media"), verifyToken: token => getAuth().verifyIdToken(token, true), authorizeSession: loginSecurity.authorize, accountStore: createStore(getFirestore()) });
    return retentionHandler(req, res);
  }
  if (path === "/api/ai/workflow") {
    conversationWorkflow ||= createWorkflowHandler({ db: getFirestore(), verifyToken: token => getAuth().verifyIdToken(token, true), authorizeSession: loginSecurity.authorize, accountStore: createStore(getFirestore()) });
    return conversationWorkflow(req, res);
  }
  if (path === "/api/ai/profile") {
    accountProfile ||= createProfileHandler({ verifyToken: token => getAuth().verifyIdToken(token, true), store: createProfileStore(getFirestore()), accountStore: createStore(getFirestore()), authorizeSession: loginSecurity.authorize });
    return accountProfile(req, res);
  }
  if (path.startsWith("/api/ai/admin/")) {
    adminUsers ||= createAdminUsers({ auth: getAuth(), store: createAdminStore(getFirestore()), authorizeSession: loginSecurity.authorize });
    return adminUsers(req, res);
  }
  if (path.startsWith("/api/login-security/")) return loginSecurity.handle(req, res);
  if (path === "/api/security-monitor") {
    res.set("Cache-Control", "private, no-store");
    res.set("X-Content-Type-Options", "nosniff");
    let user;
    try { const token = /^Bearer (\S+)$/.exec(req.get("authorization") || "")?.[1]; if (token) user = await getAuth().verifyIdToken(token, true); } catch {}
    if (!canMonitor(user)) { await monitor.record(["monitorDenied"]); return res.status(403).json({ error: "僅限指定的 Google 帳號，請透過 Google 重新登入。" }); }
    try { await loginSecurity.authorize(req, user); } catch { return res.status(403).json({ error: "請先在網站個人資訊完成此裝置的 Email 登入驗證。" }); }
    if (req.method !== "GET") return res.status(405).json({ error: "僅提供唯讀監控。" });
    try { const [snapshot, permissions] = await Promise.all([monitor.snapshot(), readPermissionAudit(() => applicationDefault().getAccessToken())]); return res.json({ ...snapshot, permissions }); } catch { return res.status(503).json({ error: "監控資料暫時無法讀取，不能判定系統正常。" }); }
  }
  handler ||= createHandler({ store: createStore(getFirestore()), verifyToken: token => getAuth().verifyIdToken(token, true), authorizeSession: loginSecurity.authorize, getKey: () => encryptionKey.value(),
    getOpenAiKey: () => openAiKey.value(), openAiConfigured: () => !!openAiKey.value(), getZernioKey: () => zernioApiKey.value(),
    media: {
      save: (path, bytes, contentType) => getStorage().bucket("planning-with-ai-52d58-botnest-media").file(path).save(bytes, { resumable: false, metadata: { contentType, cacheControl: "private, no-store" } }),
      read: async path => (await getStorage().bucket("planning-with-ai-52d58-botnest-media").file(path).download())[0],
    },
  });
  const started = Date.now();
  let complete;
  const buffered = {
    set(...args) { res.set(...args); return buffered; },
    status(code) { res.status(code); return buffered; },
    json(value) { complete = () => res.json(value); return buffered; },
    send(value) { complete = () => res.send(value); return buffered; },
    redirect(code, url) { res.status(code); complete = () => res.redirect(code, url); return buffered; }
  };
  await handler(req, buffered);
  if (path !== "/api/ai/security-report") {
    const metrics = requestMetrics(path, req.method, res.statusCode, Date.now() - started);
    await monitor.record(metrics);
  }
  return complete ? complete() : res.status(500).end();
});

let aiResponder;
export const lineAiAutoReply = onDocumentCreated({
  document: "botnest/state/channels/{channelId}/conversations/{conversationId}/messages/{messageId}",
  serviceAccount: "botnest-worker-runtime@planning-with-ai-52d58.iam.gserviceaccount.com", region: "us-central1", timeoutSeconds: 90, memory: "256MiB", maxInstances: 5,
  secrets: [encryptionKey, openAiKey], retry: false,
}, event => {
  const message = event.data?.data();
  if (!message || message.direction !== "incoming" || !["text", "image", "audio"].includes(message.type) || message.unsent) return;
  aiResponder ||= createAiResponder({ store: createStore(getFirestore()), getKey: () => encryptionKey.value(), getOpenAiKey: () => openAiKey.value() });
  return aiResponder(event.params);
});

let zernioAiResponder;
export const facebookAiAutoReply = onDocumentCreated({
  document: "botnest/state/accounts/{uid}/zernioConversations/{conversationId}/messages/{messageId}",
  serviceAccount: "botnest-worker-runtime@planning-with-ai-52d58.iam.gserviceaccount.com", region: "us-central1", timeoutSeconds: 150, memory: "256MiB", maxInstances: 5,
  secrets: [openAiKey, zernioApiKey], retry: false,
}, event => {
  const message = event.data?.data();
  if (!message || message.direction !== "incoming" || !["text", "image", "audio"].includes(message.type) || message.unsent) return;
  zernioAiResponder ||= createZernioAiResponder({ store: createStore(getFirestore()), getOpenAiKey: () => openAiKey.value(), getZernioKey: () => zernioApiKey.value() });
  return zernioAiResponder(event.params);
});
