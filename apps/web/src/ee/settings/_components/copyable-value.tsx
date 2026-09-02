"use client";

import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/**
 * A truncating monospace value with an inline copy button — the config-row
 * primitive shared by the DNS TXT record and the SSO IdP instructions. Owns
 * its own copied state, so each instance flips independently.
 */
export const CopyableValue = ({
  value,
  copyLabel,
}: {
  value: string;
  copyLabel: string;
}) => {
  const { copied, copy } = useCopyToClipboard();

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <code className="truncate font-mono select-all">{value}</code>
      <button
        type="button"
        onClick={() => copy(value)}
        aria-label={copyLabel}
        className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
      >
        {copied ? (
          <Check className="text-brand size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </span>
  );
};
