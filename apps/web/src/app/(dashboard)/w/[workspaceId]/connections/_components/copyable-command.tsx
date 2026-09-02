"use client";

import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

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
}: {
  command: string;
  /** The success toast — the "now do this" follow-up after copying. */
  toastMessage: string;
}) => {
  const { copy } = useCopyToClipboard();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Copy ${command}`}
          // Rests LIGHTER than an inert code chip and strengthens on hover
          // (the attachment-chips idiom) — fill, not fade, marks interactive.
          className="bg-muted/60 hover:bg-muted rounded px-1 py-0.5 font-mono text-[11px] transition-colors"
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
      <TooltipContent>Copy command</TooltipContent>
    </Tooltip>
  );
};
