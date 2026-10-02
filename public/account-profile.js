export async function prepareAvatar(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw Error("請選擇 JPG、PNG 或 WebP 圖片。");
  if (file.size > 8 * 1024 * 1024) throw Error("請選擇小於 8 MB 的圖片。");
  let bitmap; try { bitmap = await createImageBitmap(file); } catch { throw Error("無法讀取這張圖片，請換一張再試。"); }
  try {
    if (bitmap.width * bitmap.height > 40000000) throw Error("圖片尺寸過大，請先縮小再上傳。");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 384;
    const ctx = canvas.getContext("2d"), side = Math.min(bitmap.width, bitmap.height);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 384, 384);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 384, 384);
    for (const quality of [.85, .65, .45]) { const value = canvas.toDataURL("image/jpeg", quality); if (value.length < 174000) return value; }
    throw Error("圖片壓縮後仍過大，請換一張圖片。");
  } finally { bitmap.close(); }
}
export function createAccountProfile({ request = async (user, options) => {
  const response = await fetch("/api/ai/profile", { ...options, credentials: "same-origin", cache: "no-store", headers: { Authorization: `Bearer ${await user.getIdToken()}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000) });
  const data = await response.json(); if (!response.ok) throw Error(data.error || "無法更新個人資料。"); return data;
} } = {}) {
  const style = document.createElement("link"); style.rel = "stylesheet"; style.href = "/account-profile.css"; document.head.append(style);
  const root = document.createElement("section"); root.className = "profile-editor"; root.hidden = true;
  const fields = [
    ["lastName", "姓氏", "family-name", 40, true], ["firstName", "名字", "given-name", 40, true],
    ["registrationEmail", "註冊信箱", "off", 254, false], ["contactEmail", "電子信箱", "email", 254, false],
    ["language", "語言"], ["phone", "聯絡電話", "tel", 40, true],
    ["taxId", "稅務編號", "off", 30, false], ["company", "公司名稱", "organization", 120, false],
    ["location", "所在地", "address-level2", 120, false], ["timezone", "時區", "off", 80, false],
    ["department", "部門"], ["jobTitle", "職稱"]
  ];
  const choices = { language: [["zh-TW", "繁體中文"], ["zh-CN", "简体中文"], ["en", "English"]], department: ["", "業務", "行銷", "客服", "營運", "技術", "財務", "其他"], jobTitle: ["", "創辦人", "負責人", "主管", "專員", "其他"] };
  root.innerHTML = `<form class="account-settings-form"><header class="profile-heading"><h1>帳戶設定</h1><button type="submit" class="profile-save">儲存</button></header><div class="profile-layout"><aside class="profile-sidebar"><div class="profile-avatar-slot"></div><div class="profile-photo-actions"><label class="profile-file">上傳一張照片<input name="avatar" type="file" accept="image/jpeg,image/png,image/webp"></label><button type="button" class="profile-remove">移除目前照片</button></div><p class="profile-note">JPG、PNG 或 WebP，最大 8 MB。照片會置中裁成正方形。</p><div class="profile-login-sources"></div></aside><div class="profile-grid">${fields.map(([key, label, autocomplete, max, required]) => `<label for="profile-${key}">${label}${required ? '<span class="profile-required">*</span>' : ""}${choices[key] ? `<select id="profile-${key}" name="${key}">${choices[key].map(item => { const [value, text] = Array.isArray(item) ? item : [item, item || "請選擇"]; return `<option value="${value}">${text}</option>`; }).join("")}</select>` : `<input id="profile-${key}" name="${key}" type="${key === "contactEmail" ? "email" : key === "phone" ? "tel" : "text"}" autocomplete="${autocomplete}" maxlength="${max}" ${required ? "required" : ""} ${["registrationEmail", "timezone"].includes(key) ? "readonly" : ""}>`}</label>`).join("")}</div></div><p class="profile-feedback" role="status" aria-live="polite"></p></form>`;
  const account = document.getElementById("account-page"); account.prepend(root);
  root.querySelector(".profile-avatar-slot").append(document.getElementById("avatar"));
  document.getElementById("welcome").hidden = document.getElementById("email").hidden = true;
  const sources = document.getElementById("provider-list"), heading = sources.previousElementSibling;
  root.querySelector(".profile-login-sources").append(heading, sources, document.getElementById("link-panel"));
  const form = root.querySelector("form"), file = form.elements.avatar, feedback = root.querySelector(".profile-feedback");
  let user = null, profile = null, generation = 0, pendingAvatar, busy = false, fileVersion = 0;
  function message(text, error = false) { feedback.textContent = text; feedback.classList.toggle("error", error); }
  function controls(value) { busy = value; for (const control of form.querySelectorAll("input,select,button")) control.disabled = value; }
  function paint() {
    if (!user) return;
    const avatar = document.getElementById("avatar"); avatar.dataset.customPhoto = user.uid;
    const photo = pendingAvatar !== undefined ? pendingAvatar : profile?.avatar;
    if (photo) { const img = document.createElement("img"); img.alt = "你的大頭貼"; img.src = photo; avatar.replaceChildren(img); }
    else if (photo === null) avatar.textContent = Array.from(profile?.name || user.displayName || "帳")[0];
    else if (user.photoURL) { const img = document.createElement("img"); img.alt = "你的大頭貼"; img.src = user.photoURL; avatar.replaceChildren(img); }
    else avatar.textContent = Array.from(profile?.name || user.displayName || "帳")[0];
  }
  function resetForm() {
    for (const [key] of fields) {
      const input = form.elements[key];
      const fallback = key === "firstName" ? profile?.name || user?.displayName || "" : key === "contactEmail" || key === "registrationEmail" ? user?.email || "" : key === "language" ? "zh-TW" : key === "timezone" ? "Asia/Taipei" : "";
      const value = key === "registrationEmail" ? user?.email || "" : profile?.[key] ?? fallback;
      if (input.tagName === "SELECT" && value && !Array.from(input.options).some(option => option.value === value)) input.add(new Option(value, value));
      input.value = value;
    }
    file.value = ""; pendingAvatar = undefined; fileVersion++; paint();
  }
  async function load() {
    const version = generation, current = user; controls(true);
    try { const data = await request(current); if (version !== generation) return; profile = data; resetForm(); message(""); }
    catch (e) { if (version === generation) message(e.message, true); }
    finally { if (version === generation) controls(false); }
  }
  root.querySelector(".profile-remove").onclick = () => { pendingAvatar = null; file.value = ""; fileVersion++; paint(); message("照片將在儲存後移除。"); };
  file.onchange = async () => {
    const version = generation, currentFile = ++fileVersion; if (!file.files[0]) return;
    controls(true); message("正在處理圖片…");
    try { const data = await prepareAvatar(file.files[0]); if (generation !== version || currentFile !== fileVersion) return; pendingAvatar = data; paint(); message("照片已準備好，按「儲存」完成更新。"); }
    catch (e) { if (generation === version) { file.value = ""; message(e.message, true); } }
    finally { if (generation === version) controls(false); }
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || !user || !profile) return;
    const values = Object.fromEntries(fields.filter(([key]) => key !== "registrationEmail").map(([key]) => [key, form.elements[key].value.trim()]));
    const version = generation; controls(true); message("正在儲存…");
    try {
      const data = await request(user, { method: "PUT", body: JSON.stringify({ ...values, name: `${values.lastName}${values.firstName}`, revision: profile.revision, ...(pendingAvatar !== undefined ? { avatar: pendingAvatar === null ? null : pendingAvatar.split(",")[1] } : {}) }) });
      if (version !== generation) return; profile = data; resetForm(); message("帳戶資料已儲存。");
    } catch (e) { if (version === generation) message(e.message, true); }
    finally { if (version === generation) controls(false); }
  };
  return { setUser(next) {
    if (user?.uid === next?.uid) { user = next; paint(); return; }
    generation++; fileVersion++; user = next; profile = null; root.hidden = !next; resetForm(); message(""); controls(false);
    delete document.getElementById("avatar").dataset.customPhoto;
    if (next) void load();
  } };
}