// Swipe to grade:
//
//                 ↑ Good
//       Hard ←   card   → Easy
//                 ↓ Again
//
// The two most-used grades are the two axes a thumb finds without aiming, and they're
// opposites, as their meanings are. Directions are configurable in settings.
// The direction maths is pure and unit-tested; `attachSwipe` is the thin pointer wiring.

export type Direction = "up" | "right" | "down" | "left";

/** Movement under this is a tap, not a drag — fingers are never still. */
export const TAP_SLOP = 8;

/** Which way a finished drag went, if far enough. The dominant axis wins; ties go horizontal. */
export function swipeDirection(dx: number, dy: number, threshold: number): Direction | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < threshold) return null;
  if (ax >= ay) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

/** Live state during a drag: where it's heading and how committed (0 → 1). `armed` = releasing now grades. */
export function swipeProgress(dx: number, dy: number, threshold: number): { dir: Direction | null; t: number; armed: boolean } {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < TAP_SLOP && ay < TAP_SLOP) return { dir: null, t: 0, armed: false };
  const dir: Direction = ax >= ay ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  const t = Math.min(1, Math.max(ax, ay) / threshold);
  return { dir, t, armed: t >= 1 };
}

/** Where a thrown card ends up — past any screen edge. */
export function flingTo(dir: Direction, w: number, h: number): { x: number; y: number; rot: number } {
  switch (dir) {
    case "right": return { x: w * 1.3, y: 40, rot: 22 };
    case "left": return { x: -w * 1.3, y: 40, rot: -22 };
    case "up": return { x: 0, y: -h * 1.1, rot: 0 };
    default: return { x: 0, y: h * 1.1, rot: 0 };
  }
}

export interface SwipeHandlers {
  onTap: (e: PointerEvent) => void;
  onDrag: (s: { dir: Direction | null; t: number; armed: boolean; dx: number; dy: number }) => void;
  onThrow: (dir: Direction) => void;
  /** False while the card is face down: a drag then does nothing. */
  enabled: () => boolean;
  threshold: () => number;
  /** Vertical swipes off, e.g. while a long card needs to scroll. */
  horizontalOnly?: () => boolean;
}

/** Wires pointer events on `el`. Returns a teardown function. */
export function attachSwipe(el: HTMLElement, h: SwipeHandlers): () => void {
  let id: number | null = null;
  let x0 = 0;
  let y0 = 0;
  let moved = false;
  const reset = () => h.onDrag({ dir: null, t: 0, armed: false, dx: 0, dy: 0 });
  const clampY = (dy: number) => (h.horizontalOnly?.() ? 0 : dy);

  // Obsidian mobile has its own gestures (sideways opens the sidebars, pulling down runs an action).
  // While the card can be thrown, its touches must not reach them, or one swipe does two things.
  const guard = (e: Event) => {
    if (h.enabled()) e.stopPropagation();
  };

  const down = (e: PointerEvent) => {
    guard(e);
    if (id !== null || e.button > 0) return;
    // Links, buttons and checkboxes inside the card keep working.
    if ((e.target as HTMLElement).closest("a, button, input, .tc-say")) return;
    id = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
    moved = false;
    try {
      el.setPointerCapture?.(id);
    } catch {
      // pointer already gone; moves on the element still arrive
    }
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    guard(e);
    const dx = e.clientX - x0;
    const dy = clampY(e.clientY - y0);
    if (Math.abs(dx) > TAP_SLOP || Math.abs(e.clientY - y0) > TAP_SLOP) moved = true;
    if (!h.enabled()) return;
    h.onDrag({ ...swipeProgress(dx, dy, h.threshold()), dx, dy });
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    guard(e);
    const dx = e.clientX - x0;
    const dy = clampY(e.clientY - y0);
    id = null;
    try {
      el.releasePointerCapture?.(e.pointerId);
    } catch {
      // capture was already lost (e.g. the system cancelled the gesture)
    }
    if (!moved) return h.onTap(e);
    if (!h.enabled()) return reset();
    const dir = swipeDirection(dx, dy, h.threshold());
    if (dir) h.onThrow(dir);
    else reset();
  };
  const cancel = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null;
    reset();
  };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancel);
  for (const t of ["touchstart", "touchmove", "touchend"]) el.addEventListener(t, guard, { passive: true });
  return () => {
    for (const t of ["touchstart", "touchmove", "touchend"]) el.removeEventListener(t, guard);
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", cancel);
  };
}
