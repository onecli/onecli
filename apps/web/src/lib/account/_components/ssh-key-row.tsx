"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { formatRelative } from "@onecli/api/lib/format";
import type { SshKey } from "@/lib/api";

/** One registered key: name over fingerprint + lifecycle metadata, delete. */
export const SshKeyRow = ({
  sshKey,
  onDelete,
}: {
  sshKey: SshKey;
  onDelete: () => void;
}) => (
  <div className="flex items-center justify-between gap-3 px-4 py-3">
    <div className="min-w-0">
      <p className="truncate text-sm font-medium">{sshKey.name}</p>
      <p className="text-muted-foreground truncate text-xs">
        <span className="font-mono">{sshKey.fingerprint}</span> · Added{" "}
        {new Date(sshKey.createdAt).toLocaleDateString()} ·{" "}
        {sshKey.lastUsedAt
          ? `Last used ${formatRelative(sshKey.lastUsedAt)}`
          : "Never used"}
      </p>
    </div>
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground hover:text-destructive size-7 shrink-0"
      aria-label={`Delete key ${sshKey.name}`}
      onClick={onDelete}
    >
      <Trash2 className="size-3.5" />
    </Button>
  </div>
);
