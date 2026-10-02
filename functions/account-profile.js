const error = (status, message) => Object.assign(new Error(message), { status });
const profileFields = { lastName: 40, firstName: 40, contactEmail: 254, phone: 40, taxId: 30, company: 120, location: 120, department: 60, jobTitle: 60, language: 20, timezone: 80 };
export function validateProfile(body) {
  if (!body || typeof body !== "object" || Object.keys(body).some(k => !["name", "avatar", "revision", ...Object.keys(profileFields)].includes(k))) throw error(400, "個人資料格式錯誤。");
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(body.name) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw error(400, "名字請填寫 1～80 個字。");
  const result = { name: body.name.trim(), revision: body.revision };
  for (const [key, limit] of Object.entries(profileFields)) {
    if (!Object.hasOwn(body, key)) continue;
    if (typeof body[key] !== "string" || body[key].trim().length > limit || /[\u0000-\u001f\u007f]/.test(body[key])) throw error(400, "個人資料欄位格式錯誤。");
    result[key] = body[key].trim();
  }
  if (result.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.contactEmail)) throw error(400, "請填寫有效的電子信箱。");
  if (result.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: result.timezone }); } catch { throw error(400, "時區格式錯誤。"); } }
  if (Object.hasOwn(body, "avatar")) {
    if (body.avatar === null) { result.avatar = null; return result; }
    if (typeof body.avatar !== "string" || body.avatar.length > 180000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.avatar) || body.avatar.length % 4) throw error(400, "圖片資料格式錯誤。");
    const bytes = Buffer.from(body.avatar, "base64");
    if (bytes.length > 128 * 1024) throw error(413, "大頭貼壓縮後須小於 128 KB。");
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if (!jpeg && !png) throw error(400, "大頭貼僅支援 JPEG 或 PNG。");
    result.avatar = `data:image/${jpeg ? "jpeg" : "png"};base64,${bytes.toString("base64")}`;
  }
  return result;
}
export function createProfileStore(db) {
  const accounts = db.collection("botnest").doc("state").collection("accounts");
  const profile = uid => accounts.doc(uid).collection("profile").doc("personal");
  return {
    async read(uid) { return (await profile(uid).get()).data() || { name: null, avatar: null, revision: 0 }; },
    async save(uid, value, at) {
      return db.runTransaction(async tx => {
        const [account, old] = await tx.getAll(accounts.doc(uid), profile(uid));
        if (account.data()?.access?.disabled) throw error(403, "帳號已停用。");
        const previous = old.data() || {};
        if ((previous.revision || 0) !== value.revision) throw error(409, "個人資料已在其他地方修改，請重新整理後再試。");
        const result = { ...previous, ...value, avatar: Object.hasOwn(value, "avatar") ? value.avatar : previous.avatar ?? null, revision: value.revision + 1, updatedAt: at };
        tx.set(profile(uid), result); tx.set(accounts.doc(uid), { profileName: value.name }, { merge: true }); return result;
      });
    },
  };
}
export function createProfileHandler({ verifyToken, store, accountStore, authorizeSession = async () => {}, now = Date.now }) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store"); res.set("X-Content-Type-Options", "nosniff");
    try {
      const token = /^Bearer (\S+)$/.exec(req.get("authorization") || "")?.[1];
      let user; try { if (token) user = await verifyToken(token); } catch {}
      if (!user?.uid) throw error(401, "請先登入。");
      if (!["google.com", "password"].includes(user.firebase?.sign_in_provider) || user.firebase.sign_in_provider === "password" && !user.email_verified) throw error(403, "請先完成帳號驗證。");
      await authorizeSession(req, user);
      if (await accountStore.isAccountDisabled(user.uid)) throw error(403, "帳號已停用。");
      await accountStore.aiAttempt(user.uid, "api", now(), 120);
      if (req.method === "GET") return res.json(await store.read(user.uid));
      if (req.method !== "PUT") throw error(405, "不支援此操作。");
      if (!["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(req.get("origin"))) throw error(403, "請從正式網站修改資料。");
      if (req.rawBody?.length > 190000) throw error(413, "圖片過大。");
      const value = validateProfile(req.body);
      await accountStore.aiAttempt(user.uid, "profile", now(), 6);
      return res.json(await store.save(user.uid, value, now()));
    } catch (e) { return res.status(e.status || 503).json({ error: e.status ? e.message : "個人資料暫時無法儲存，請稍後重試。" }); }
  };
}
