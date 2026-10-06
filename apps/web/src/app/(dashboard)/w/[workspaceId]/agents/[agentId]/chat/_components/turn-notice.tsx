"use client";

import Link from "next/link";
import { ChevronRight, Info } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";

/**
 * A turn that failed for a reason the copy itself resolves — either a gap the
 * reader can fix (no model key yet, with the fix a click away) or a transient
 * platform hiccup (a restart, a start that could not happen) whose sentence
 * already says what to do next.
 *
 * Deliberately NOT the destructive red treatment the ordinary error line uses.
 * Nothing is broken here — an unconnected key is a normal state on a new
 * agent (§3.18: configuration never blocks conversation), and a lifecycle
 * hiccup is a moment, not a verdict about the agent. Guidance, not a crash.
 *
 * The action is a button/link rather than prose because prose cannot be
 * clicked, and matching on the message text to decide whether to render one
 * is exactly what `Turn.errorCode` exists to avoid. The two arms are a
 * union, not optional fields, so a label with nothing behind it cannot
 * compile: an action either navigates (`href`) or fixes the gap IN PLACE
 * (`onClick`, a dialog over the chat that keeps the conversation — the thing
 * the user came for — on screen).
 *
 * `details` is the raw error text the message REPLACED, folded away under
 * "Technical details": it answers a debugging question, not the reader's,
 * but dropping it would leave whoever operates the agent nothing to report.
 * It sits OUTSIDE the status region on purpose: expanding it would otherwise
 * read the whole payload aloud as a live update.
 * SECURITY: it is untrusted text (a provider's response body, relayed by the
 * sandbox) and renders as a text node only, never as markup.
 */
export const TurnNotice = ({
  message,
  action,
  details,
}: {
  message: string;
  action?:
    | { label: string; href: string }
    | { label: string; onClick: () => void };
  details?: string;
}) => (
  <div className="bg-muted/50 flex flex-col gap-2 rounded-md px-3 py-2.5">
    <div role="status" className="flex flex-col gap-2">
      <p className="text-muted-foreground flex items-start gap-2 text-xs">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">{message}</span>
      </p>
      {action &&
        ("onClick" in action ? (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline" className="self-start">
            <Link href={action.href}>{action.label}</Link>
          </Button>
        ))}
    </div>
    {details && (
      <Collapsible>
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 group flex w-fit items-center gap-1 rounded-sm text-xs transition-colors outline-none focus-visible:ring-[3px]">
          <ChevronRight
            className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          Technical details
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre
            translate="no"
            className="bg-background text-muted-foreground mt-1.5 max-h-48 overflow-auto rounded-md p-2 font-mono text-xs break-all whitespace-pre-wrap"
          >
            {details}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    )}
  </div>
);
