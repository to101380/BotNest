import { aiEligibility } from "./ai-policy.js";

// Items have already been scoped to the connected account by the list handler.
export async function attachInboxAi(store, uid, items, provider, at) {
  if (!items.length) return;
  const ids = items.map(item => provider === "line" ? item.id : item.id.slice(provider.length + 1));
  const [settings, controls] = await Promise.all([store.accountAiSettings(uid), store.aiControls(uid, provider, ids)]);
  items.forEach((item, index) => {
    const control = controls.get(ids[index]);
    item.ai = { control, state: aiEligibility(settings, provider, control, at) };
  });
}
