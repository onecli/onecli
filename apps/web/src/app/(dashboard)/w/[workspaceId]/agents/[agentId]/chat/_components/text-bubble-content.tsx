"use client";

import { BubbleContent } from "@onecli/ui/components/bubble";
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
export const TextBubbleContent = ({ text }: { text: string }) => (
  <BubbleContent
    dir={messageDirection(text)}
    className="text-sm break-words whitespace-pre-wrap"
  >
    {text}
  </BubbleContent>
);
