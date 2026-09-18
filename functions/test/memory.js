// Transactional in-memory adapter used only by unit tests; never deployed.
export function memoryDb() {
  const data = new Map();
  let queue = Promise.resolve();
  const snap = path => ({ id: path.split("/").at(-1), exists: data.has(path), data: () => structuredClone(data.get(path)) });
  const ref = path => ({
    path, collection: name => collection(`${path}/${name}`), get: async () => snap(path),
    set: async (value, options) => data.set(path, options?.merge ? { ...data.get(path), ...structuredClone(value) } : structuredClone(value)),
  });
  const fieldValue = (value, field) => field.split(".").reduce((current, key) => current?.[key], value);
  function collection(path) {
    return { doc: id => ref(`${path}/${id}`), orderBy: (field, direction) => query(path, field, direction), where: (field, operator, value) => query(path, null, null, null, Infinity, [{ field, operator, value }]) };
  }
  function query(path, field, direction, cursor, count = Infinity, filters = []) {
    return {
      startAfter: value => query(path, field, direction, value, count, filters),
      limit: value => query(path, field, direction, cursor, value, filters),
      where: (nextField, operator, value) => query(path, field, direction, cursor, count, [...filters, { field: nextField, operator, value }]),
      async get() {
        let docs = [...data.keys()].filter(key => key.startsWith(`${path}/`) && key.split("/").length === path.split("/").length + 1).map(snap);
        docs = docs.filter(doc => filters.every(filter => filter.operator === "==" && fieldValue(doc.data(), filter.field) === filter.value));
        if (field) docs.sort((a, b) => (fieldValue(a.data(), field) - fieldValue(b.data(), field) || a.id.localeCompare(b.id)) * (direction === "desc" ? -1 : 1));
        if (cursor) docs = docs.slice(docs.findIndex(doc => doc.id === cursor.id) + 1);
        const selected = docs.slice(0, count);
        return { docs: selected, empty: selected.length === 0 };
      },
    };
  }
  return { data, collection,
    runTransaction(fn) {
      const job = queue.then(async () => {
        const writes = [];
        const result = await fn({ get: async r => snap(r.path), getAll: async (...refs) => refs.map(r => snap(r.path)),
          set: (r, value, options) => writes.push(() => data.set(r.path, options?.merge ? { ...data.get(r.path), ...structuredClone(value) } : structuredClone(value))),
          update: (r, value) => writes.push(() => data.set(r.path, { ...data.get(r.path), ...structuredClone(value) })),
        });
        for (const write of writes) write();
        return result;
      });
      queue = job.catch(() => {}); return job;
    },
  };
}
