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
  root.innerHTML = '<button type="button" class="profile-edit">編輯個人資料</button><form hidden><label>顯示名字<input name="name" autocomplete="nickname" maxlength="80" required></label><div class="profile-photo-row"><img class="profile-preview" alt="新大頭貼預覽" hidden><label class="profile-file">更換大頭貼<input name="avatar" type="file" accept="image/jpeg,image/png,image/webp"></label></div><p class="profile-note">JPG、PNG 或 WebP，最大 8 MB。照片會置中裁成正方形並壓縮。</p><div class="profile-actions"><button type="submit">儲存變更</button><button type="button" class="profile-cancel">取消</button></div></form><p class="profile-feedback" role="status" aria-live="polite"></p>';
  document.getElementById("email").after(root);
  const form = root.querySelector("form"), name = form.elements.name, file = form.elements.avatar, preview = root.querySelector(".profile-preview"), feedback = root.querySelector(".profile-feedback"), edit = root.querySelector(".profile-edit");
  let user = null, profile = null, generation = 0, pendingAvatar = null, busy = false, fileVersion = 0;
  function message(text, error = false) { feedback.textContent = text; feedback.classList.toggle("error", error); }
  function controls(value) { busy = value; for (const control of form.querySelectorAll("input,button")) control.disabled = value; edit.disabled = value; }
  function paint() {
    if (!user) return;
    const avatar = document.getElementById("avatar");
    document.getElementById("welcome").textContent = profile?.name || user.displayName || "我的帳號";
    if (profile?.avatar) {
      avatar.dataset.customPhoto = user.uid;
      const img = document.createElement("img"); img.alt = "你的大頭貼"; img.src = profile.avatar; avatar.replaceChildren(img);
    } else if (profile?.name && !avatar.querySelector("img")) avatar.textContent = Array.from(profile.name)[0];
  }
  function resetForm() {
    name.value = profile?.name || user?.displayName || ""; file.value = ""; pendingAvatar = null; fileVersion++;
    preview.hidden = true; preview.removeAttribute("src");
  }
  async function load() {
    const version = generation, current = user; controls(true);
    try { const data = await request(current); if (version !== generation) return; profile = data; resetForm(); paint(); message(""); }
    catch (e) { if (version === generation) message(e.message, true); }
    finally { if (version === generation) controls(false); }
  }
  edit.onclick = async () => {
    if (!profile) await load(); if (!profile || !user) return;
    form.hidden = false; edit.hidden = true; resetForm(); name.focus();
  };
  root.querySelector(".profile-cancel").onclick = () => { resetForm(); form.hidden = true; edit.hidden = false; message(""); };
  file.onchange = async () => {
    const version = generation, currentFile = ++fileVersion;
    if (!file.files[0]) return;
    controls(true); message("正在處理圖片…");
    try { const data = await prepareAvatar(file.files[0]); if (generation !== version || currentFile !== fileVersion) return; pendingAvatar = data; preview.src = data; preview.hidden = false; message("照片已準備好，按「儲存變更」完成更新。"); }
    catch (e) { if (generation === version) { file.value = ""; message(e.message, true); } }
    finally { if (generation === version) controls(false); }
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || !user || !profile) return;
    const value = name.value.trim(); if (!value) { message("請填寫名字。", true); name.focus(); return; }
    const version = generation; controls(true); message("正在儲存…");
    try {
      const data = await request(user, { method: "PUT", body: JSON.stringify({ name: value, revision: profile.revision, ...(pendingAvatar ? { avatar: pendingAvatar.split(",")[1] } : {}) }) });
      if (version !== generation) return;
      profile = data; paint(); resetForm(); form.hidden = true; edit.hidden = false; message("個人資料已更新。");
    } catch (e) { if (version === generation) message(e.message, true); }
    finally { if (version === generation) controls(false); }
  };
  return { setUser(next) {
    if (user?.uid === next?.uid) { user = next; paint(); return; }
    generation++; fileVersion++; user = next; profile = null; root.hidden = !next; form.hidden = true; edit.hidden = false; resetForm(); message(""); controls(false);
    delete document.getElementById("avatar").dataset.customPhoto;
    if (next) void load();
  } };
}
