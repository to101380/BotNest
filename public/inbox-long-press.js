// Delegate to the stable list so refreshed rows cannot leave dangling timers.
export function installConversationLongPress(root, { enabled, select, delay = 500, schedule = setTimeout, unschedule = clearTimeout }) {
  const doc = root.ownerDocument, view = doc.defaultView;
  let gesture = null, timer = null, suppressClick = false, releaseTimer = null;
  function cancelPending() { if (timer !== null) unschedule(timer); timer = null; gesture = null; }
  function reset() { cancelPending(); if (releaseTimer !== null) unschedule(releaseTimer); releaseTimer = null; suppressClick = false; }
  function trigger() {
    const held = gesture;
    if (!held || !held.row.isConnected || !enabled()) { cancelPending(); return; }
    if (timer !== null) unschedule(timer); timer = null;
    suppressClick = true;
    select(held.row.dataset.conversationId);
  }
  function down(event) {
    // A new press is intentional, so it must not inherit the prior release guard.
    reset();
    if (event.button !== 0 || event.isPrimary === false || !enabled()) return;
    const row = event.target.closest?.(".conversation-item[data-conversation-id]");
    if (!row || !root.contains(row) || row.disabled) return;
    gesture = { row, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    timer = schedule(trigger, delay);
  }
  function move(event) {
    if (gesture && gesture.pointerId === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) cancelPending();
  }
  function release(event) {
    if (gesture && gesture.pointerId !== event.pointerId) return;
    cancelPending();
    if (suppressClick) releaseTimer = schedule(() => { suppressClick = false; releaseTimer = null; }, 700);
  }
  function click(event) {
    if (!suppressClick || event.detail === 0) return;
    // The long press can move/rebuild the row; consume its release even if the
    // pointer is now over an action button rather than the original row.
    event.preventDefault(); event.stopImmediatePropagation(); reset();
  }
  function contextMenu(event) {
    if (!gesture && !suppressClick) return;
    event.preventDefault();
    if (!suppressClick) trigger();
  }
  function key(event) {
    if (!event.shiftKey || event.code !== "Space" || event.repeat || !enabled()) return;
    const row = event.target.closest?.(".conversation-item[data-conversation-id]");
    if (!row || !root.contains(row)) return;
    event.preventDefault(); reset(); select(row.dataset.conversationId);
  }
  const subscriptions = [
    [doc, "pointerdown", down, true], [doc, "pointermove", move, true],
    [doc, "pointerup", release, true], [doc, "pointercancel", release, true],
    [doc, "click", click, true], [doc, "scroll", cancelPending, true],
    [doc, "visibilitychange", reset, false], [view, "blur", reset, false],
    [root, "contextmenu", contextMenu, false], [root, "keydown", key, false],
  ];
  for (const [target, type, listener, capture] of subscriptions) target.addEventListener(type, listener, capture);
  return { reset, dispose() { reset(); for (const [target, type, listener, capture] of subscriptions) target.removeEventListener(type, listener, capture); } };
}
