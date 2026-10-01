let link, version = 0;
export async function showAdminEntry(user) {
  if (!link) {
    link = document.createElement("a"); link.href = "/admin.html"; link.textContent = "管理中心"; link.hidden = true;
    document.getElementById("app-nav").append(link);
  }
  const current = ++version; link.hidden = true;
  if (!user?.providerData?.some(p => p.providerId === "google.com" && p.uid === "111918945038301227460")) return;
  try { const token = await user.getIdTokenResult(); if (current === version) link.hidden = token.signInProvider !== "google.com"; } catch {}
}
