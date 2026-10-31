"use client";

import { Check, Copy, Database } from "lucide-react";
import { toast } from "sonner";
import {
  databaseConnectionUrl,
  extractDatabaseTarget,
  shortDatabaseServer,
} from "@onecli/api/lib/connection-display";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/**
 * Where a database connection points, short enough to read at a glance:
 * `orders · orders-prod` (database, then the server's first name). The full
 * connection string (no password) is one click away to copy, and in the
 * tooltip. Nothing for a connection saved before the target was recorded.
 */
export const DatabaseTargetLine = ({ metadata }: { metadata: unknown }) => {
  const { copied, copy } = useCopyToClipboard(1500);
  const target = extractDatabaseTarget(metadata);
  if (!target) return null;
  const url = databaseConnectionUrl(target);
  return (
    <p
      title={url}
      className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs"
    >
      <Database className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate" translate="no">
        <span className="font-mono">{target.database}</span>
        <span aria-hidden="true"> · </span>
        <span className="font-mono">{shortDatabaseServer(target)}</span>
      </span>
      <button
        type="button"
        onClick={() =>
          void copy(url).then((ok) => {
            if (!ok) toast.error("Couldn't copy the connection string");
          })
        }
        aria-label="Copy connection string"
        className="hover:text-foreground focus-visible:ring-ring ml-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-sm focus-visible:ring-2 focus-visible:outline-none"
      >
        {copied ? (
          <Check className="size-3" aria-hidden="true" />
        ) : (
          <Copy className="size-3" aria-hidden="true" />
        )}
      </button>
    </p>
  );
};
