"use client";

import { Check, Copy } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { cn } from "@onecli/ui/lib/utils";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { MessageTime, REVEAL_ON_HOVER } from "./message-time";

/**
 * What you can do with a finished answer, in one quiet line under it: copy
 * it (the raw markdown, so it pastes with its formatting) and, beside the
 * button, when it was sent.
 *
 * Only ever under a FINAL answer: never under a draft, the lead, an
 * `[no reply]` or an error (AgentAnswer decides), and only once its last
 * word is on screen. Like the time under the person's own messages, it
 * shows only while the answer is hovered or holds focus, with a short fade
 * (REVEAL_ON_HOVER), so the thread reads as text, not controls. Always
 * shown on touch, where there is no hover.
 *
 * The time is the viewer's local time (MessageTime), from the turn's finish.
 */
export const AnswerActions = ({
  text,
  at,
}: {
  /** The answer as the agent wrote it (markdown). */
  text: string;
  /** When the answer was sent (ISO): the turn's finish time. */
  at?: string | null;
}) => {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div
      data-slot="answer-actions"
      className={cn(
        "text-muted-foreground -ms-1.5 -mt-1 flex h-7 items-center gap-1.5",
        REVEAL_ON_HOVER,
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void copy(text)}
            aria-label={copied ? "Copied" : "Copy reply"}
            className={cn(
              // Quiet until you reach for it: a soft icon that firms up on
              // hover or focus, and stays firm while it says "copied".
              "text-muted-foreground/70 hover:bg-muted hover:text-foreground focus-visible:text-foreground focus-visible:ring-ring/50 inline-flex size-7 items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-[3px]",
              copied && "text-foreground",
            )}
          >
            {copied ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <Copy className="size-3.5" aria-hidden />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
      </Tooltip>
      {/* Said once the copy happened: the label change alone is not
          announced while focus stays on the button. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
      {at && <MessageTime at={at} />}
    </div>
  );
};
