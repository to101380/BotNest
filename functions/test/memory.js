// Transactional in-memory adapter used only by unit tests; never deployed.
export function memoryDb() {
  const data = new Map();
  const reads = { documents: 0, queries: 0, returned: 0 };
  let queue = Promise.resolve();
  const mergeMap = (old, value) => {
    const result = { ...old };
    for (const [key, next] of Object.entries(value)) {
      result[key] = next && typeof next === 'object' && !Array.isArray(next) && Object.keys(next).length
        ? mergeMap(old?.[key], next) : structuredClone(next);
    }
    return result;
  };
  const write = (path, value, options) => data.set(path, options?.merge
    ? mergeMap(data.get(path), value)
    : options?.mergeFields ? { ...data.get(path), ...structuredClone(value) } : structuredClone(value));
  const snap = path => ({ id: path.split("/").at(-1), exists: data.has(path), ref: ref(path), data: () => structuredClone(data.get(path)) });
  const ref = path => ({
    path, id: path.split("/").at(-1), delete: async () => data.delete(path), collection: name => collection(`${path}/${name}`), get: async () => { reads.documents++; return snap(path); },
    set: async (value, options) => write(path, value, options),
  });
  const fieldValue = (value, field) => String(field).split(".").reduce((current, key) => current?.[key], value);
  function collection(path) {
    return { doc: id => ref(`${path}/${id}`), orderBy: (field, direction) => query(path, field, direction), where: (field, operator, value) => query(path, null, null, null, Infinity, [{ field, operator, value }]) };
  }
  function query(path, field, direction, cursor, count = Infinity, filters = []) {
    return {
      orderBy: (nextField, nextDirection) => query(path, nextField, nextDirection, cursor, count, filters),
      startAfter: value => query(path, field, direction, value, count, filters),
      limit: value => query(path, field, direction, cursor, value, filters),
      where: (nextField, operator, value) => query(path, field, direction, cursor, count, [...filters, { field: nextField, operator, value }]),
      async get() {
        reads.queries++;
        let docs = [...data.keys()].filter(key => key.startsWith(`${path}/`) && key.split("/").length === path.split("/").length + 1).map(snap);
        docs = docs.filter(doc => filters.every(filter => {
          const actual = String(filter.field) === "__name__" ? doc.id : fieldValue(doc.data(), filter.field);
          return filter.operator === "in" ? filter.value.includes(actual) : filter.operator === "<=" ? actual <= filter.value : filter.operator === "<" ? actual < filter.value : filter.operator === "==" && actual === filter.value;
        }));
        if (String(field) === "__name__") docs.sort((a, b) => a.id.localeCompare(b.id));
        else if (field) docs.sort((a, b) => (fieldValue(a.data(), field) - fieldValue(b.data(), field) || a.id.localeCompare(b.id)) * (direction === "desc" ? -1 : 1));
        if (cursor) docs = typeof cursor === "string" ? docs.filter(doc => doc.id > cursor) : docs.slice(docs.findIndex(doc => doc.id === cursor.id) + 1);
        const selected = docs.slice(0, count);
        reads.returned += selected.length;
        return { docs: selected, empty: selected.length === 0 };
      },
    };
  }
  return { data, reads, collection,
    runTransaction(fn) {
      const job = queue.then(async () => {
        const writes = [];
        const result = await fn({ get: async r => snap(r.path), getAll: async (...refs) => refs.map(r => snap(r.path)),
          set: (r, value, options) => writes.push(() => write(r.path, value, options)),
          delete: r => writes.push(() => data.delete(r.path)),
          update: (r, value) => writes.push(() => data.set(r.path, { ...data.get(r.path), ...structuredClone(value) })),
        });
        for (const write of writes) write();
        return result;
      });
      queue = job.catch(() => {}); return job;
    },
  };
}
