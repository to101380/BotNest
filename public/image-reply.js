const $ = id => document.getElementById(id);

export function createImageReply({ api, context, setAttachment, trustedUrl, report }) {
  let items = [], next = null, busy = false, generation = 0, libraryError = "";
  function preview() {
    const attachment = context().attachment, card = attachment?.imageCard;
    $("line-card-sample-title").textContent = card?.title || attachment?.name || "圖片";
    $("line-card-sample-description").textContent = card?.description || "";
    $("line-card-sample-description").hidden = !card?.description;
  }
  function sync(enabled) {
    const attachment = context().attachment, image = attachment?.kind === "image";
    $("line-card-editor").hidden = !image;
    $("line-image-library").disabled = !enabled;
    if (!image) { $("line-card-sample-image").removeAttribute("src"); return; }
    $("line-image-format").value = attachment.imageCard ? "card" : "image";
    $("line-card-fields").hidden = !attachment.imageCard;
    $("line-card-title").value = attachment.imageCard?.title || "";
    $("line-card-description").value = attachment.imageCard?.description || "";
    for (const id of ["line-image-format", "line-card-title", "line-card-description", "line-save-image"]) $(id).disabled = !enabled;
    $("line-save-image").disabled ||= !!attachment.library;
    $("line-save-image").textContent = attachment.library ? "已加入素材" : "加入圖片素材";
    $("line-image-expiry").textContent = `圖片連結有效至 ${new Date(attachment.expiresAt).toLocaleDateString("zh-TW")}；收藏不會延長期限。`;
    const url = trustedUrl(attachment);
    if (url && $("line-card-sample-image").getAttribute("src") !== url.href) $("line-card-sample-image").src = url.href;
    preview();
  }
  $("line-image-format").addEventListener("change", () => {
    const ctx = context(); if (!ctx.enabled || !ctx.attachment) return;
    setAttachment({ ...ctx.attachment, imageCard: $("line-image-format").value === "card" ? { title: "", description: "" } : null });
  });
  for (const id of ["line-card-title", "line-card-description"]) $(id).addEventListener("input", () => {
    const ctx = context(); if (!ctx.enabled || !ctx.attachment?.imageCard) return;
    ctx.attachment.imageCard = { title: $("line-card-title").value, description: $("line-card-description").value };
    preview();
  });
  $("line-save-image").addEventListener("click", async () => {
    const ctx = context(); if (!ctx.enabled || !ctx.attachment || busy) return;
    const stamp = generation; busy = true; $("line-save-image").disabled = true;
    try {
      await api(`image-library/${ctx.attachment.id}`, { method: "PUT" });
      if (stamp !== generation) return;
      if (context().conversationId === ctx.conversationId && context().attachment?.id === ctx.attachment.id) setAttachment({ ...context().attachment, library: true });
    } catch (error) { if (stamp === generation) report(error); }
    finally { if (stamp === generation) { busy = false; sync(context().enabled); } }
  });
  function renderLibrary() {
    const grid = $("line-library-grid"); grid.replaceChildren();
    const search = $("line-library-search").value.trim().normalize("NFKC").toLowerCase();
    const matches = items.filter(item => item.name.normalize("NFKC").toLowerCase().includes(search));
    for (const item of matches) {
      const url = trustedUrl(item); if (!url) continue;
      const tile = document.createElement("article"), pick = document.createElement("button"), image = document.createElement("img"), name = document.createElement("strong"), expiry = document.createElement("small"), remove = document.createElement("button");
      tile.className = "library-image-tile"; pick.type = remove.type = "button";
      image.src = url.href; image.alt = item.name; image.loading = "lazy";
      name.textContent = item.name; expiry.textContent = `有效至 ${new Date(item.expiresAt).toLocaleDateString("zh-TW")}`;
      pick.append(image, name, expiry); pick.disabled = busy;
      pick.addEventListener("click", () => {
        if (!context().enabled) return;
        setAttachment({ ...item, imageCard: { title: "", description: "" } });
        $("line-library-dialog").close();
      });
      remove.textContent = "移出素材"; remove.disabled = busy; remove.className = "library-remove";
      remove.addEventListener("click", async () => {
        if (!context().enabled || busy) return;
        const stamp = generation; busy = true; renderLibrary();
        try {
          await api(`image-library/${item.id}`, { method: "DELETE" });
          if (stamp !== generation) return;
          items = items.filter(value => value.id !== item.id);
          if (context().attachment?.id === item.id) setAttachment(null);
        } catch (error) { if (stamp === generation) report(error); }
        finally { if (stamp === generation) { busy = false; renderLibrary(); } }
      });
      tile.append(pick, remove); grid.append(tile);
    }
    $("line-library-state").textContent = busy ? "讀取中…" : libraryError || (matches.length ? "選擇圖片後，可編輯卡片再傳送。" : "沒有符合的圖片。可先上傳圖片，再按「加入圖片素材」。");
    $("line-library-more").hidden = !next; $("line-library-more").disabled = busy;
  }
  async function load(more = false) {
    if (busy || !context().enabled) return;
    const stamp = generation; busy = true; libraryError = ""; renderLibrary();
    try {
      const data = await api(`image-library${more && next ? `?before=${encodeURIComponent(next)}` : ""}`);
      if (stamp !== generation) return;
      items = [...new Map([...(more ? items : []), ...data.items].map(item => [item.id, item])).values()]; next = data.next;
    } catch (error) { if (stamp === generation) { report(error); libraryError = "讀取失敗，請關閉後重新開啟。"; } }
    finally { if (stamp === generation) { busy = false; renderLibrary(); } }
  }
  $("line-image-library").addEventListener("click", () => {
    if (!context().enabled) return;
    items = []; next = null; $("line-library-search").value = "";
    $("line-library-dialog").showModal(); void load();
  });
  $("line-library-close").addEventListener("click", () => $("line-library-dialog").close());
  $("line-library-more").addEventListener("click", () => void load(true));
  $("line-library-search").addEventListener("input", renderLibrary);
  return { sync, reset() { generation++; items = []; next = null; busy = false; libraryError = ""; $("line-library-dialog").close(); $("line-library-grid").replaceChildren(); $("line-card-sample-image").removeAttribute("src"); } };
}
