"use client";

import { Bubble, BubbleContent } from "@onecli/ui/components/bubble";
import { ChatMarkdown } from "./chat-markdown";
import { ConnectorSuggestions } from "./connect-suggestions";

/**
 * The agent's own words, settled: its answer to a turn, or its reply to a
 * message sent while it worked. Rendered as markdown with connect links
 * lifted into the card below (one unmissable call to action instead of a
 * prose link).
 *
 * The answer is the ONLY markdown surface for model text: narration and
 * activity stay plain (see `NarrationText`). The text is untrusted model
 * output, and `ChatMarkdown` never parses raw HTML in it.
 */
export const AgentAnswer = ({ text }: { text: string }) => (
  <>
    {/* The promotion moment: the transient log unmounts and the answer fades
        in over it. Motion says "this is the keeper", and reduced-motion
        readers just see the swap. */}
    <Bubble
      variant="ghost"
      className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
    >
      <BubbleContent>
        <ChatMarkdown text={text} suppressConnectLinks />
      </BubbleContent>
    </Bubble>
    {/* Reads the ANSWER only, never the streamed narration, which is
        untrusted progress text. */}
    <ConnectorSuggestions text={text} />
  </>
);
