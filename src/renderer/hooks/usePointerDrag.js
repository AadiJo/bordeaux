import * as React from "react";

// Cancellable pointer drags with capture, blur, and unmount cleanup.
  function begin(event, handlers) {
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    let active = true;
    const previousCursor = document.body.style.cursor;

    const cleanup = () => {
      if (!active) return;
      active = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      if (target && target.removeEventListener) target.removeEventListener('lostpointercapture', cancel);
      if (handlers.cursor) document.body.style.cursor = previousCursor;
      try {
        if (target && target.hasPointerCapture && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      } catch (_) {}
    };
    const move = (next) => { if (active && next.pointerId === pointerId) handlers.move(next); };
    const end = (next) => {
      if (!active || next.pointerId !== pointerId) return;
      cleanup();
      if (handlers.end) handlers.end(next);
    };
    const cancel = (next) => {
      if (!active || (next && next.pointerId != null && next.pointerId !== pointerId)) return;
      cleanup();
      if (handlers.cancel) handlers.cancel(next);
    };

    try { if (target && target.setPointerCapture) target.setPointerCapture(pointerId); } catch (_) {}
    if (handlers.cursor) document.body.style.cursor = handlers.cursor;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    if (target && target.addEventListener) target.addEventListener('lostpointercapture', cancel);
    return cancel;
  }

  function useController() {
    const active = React.useRef(null);
    React.useEffect(() => () => { if (active.current) active.current(); }, []);
    return React.useMemo(() => ({
      start(event, handlers) {
        if (active.current) active.current();
        const cancel = begin(event, {
          ...handlers,
          end(next) { active.current = null; if (handlers.end) handlers.end(next); },
          cancel(next) { active.current = null; if (handlers.cancel) handlers.cancel(next); },
        });
        active.current = cancel;
      },
      cancel() { if (active.current) active.current(); active.current = null; },
    }), []);
  }

export const PointerDrag = { begin, useController };
