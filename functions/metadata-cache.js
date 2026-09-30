// Warm-instance cache for optional avatar metadata only, never messages or permissions.
export function createMetadataCache({ now = Date.now, ttl = 300000, maximum = 100 } = {}) {
  const entries = new Map();
  return async function get(key, load) {
    const prior = entries.get(key);
    if (prior && (prior.pending || prior.expires > now())) return prior.promise;
    if (prior) entries.delete(key);
    while (entries.size >= maximum) entries.delete(entries.keys().next().value);
    const entry = { pending: true, expires: 0 };
    entry.promise = Promise.resolve().then(load).then(value => {
      entry.pending = false; entry.expires = now() + ttl;
      return value;
    }, error => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    entries.set(key, entry);
    return entry.promise;
  };
}
