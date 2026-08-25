"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { Button } from "@onecli/ui/components/button";

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
 */
export const TurnNotice = ({
  message,
  action,
}: {
  message: string;
  action?:
    | { label: string; href: string }
    | { label: string; onClick: () => void };
}) => (
  <div
    role="status"
    className="bg-muted/50 flex flex-col gap-2 rounded-md px-3 py-2.5"
  >
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
);
