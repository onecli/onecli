"use client";

/**
 * One narration segment of the live work log — what the agent SAID between
 * tool calls while the turn still runs ("Let me check the logs.").
 *
 * DESIGNED TO READ AS TRANSIENT, like the ActivityLine beside it: muted and
 * a step smaller than answer prose, so the log sits visually below the
 * answer that replaces it. NOT italic — that is the ActivityLine's one-line
 * idiom, and paragraphs of italic stop reading as a cue and start reading
 * as noise.
 *
 * The `live` variant marks the segment still streaming: a pulsing cursor
 * glyph, the one idiom a static wall of text cannot fake. Pulse only — the
 * text itself never shimmers (it is prose to read, not a caption), and the
 * cursor stops under `prefers-reduced-motion`.
 *
 * SECURITY: `text` is UNTRUSTED model output from a sandbox that reads the
 * open internet. It renders as TEXT inside a <p> — never markdown, never a
 * link, never `dangerouslySetInnerHTML`. The markdown surface is the final
 * answer only (ChatMarkdown, with its own no-raw-HTML posture). Do not
 * "improve" this by rendering the log through the markdown pipeline.
 */
export const NarrationText = ({
  text,
  live = false,
}: {
  text: string;
  live?: boolean;
}) => (
  <p className="text-muted-foreground/80 text-[0.8125rem] leading-relaxed break-words whitespace-pre-wrap">
    {text}
    {live && (
      <span
        aria-hidden
        className="bg-muted-foreground/60 ms-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] animate-pulse rounded-full motion-reduce:animate-none"
      />
    )}
  </p>
);
