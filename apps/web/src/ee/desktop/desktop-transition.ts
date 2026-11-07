import { flushSync } from "react-dom";

/** The callback is committed before the browser captures the new screen. */
export const transitionDesktop = (update: () => void) => {
  if (
    !document.startViewTransition ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  const transition = document.startViewTransition(() => flushSync(update));
  // A concurrent transition or a hidden document may skip animation, not state.
  void transition.ready.catch(() => undefined);
};
