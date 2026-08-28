"use client";

import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { API_ORIGIN } from "@/lib/api-fetch";
import { IS_CLOUD } from "@/lib/env";

// The OAuth callback is served by the api-server in every edition, so the
// displayed redirect URI must be its origin (the server computes its own
// redirect_uri from the same API URL). API_ORIGIN is never falsy (it bottoms
// out at the resolver default), so it needs no fallback.
const useBaseUrl = () => API_ORIGIN;

// One typography decision: on cloud the URI is quiet, secondary metadata (the
// platform's own OAuth apps usually apply); self-hosted it's a primary setup
// field the admin must copy into their OAuth app.
const styles = IS_CLOUD
  ? {
      label: "text-xs font-medium text-muted-foreground",
      box: "bg-muted/50",
      code: "text-muted-foreground",
      hint: "text-[11px] text-muted-foreground/70",
    }
  : {
      label: "text-sm font-medium",
      box: "border",
      code: "text-foreground",
      hint: "text-xs text-muted-foreground",
    };

export const RedirectUri = ({ provider }: { provider: string }) => {
  const redirectUri = `${useBaseUrl()}/v1/apps/${provider}/callback`;
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline gap-2">
        <p className={styles.label}>Redirect URI</p>
      </div>
      <div
        className={`flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 ${styles.box}`}
      >
        <code
          className={`min-w-0 flex-1 truncate font-mono text-xs select-all ${styles.code}`}
        >
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
      <p className={styles.hint}>
        Add this to your OAuth app&apos;s allowed redirect URIs.
      </p>
    </div>
  );
};
