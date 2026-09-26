import { aiEligibility } from "./ai-policy.js";

// Items have already been scoped to the connected account by the list handler.
export async function attachInboxAi(store, uid, items, provider, at) {
  if (!items.length) return;
  const settings = await store.accountAiSettings(uid);
  await Promise.all(items.map(async item => {
    const id = provider === "line" ? item.id : item.id.slice(provider.length + 1);
    const control = await store.aiControl(uid, provider, id);
    item.ai = { control, state: aiEligibility(settings, provider, control, at) };
  }));
}
