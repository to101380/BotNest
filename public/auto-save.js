// One writer per editor. Acknowledging a request never acknowledges newer input.
export function createAutoSave({ read, write, valid = () => true, state = () => {}, delay = 700 }) {
  let revision = 0, saved = 0, timer, running, disposed = false, paused = false, failure = null;
  const pending = () => revision !== saved;
  const notify = phase => { if (!disposed) state({ phase, pending: pending(), error: failure }); };
  async function run() {
    while (!disposed && pending()) {
      if (paused) { notify("pending"); return false; }
      const value = read(), version = revision;
      if (!valid(value)) { notify("invalid"); return false; }
      notify("saving");
      try { await write(value); }
      catch (error) { if (!disposed) { failure = error; notify("error"); } return false; }
      if (disposed) return false;
      saved = version; failure = null;
    }
    notify("saved"); return !disposed;
  }
  function flush() {
    clearTimeout(timer);
    if (disposed) return Promise.resolve(false);
    if (!running) running = run().finally(() => { running = null; });
    return running;
  }
  return {
    pending,
    pause() { paused = true; revision++; clearTimeout(timer); notify("pending"); },
    resume() { paused = false; if (pending()) timer = setTimeout(() => void flush(), delay); },
    change(immediate = false) {
      if (disposed) return;
      revision++; failure = null; clearTimeout(timer); notify("pending");
      if (immediate) void flush(); else timer = setTimeout(() => void flush(), delay);
    },
    flush,
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
