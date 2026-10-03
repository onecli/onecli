"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import type { PendingApproval } from "@/lib/api/approvals";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/** Pretty-print a JSON body; anything else is shown exactly as sent. A
 *  truncated body is never re-formatted (it would not parse anyway). */
export const formatRawBody = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/**
 * The request as the agent sent it, method + URL and the body, so the
 * readable summary can be checked against what will go out. Headers are
 * deliberately left out (they can carry the agent's own tokens); secret-named
 * body fields arrive masked by the gateway. The body renders as text only.
 */
export const ApprovalRawRequest = ({
  approval,
}: {
  approval: PendingApproval;
}) => {
  const { copied, copy } = useCopyToClipboard();
  const raw = approval.rawBody;
  const requestLine = `${approval.method} ${approval.url}`;
  const body = raw && !raw.binary ? formatRawBody(raw.text) : "";
  const copyText = body ? `${requestLine}\n\n${body}` : requestLine;

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">Raw request</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => copy(copyText)}
          className="text-muted-foreground hover:text-foreground -me-2"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="bg-muted mt-1 max-h-[55vh] overflow-auto rounded-md p-3 font-mono text-xs">
        <p className="break-all">{requestLine}</p>
        {raw?.binary ? (
          <p className="text-muted-foreground mt-2 font-sans">
            Binary body, not shown.
          </p>
        ) : body ? (
          <pre className="mt-2 break-words whitespace-pre-wrap">{body}</pre>
        ) : (
          <p className="text-muted-foreground mt-2 font-sans">No body.</p>
        )}
        {raw?.truncated && (
          <p className="text-muted-foreground mt-2 font-sans">
            Truncated: the body is longer than what is shown.
          </p>
        )}
        {raw?.redacted && (
          <p className="text-muted-foreground mt-2 font-sans">
            Secret fields are shown as ***. They are sent as written.
          </p>
        )}
      </div>
    </div>
  );
};
