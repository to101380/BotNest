// Presentation only: observe existing UI state without delaying navigation or requests.
const ease = "cubic-bezier(.22, 1, .36, 1)";
const groupSelector = ".assistant-tabs, .email-tabs, #app-nav, .conversation-ai-controls, .inbox-status-filters";
const pageSelector = "#ai-page, #assistant-page, #customers-page, #channels-page, #account-page, #signed-out";
const panelSelector = `${pageSelector}, .assistant-panel`;
const selectedSelector = '[aria-selected="true"], [aria-pressed="true"], [aria-current="page"]';

export function createUiMotion(root = document) {
  const view = root.defaultView || root.ownerDocument.defaultView;
  if (!view.Element.prototype.animate || !view.ResizeObserver) return () => {};
  const reduced = view.matchMedia("(prefers-reduced-motion: reduce)");
  const tracks = new Map(), visiblePanels = new Map(), entrances = new Map();
  let frame = 0, stopped = false, resizePending = true, pageDirection = 1, tabDirection = 1;
  const schedule = () => { if (!frame && !stopped) frame = view.requestAnimationFrame(update); };
  const resize = new view.ResizeObserver(() => { resizePending = true; schedule(); });
  const onResize = () => { resizePending = true; schedule(); };
  const observer = new view.MutationObserver(schedule);

  function attach(group) {
    const indicator = root.createElement ? root.createElement("i") : root.ownerDocument.createElement("i");
    indicator.className = "motion-indicator";
    indicator.setAttribute("aria-hidden", "true");
    indicator.hidden = true;
    group.append(indicator);
    group.classList.add("motion-track");
    const track = { indicator, active: null, geometry: "", visible: false, animation: null, controls: new Set() };
    tracks.set(group, track);
    resize.observe(group);
    return track;
  }

  function positionIndicator(group, track, instant) {
    const controls = [...group.querySelectorAll(":scope > button, :scope > a")];
    for (const control of controls) if (!track.controls.has(control)) { track.controls.add(control); resize.observe(control); }
    const active = controls.find(control => control.matches(selectedSelector));
    if (!active || !group.getClientRects().length || !active.getClientRects().length) {
      if (!track.indicator.hidden) track.indicator.hidden = true;
      track.visible = false;
      return;
    }
    const box = active.getBoundingClientRect(), outer = group.getBoundingClientRect();
    // Coordinates include the track's scroll offset, so resizing/scrolling never detaches the pill.
    const x = box.left - outer.left + group.scrollLeft - group.clientLeft;
    const y = box.top - outer.top + group.scrollTop - group.clientTop;
    const next = { transform: `translate(${x}px, ${y}px)`, width: `${box.width}px`, height: `${box.height}px` };
    const geometry = JSON.stringify(next), changed = track.active !== active;
    if (track.visible && !changed && track.geometry === geometry) return;
    if (changed && track.active) {
      const direction = controls.indexOf(active) >= controls.indexOf(track.active) ? 1 : -1;
      if (group.id === "app-nav") pageDirection = direction;
      if (group.classList.contains("assistant-tabs")) tabDirection = direction;
    }
    const animate = track.visible && (!instant || changed) && !reduced.matches;
    const current = view.getComputedStyle(track.indicator);
    const from = animate ? { transform: current.transform, width: current.width, height: current.height } : next;
    track.animation?.cancel();
    track.indicator.hidden = false;
    track.animation = track.indicator.animate([from, next], { duration: animate ? 380 : 0, easing: ease, fill: "forwards" });
    track.geometry = geometry;
    track.active = active;
    track.visible = true;
    if (!group.classList.contains("motion-ready")) group.classList.add("motion-ready");
  }

  function updatePanels() {
    for (const panel of root.querySelectorAll(panelSelector)) {
      const visible = !panel.hidden && panel.getClientRects().length > 0;
      const previous = visiblePanels.get(panel);
      visiblePanels.set(panel, visible);
      if (!visible) { entrances.get(panel)?.cancel(); entrances.delete(panel); continue; }
      if (previous !== false || reduced.matches) continue;
      // The parent page already moves its contents. Animate only the tab when switching within it.
      if (panel.classList.contains("assistant-panel") && entrances.get(root.querySelector("#assistant-page"))?.playState === "running") continue;
      entrances.get(panel)?.cancel();
      const direction = panel.classList.contains("assistant-panel") ? tabDirection : pageDirection;
      const animation = panel.animate([
        { opacity: .35, transform: `translateX(${direction * 14}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ], { duration: 300, easing: ease });
      entrances.set(panel, animation);
      animation.onfinish = () => { if (entrances.get(panel) === animation) entrances.delete(panel); };
    }
  }

  function updateDrawer() {
    const panel = root.querySelector("#customer-panel");
    if (!panel) return;
    const open = !panel.hidden && panel.classList.contains("open");
    if (!open && panel.contains(root.activeElement)) root.querySelector("#customer-toggle")?.focus({ preventScroll: true });
    if (panel.inert !== !open) panel.inert = !open;
    if (panel.getAttribute("aria-hidden") !== String(!open)) panel.setAttribute("aria-hidden", String(!open));
  }

  function update() {
    frame = 0;
    for (const group of root.querySelectorAll(groupSelector)) positionIndicator(group, tracks.get(group) || attach(group), resizePending);
    resizePending = false;
    for (const [group, track] of tracks) if (!group.isConnected) {
      track.animation?.cancel(); resize.unobserve(group);
      for (const control of track.controls) resize.unobserve(control);
      tracks.delete(group);
    }
    updatePanels();
    updateDrawer();
  }

  const onPreference = () => {
    for (const animation of entrances.values()) animation.cancel();
    entrances.clear();
    for (const track of tracks.values()) { track.animation?.finish(); track.geometry = ""; }
    onResize();
  };
  observer.observe(root.body || root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-selected", "aria-pressed", "aria-current", "hidden", "class"] });
  view.addEventListener("resize", onResize);
  reduced.addEventListener("change", onPreference);
  (root.fonts || root.ownerDocument?.fonts)?.ready.then(schedule);
  schedule();
  return () => {
    stopped = true; observer.disconnect(); resize.disconnect(); view.cancelAnimationFrame(frame);
    view.removeEventListener("resize", onResize); reduced.removeEventListener("change", onPreference);
    for (const [group, track] of tracks) { track.animation?.cancel(); track.indicator.remove(); group.classList.remove("motion-track", "motion-ready"); }
    for (const animation of entrances.values()) animation.cancel();
  };
}

if (typeof document !== "undefined") createUiMotion();
