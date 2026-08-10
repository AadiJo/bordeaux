import * as React from "react";

// Global pointer drags with best-effort capture and terminal cancellation.
  function begin(event, handlers) {
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    let active = true;
    let pendingMove = null;
    let moveFrame = 0;
    let lastMove = event;
    const previousCursor = document.body.style.cursor;

    const dispatchMove = (next) => {
      handlers.move(next);
      lastMove = next;
    };
    const flushMove = () => {
      if (moveFrame) cancelAnimationFrame(moveFrame);
      moveFrame = 0;
      const next = pendingMove;
      pendingMove = null;
      if (next) dispatchMove(next);
    };
    const cleanup = () => {
      if (!active) return;
      active = false;
      if (moveFrame) cancelAnimationFrame(moveFrame);
      moveFrame = 0;
      pendingMove = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      if (handlers.cursor) document.body.style.cursor = previousCursor;
      try {
        if (target && target.hasPointerCapture && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      } catch (_) {}
    };
    const move = (next) => {
      if (!active || next.pointerId !== pointerId) return;
      if (!handlers.coalesce) { dispatchMove(next); return; }
      pendingMove = next;
      if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
    };
    const end = (next) => {
      if (!active || next.pointerId !== pointerId) return;
      flushMove();
      if (Number.isFinite(next.clientX) && Number.isFinite(next.clientY)
        && (next.clientX !== lastMove.clientX || next.clientY !== lastMove.clientY)) dispatchMove(next);
      cleanup();
      if (handlers.end) handlers.end(next);
    };
    const cancel = (next, options) => {
      if (!active || (next && next.pointerId != null && next.pointerId !== pointerId)) return;
      if (!options || options.flush !== false) flushMove();
      cleanup();
      if (handlers.cancel) handlers.cancel(next);
    };

    try { if (target && target.setPointerCapture) target.setPointerCapture(pointerId); } catch (_) {}
    if (handlers.cursor) document.body.style.cursor = handlers.cursor;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return (options) => cancel(null, options);
  }

  function useController() {
    const active = React.useRef(null);
    React.useEffect(() => () => { if (active.current) active.current({ flush: false }); }, []);
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
      cancel(options) { if (active.current) active.current(options); active.current = null; },
    }), []);
  }

export const PointerDrag = { begin, useController };
