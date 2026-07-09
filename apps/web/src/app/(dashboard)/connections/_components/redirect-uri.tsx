"use client";

import { Check, Copy } from "lucide-react";
import Link from "next/link";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { API_ORIGIN } from "@/lib/api-fetch";
import { APP_URL, IS_CLOUD } from "@/lib/env";

const useBaseUrl = () => {
  if (IS_CLOUD) return API_ORIGIN || APP_URL;
  // Self-hosted: prefer an explicitly configured public URL (matches the server's
  // redirect_uri); otherwise fall back to the current origin.
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  return typeof window !== "undefined" ? window.location.origin : APP_URL;
};

export const RedirectUri = ({ provider }: { provider: string }) => {
  const redirectUri = `${useBaseUrl()}/v1/apps/${provider}/callback`;
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline gap-2">
        <p
          className={
            IS_CLOUD
              ? "text-xs font-medium text-muted-foreground"
              : "text-sm font-medium"
          }
        >
          Redirect URI
        </p>
        {!IS_CLOUD && (
          <Link
            href="/settings/instance"
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            Configure base URL
          </Link>
        )}
      </div>
      <div
        className={`flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 ${IS_CLOUD ? "bg-muted/50" : "border"}`}
      >
        <code
          className={`min-w-0 flex-1 truncate font-mono text-xs select-all ${IS_CLOUD ? "text-muted-foreground" : "text-foreground"}`}
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
      <p
        className={
          IS_CLOUD
            ? "text-[11px] text-muted-foreground/70"
            : "text-xs text-muted-foreground"
        }
      >
        Add this to your OAuth app&apos;s allowed redirect URIs.
      </p>
    </div>
  );
};
