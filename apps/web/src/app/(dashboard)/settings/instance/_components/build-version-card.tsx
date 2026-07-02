"use client";

import { Check, Copy } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { APP_VERSION } from "@/lib/env";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export const BuildVersionCard = () => {
  const { copied, copy } = useCopyToClipboard();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Build version</CardTitle>
        <CardDescription>
          The OneCLI version this instance is running. Include it when reporting
          issues so behavior can be matched to a release.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-md border px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-sm">
              v{APP_VERSION}
            </code>
          </div>
          <button
            type="button"
            onClick={() => copy(APP_VERSION)}
            aria-label="Copy version"
            title="Copy version"
            className="text-muted-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 shrink-0 rounded-md border p-2 outline-none transition-colors focus-visible:ring-[3px] motion-reduce:transition-none"
          >
            {copied ? (
              <Check className="text-brand size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </button>
        </div>
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? "Version copied to clipboard" : ""}
        </span>
      </CardContent>
    </Card>
  );
};
