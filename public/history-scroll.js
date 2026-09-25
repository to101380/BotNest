// Load a page only after an upward user scroll, never from layout/anchor changes.
export function watchHistoryScroll(area, { canLoad, load, onError }) {
  let previousTop = area.scrollTop, pending = false;
  async function request() {
    if (pending || !canLoad()) return;
    pending = true;
    try { await load(); } catch (error) { onError(error); }
    finally { pending = false; previousTop = area.scrollTop; }
  }
  area.addEventListener("scroll", () => {
    const top = area.scrollTop, movingUp = top < previousTop;
    previousTop = top;
    if (movingUp && top <= 24) void request();
  }, { passive: true });
  // Also supports retrying at the top and pages too short to have a scrollbar.
  area.addEventListener("wheel", event => {
    if (event.deltaY < 0 && area.scrollTop <= 24) void request();
  }, { passive: true });
  return { sync() { previousTop = area.scrollTop; } };
}
