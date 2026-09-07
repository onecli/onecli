"use client";

/**
 * The live activity line — what the agent is doing right now, while it works.
 *
 * Replaces the old bare "Thinking…" pulse with the agent's own words
 * ("Architecting the narrative arc") or a phrase for the tool it just
 * started ("Running a command").
 *
 * DESIGNED TO READ AS TRANSIENT (user feedback, 2026-08-31: the first cut
 * looked like ordinary content). Three cues say "this text is not staying",
 * and they are deliberately redundant so the meaning survives when any one
 * of them is unavailable:
 *
 *  - WEIGHT: dimmer than body copy (`/60`) and one step smaller, so it sits
 *    visually below the answer that replaces it rather than beside it.
 *  - MOTION: a slow shimmer across the text — the "in progress" idiom, and
 *    the thing a static screenshot cannot fake. Disabled wholesale under
 *    `prefers-reduced-motion`, where the dimming alone carries the meaning.
 *  - SHAPE: italic, which nothing else in the transcript uses, so the line
 *    is distinguishable from the agent's actual prose even in grayscale or
 *    at a glance.
 *
 * SECURITY: `text` is model output from a sandbox that reads the open
 * internet, so it is untrusted. It arrives already bounded, single-line and
 * control-stripped (`activityForReasoning`), and it is rendered as TEXT here
 * — never markdown, never a link. Do not "improve" this by passing it
 * through the markdown renderer.
 */
export const ActivityLine = ({ text }: { text: string }) => (
  <p
    className="text-muted-foreground/60 flex items-center gap-2 text-xs italic"
    // Polite: a caption that changes every few seconds must never interrupt
    // a screen-reader user mid-sentence.
    aria-live="polite"
  >
    <span
      aria-hidden
      className="bg-muted-foreground/40 size-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none"
    />
    {/* The shimmer rides a background gradient over the glyphs themselves
        (`bg-clip-text` + transparent fill), so it needs no overlay element
        and cannot desynchronize from the text it describes. `animate-shimmer`
        resolves through the `--animate-shimmer` theme token in
        packages/ui/src/styles/globals.css — it must stay a Tailwind theme
        token (never a hand-written CSS class) or the `motion-safe:` variant
        silently compiles to nothing and the gradient freezes
        (activity-shimmer.test.ts pins this). Under reduced motion the
        animation stops AND the normal color is restored — a frozen gradient
        would leave the line unevenly tinted. */}
    <span className="from-muted-foreground/40 via-muted-foreground to-muted-foreground/40 motion-safe:animate-shimmer min-w-0 truncate bg-gradient-to-r bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:bg-none motion-reduce:text-inherit">
      {text}
    </span>
  </p>
);
