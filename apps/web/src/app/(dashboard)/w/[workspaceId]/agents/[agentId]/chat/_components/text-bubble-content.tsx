"use client";

import { BubbleContent } from "@onecli/ui/components/bubble";
import { cn } from "@onecli/ui/lib/utils";
import { messageDirection } from "@/lib/markdown/text-direction";

/**
 * A bubble that holds one PLAIN-TEXT message: what a person typed, or what
 * one agent said to another. Whitespace is kept as typed, and the bubble
 * reads in the language's direction (a Hebrew message starts on the right;
 * see text-direction.ts for why `dir="auto"` is not enough).
 *
 * Text only, never markdown: the markdown surface is the agent's answer
 * (ChatMarkdown, with its own no-raw-HTML posture).
 */
export const TextBubbleContent = ({
  text,
  className,
}: {
  text: string;
  className?: string;
}) => (
  <BubbleContent
    dir={messageDirection(text)}
    className={cn("text-sm break-words whitespace-pre-wrap", className)}
  >
    {text}
  </BubbleContent>
);
