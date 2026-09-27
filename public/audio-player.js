export function createAudioPlayer(load, onPlay = () => {}) {
  const root = document.createElement("div"), button = document.createElement("button"), audio = document.createElement("audio"), note = document.createElement("span");
  root.className = "message-audio"; button.type = "button"; button.textContent = "▶ 播放語音";
  audio.controls = true; audio.preload = "none"; audio.hidden = true; audio.setAttribute("aria-label", "語音訊息");
  const seek = document.createElement("input"); seek.type = "range"; seek.className = "audio-seek";
  seek.min = "0"; seek.max = "1"; seek.step = "0.01"; seek.value = "0"; seek.hidden = true;
  seek.setAttribute("aria-label", "語音播放進度");
  audio.addEventListener("loadedmetadata", () => { if (Number.isFinite(audio.duration)) seek.max = String(audio.duration); });
  audio.addEventListener("timeupdate", () => { seek.value = String(audio.currentTime); });
  seek.addEventListener("input", () => { if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, Number(seek.value)); });
  note.className = "audio-note"; note.setAttribute("role", "status"); root.append(button, audio, seek, note);
  let version = 0, objectUrl = null;
  button.addEventListener("click", async () => {
    const request = ++version; button.disabled = true; note.textContent = "正在載入語音…";
    try {
      const value = await load(); if (request !== version) return;
      if (!/^audio\/(mpeg|mp4|wav|webm|ogg)$/.test(value.mime) || typeof value.data !== "string" || value.data.length > 12 * 1024 * 1024) throw new Error("語音格式無法播放。");
      const bytes = Uint8Array.from(atob(value.data), c => c.charCodeAt(0));
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: value.mime }));
      audio.src = objectUrl; audio.hidden = false; seek.hidden = false; button.hidden = true; note.textContent = "";
      await audio.play().catch(() => { if (request === version) note.textContent = "請按播放鍵聆聽語音。"; });
    } catch (error) { if (request === version) { note.textContent = error.message || "語音暫時無法播放。"; button.textContent = "重新載入語音"; } }
    finally { if (request === version) button.disabled = false; }
  });
  audio.addEventListener("play", () => { note.textContent = ""; onPlay(audio); });
  audio.addEventListener("error", () => { note.textContent = "語音無法播放，請重試或使用支援此格式的瀏覽器。"; button.hidden = false; button.textContent = "重新載入語音"; });
  return { root, audio, dispose() { version++; audio.pause(); audio.removeAttribute("src"); audio.load(); if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; } };
}
