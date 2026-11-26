"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { LucideIcon } from "lucide-react";
import { playLoop, type IconLoop } from "./nav-icon-loop";
import { navIconLoop } from "./nav-icon-loops";

/** How long the pointer must rest on a row before its icon plays: a flick
 *  down the sidebar passes every row sooner, so it animates nothing. */
export const HOVER_INTENT_MS = 150;

/** A loop at least this far through may start over on the next hover. */
export const REPLAY_FROM = 0.9;

/** How fast a reversible loop runs back once the pointer leaves. */
export const REWIND_RATE = 1.8;

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How far through `loop` its animations are, 0 to 1 (1 once finished). */
const progressOf = (anims: readonly Animation[], loop: IconLoop) => {
  const lead = anims[0];
  if (!lead || lead.playState === "finished") return 1;
  return Number(lead.currentTime ?? 0) / loop.duration;
};

/** What a row wires up for its icon's loop. */
export interface NavIconHover {
  loop: IconLoop;
  /** For the icon's `<svg>`. */
  svgRef: RefObject<SVGSVGElement | null>;
  /** For the row: the whole row is the hover target, as in Resend. */
  rowProps: { onMouseEnter: () => void; onMouseLeave: () => void };
}

/**
 * A sidebar row's icon loop, played the way Resend's sidebar plays it:
 *
 * - The whole row is the target. Resting on it for {@link HOVER_INTENT_MS}
 *   plays the icon's loop once; leaving sooner plays nothing.
 * - A loop that has started always finishes, wherever the pointer goes, and
 *   hovering again mid-loop does not restart it. Only an icon at rest, or
 *   {@link REPLAY_FROM} of the way through, plays again.
 * - A reversible loop (the gear) instead plays from the first moment of the
 *   hover and runs back at {@link REWIND_RATE}x when the pointer leaves.
 * - With reduced motion asked for, nothing plays.
 *
 * Returns the props for the row (`onMouseEnter`, `onMouseLeave`) and the
 * ref for the icon's `<svg>`, or nothing to wire for an icon with no loop.
 */
export const useNavIconLoop = (icon: LucideIcon): NavIconHover | undefined => {
  const loop = navIconLoop(icon);
  const svgRef = useRef<SVGSVGElement>(null);
  const anims = useRef<Animation[]>([]);
  const intent = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stop = useCallback(() => {
    clearTimeout(intent.current);
    intent.current = undefined;
    for (const a of anims.current) a.cancel();
    anims.current = [];
  }, []);

  // A row that unmounts (or swaps its icon) mid-loop leaves nothing running.
  useEffect(() => stop, [loop, stop]);

  const play = useCallback(() => {
    const svg = svgRef.current;
    if (!svg || !loop) return;
    for (const a of anims.current) a.cancel();
    anims.current = playLoop(svg, loop);
  }, [loop]);

  const onMouseEnter = useCallback(() => {
    if (!loop || prefersReducedMotion()) return;
    if (loop.reversible) {
      if (anims.current.length === 0) return play();
      for (const a of anims.current) {
        a.updatePlaybackRate(1);
        a.play();
      }
      return;
    }
    const idle = anims.current.length === 0;
    if (!idle && progressOf(anims.current, loop) < REPLAY_FROM) return;
    clearTimeout(intent.current);
    intent.current = setTimeout(play, HOVER_INTENT_MS);
  }, [loop, play]);

  const onMouseLeave = useCallback(() => {
    clearTimeout(intent.current);
    intent.current = undefined;
    if (!loop?.reversible || prefersReducedMotion()) return;
    for (const a of anims.current) {
      a.updatePlaybackRate(-REWIND_RATE);
      a.play();
    }
  }, [loop]);

  return loop
    ? { loop, svgRef, rowProps: { onMouseEnter, onMouseLeave } }
    : undefined;
};
