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

export const PublicUrlCard = ({ appUrl }: { appUrl: string }) => {
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
            className="text-muted-foreground hover:text-foreground shrink-0 rounded-md border p-2 transition-colors"
          >
            {copied ? (
              <Check className="text-brand size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </button>
        </div>
        <p className="text-muted-foreground text-xs">
          Configure via the{" "}
          <code className="bg-muted rounded px-1 py-0.5 text-[11px]">
            APP_URL
          </code>{" "}
          environment variable.{" "}
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
