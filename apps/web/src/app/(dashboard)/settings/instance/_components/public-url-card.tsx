"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export interface PublicUrlCardProps {
  appUrl: string;
  /** No APP_URL configured — `appUrl` came from the current request. */
  autoDetected?: boolean;
}

export const PublicUrlCard = ({ appUrl, autoDetected }: PublicUrlCardProps) => {
  const { copied, copy } = useCopyToClipboard();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Public URL</CardTitle>
        <CardDescription>
          The base URL used for OAuth redirect callbacks. Set this to your
          public IP or tunnel URL if you&apos;re running behind a reverse proxy
          or tunnel.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-md border px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-sm">
              {appUrl}
            </code>
          </div>
          <button
            type="button"
            onClick={() => copy(appUrl)}
            aria-label={copied ? "Public URL copied" : "Copy public URL"}
            className="text-muted-foreground hover:text-foreground shrink-0 rounded-md border p-2 transition-colors"
          >
            {copied ? (
              <Check className="text-brand size-4" aria-hidden />
            ) : (
              <Copy className="size-4" aria-hidden />
            )}
          </button>
        </div>
        <p className="text-muted-foreground text-xs">
          {autoDetected ? (
            <>
              Auto-detected from the address you&apos;re on. Set the{" "}
              <code className="bg-muted rounded px-1 py-0.5 text-[11px]">
                APP_URL
              </code>{" "}
              environment variable to pin it.{" "}
            </>
          ) : (
            <>
              Configured via the{" "}
              <code className="bg-muted rounded px-1 py-0.5 text-[11px]">
                APP_URL
              </code>{" "}
              environment variable.{" "}
            </>
          )}
          <a
            href="https://onecli.sh/docs/quickstart"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground inline-flex items-center gap-1 underline underline-offset-2 transition-colors hover:opacity-70"
          >
            Learn more
            <ExternalLink className="size-3" />
          </a>
        </p>
      </CardContent>
    </Card>
  );
};
