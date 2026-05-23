"use client";

import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { API_ORIGIN } from "@/lib/api-fetch";
import { APP_URL } from "@/lib/env";

export const RedirectUri = ({ provider }: { provider: string }) => {
  const redirectUri = `${API_ORIGIN || APP_URL}/v1/apps/${provider}/callback`;
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="grid gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">Redirect URI</p>
      <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-md bg-muted/50 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground select-all">
          {redirectUri}
        </code>
        <button
          type="button"
          onClick={() => copy(redirectUri)}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? (
            <Check className="text-brand size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground/70">
        Add this to your OAuth app&apos;s allowed redirect URIs.
      </p>
    </div>
  );
};
