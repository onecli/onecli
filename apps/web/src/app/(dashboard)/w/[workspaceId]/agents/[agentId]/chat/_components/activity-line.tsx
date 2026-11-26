"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@onecli/ui/lib/utils";

/**
 * The caption before the agent reports any activity of its own, from the
 * moment of send. ONE word for every lifecycle state, deliberately: a turn
 * still `queued` or `dispatched` is a machine waking up, and telling the
 * person so made the agent read as asleep. The lifecycle still rides the
 * line as `data-turn-status`, for support, never as copy.
 */
export const WAITING_COPY = "Thinking…";

/**
 * How long a caption stays before the next may replace it. Reasoning can
 * produce a new whole thought every few hundred milliseconds; a caption
 * that changes faster than it can be read is flicker, not information.
 */
export const CAPTION_HOLD_MS = 1_500;

/**
 * The caption on screen: `text`, but never replaced sooner than
 * CAPTION_HOLD_MS after the last change. A newer text that arrives during
 * the hold waits; only the latest one is kept, so a burst of thoughts lands
 * as the last of them, never as a queue to wade through.
 */
const useHeldCaption = (text: string): string => {
  const [shown, setShown] = useState(text);
  const shownAt = useRef(0);
  useEffect(() => {
    if (text === shown) return;
    const wait = Math.max(0, shownAt.current + CAPTION_HOLD_MS - Date.now());
    const timer = setTimeout(() => {
      shownAt.current = Date.now();
      setShown(text);
    }, wait);
    return () => clearTimeout(timer);
  }, [text, shown]);
  return shown;
};

/**
 * The live activity line — what the agent is doing right now, while it works.
 *
 * The agent's own words ("Structuring the report") or a phrase for the tool
 * it just started ("Running a command"), and "Thinking…" before either.
 * Always a whole thought: the caption is derived from the accumulated
 * reasoning (`activityForReasoningStream`), never from a single network
 * batch, and a new caption waits until the current one has been on screen
 * long enough to read, then crossfades in.
 *
 * DESIGNED TO READ AS TRANSIENT, quietly: one line, a step smaller and
 * dimmer than the reply, with a slow shimmer across the glyphs (the
 * in-progress idiom a static screenshot cannot fake). No italic and no dot:
 * the shimmer carries "working", and a second or third cue read as noise.
 * Under `prefers-reduced-motion` the shimmer and the crossfade stop and the
 * dimming alone carries the meaning.
 *
 * SECURITY: `text` is model output from a sandbox that reads the open
 * internet, so it is untrusted. It arrives already bounded, single-line and
 * control-stripped (`activityForReasoningStream`), and it is rendered as
 * TEXT here, never markdown, never a link. Do not "improve" this by passing
 * it through the markdown renderer.
 */
export const ActivityLine = ({
  text,
  visuallyHidden = false,
  turnStatus,
}: {
  text: string;
  /** Announce without showing: for when the same words are already on
   *  screen elsewhere (the run header), so sighted readers don't see them
   *  twice while screen-reader users keep the live cue. */
  visuallyHidden?: boolean;
  /** The turn's lifecycle state behind the caption (`queued`: the machine
   *  is waking; `running`: the agent is at work). Never copy: the person
   *  sees one word either way. A DOM attribute for support and tests. */
  turnStatus?: string;
}) => {
  const shown = useHeldCaption(text);
  // The caption it mounted with appears as-is: the send's "Thinking…" hands
  // over to the turn's own line, and fading the same word in again there
  // would read as a flicker. Only a CHANGE crossfades.
  const [mountedWith] = useState(text);
  const fade = shown !== mountedWith;
  return (
    <p
      className={cn(
        "text-muted-foreground/70 flex h-6 min-w-0 items-center text-[0.8125rem]",
        visuallyHidden && "sr-only",
      )}
      // Polite: a caption that changes every few seconds must never interrupt
      // a screen-reader user mid-sentence.
      aria-live="polite"
      data-turn-status={turnStatus}
    >
      {/* Keyed by the caption: each new one mounts and fades in, so a change
          reads as one soft crossfade rather than letters swapping. The fade
          sits on its own wrapper: two `animation` utilities on one element
          would override each other and freeze the shimmer.

          The shimmer rides a background gradient over the glyphs themselves
          (`bg-clip-text` + transparent fill), so it needs no overlay element
          and cannot desynchronize from the text it describes. `animate-shimmer`
          resolves through the `--animate-shimmer` theme token in
          packages/ui/src/styles/globals.css; it must stay a Tailwind theme
          token (never a hand-written CSS class) or the `motion-safe:` variant
          silently compiles to nothing and the gradient freezes
          (activity-shimmer.test.ts pins this). Under reduced motion the
          animation stops AND the normal color is restored: a frozen gradient
          would leave the line unevenly tinted. */}
      <span
        key={shown}
        className={cn(
          "flex min-w-0",
          fade &&
            "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300",
        )}
      >
        <span className="from-muted-foreground/40 via-muted-foreground to-muted-foreground/40 motion-safe:animate-shimmer min-w-0 truncate bg-gradient-to-r bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:bg-none motion-reduce:text-inherit">
          {shown}
        </span>
      </span>
    </p>
  );
};
