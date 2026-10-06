"use client";

import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { inlineLinkClassName } from "./inline-link";

/**
 * An inline, copyable command inside helper text: the visible text IS what
 * lands on the clipboard, so the affordance can never drift from what it
 * copies. The click copies through the house hook (which carries the
 * plain-HTTP self-host fallback); the success toast delivers the follow-up
 * instruction — gated on the copy actually happening — and a failed copy
 * says so (never a false success, never silence). The tooltip says what
 * clicking does *before* the click; a native `title` would be invisible to
 * touch and keyboard users.
 */
export const CopyableCommand = ({
  command,
  toastMessage,
  tooltip = "Copy command",
  variant = "chip",
}: {
  command: string;
  /** The success toast — the "now do this" follow-up after copying. */
  toastMessage: string;
  /** What hovering explains before the click. */
  tooltip?: string;
  /** `chip` is the mono code pill; `link` matches adjacent inline links. */
  variant?: "chip" | "link";
}) => {
  const { copy } = useCopyToClipboard();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Copy ${command}`}
          translate="no"
          // `chip` rests LIGHTER than an inert code chip and strengthens on
          // hover (the attachment-chips idiom): fill, not fade, marks it
          // interactive. `link` wears the exact class of the sibling anchors
          // (rest, hover, and focus) so a command offered as a peer of a link
          // reads as one.
          className={
            variant === "link"
              ? inlineLinkClassName
              : "bg-muted/60 hover:bg-muted rounded px-1 py-0.5 font-mono text-[11px] transition-colors"
          }
          onClick={() => {
            void copy(command).then((copied) => {
              if (copied) toast.success(toastMessage);
              else toast.error("Couldn't copy to clipboard");
            });
          }}
        >
          {command}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
    </Tooltip>
  );
};
