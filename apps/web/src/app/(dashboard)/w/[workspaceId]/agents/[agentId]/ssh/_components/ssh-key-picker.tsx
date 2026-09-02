"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@onecli/ui/components/button";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { ApiError } from "@/lib/api";
import type { SshKey } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { useMintSshCertificate } from "@/hooks/use-agents";

/**
 * Refusals are STATES rendered inline off `ApiError.status`, never toasts.
 * A 404 has three server-side causes (key deleted, agent deleted, CA gone
 * mid-session), so the copy claims only what is certain across all three.
 */
const mintErrorCopy = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return "That key or agent is no longer available. Pick another key or refresh.";
    }
    if (error.status === 429) {
      return "Too many certificates minted. Wait a bit and try again.";
    }
  }
  return "Couldn't mint a certificate. It may be a hiccup; try again.";
};

/** Pick a registered key, mint with one click. */
export const SshKeyPicker = ({
  agentId,
  keys,
  mint,
}: {
  agentId: string;
  keys: SshKey[];
  mint: ReturnType<typeof useMintSshCertificate>;
}) => {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // Deleting the selected key must not strand the picker on a dead id.
  const selected = keys.find((k) => k.id === selectedId) ?? keys[0];

  return (
    <div className="space-y-2">
      <Label htmlFor="ssh-key-picker">Your SSH key</Label>
      <div className="flex items-center gap-2">
        <Select value={selected?.id} onValueChange={setSelectedId}>
          <SelectTrigger id="ssh-key-picker" size="sm" className="max-w-xs">
            <SelectValue placeholder="Select a key" />
          </SelectTrigger>
          <SelectContent>
            {keys.map((key) => (
              <SelectItem key={key.id} value={key.id}>
                {key.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          loading={mint.isPending}
          disabled={!selected}
          onClick={() => {
            if (!selected) return;
            mint.mutate(
              { agentId, sshKeyId: selected.id },
              {
                // A 404 means something in the list is stale (the copy says
                // "pick another key") — refetch so the dead row actually
                // drops out and `selected` re-derives to a live key.
                onError: (err) => {
                  if (err instanceof ApiError && err.status === 404) {
                    void qc.invalidateQueries({
                      queryKey: queryKeys.sshKeys.all(),
                    });
                  }
                },
              },
            );
          }}
        >
          {mint.isPending ? "Minting…" : "Mint certificate"}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Certificates are short-lived; mint one per session.{" "}
        <Link
          href="/account/ssh-keys"
          className="hover:text-foreground underline underline-offset-2"
        >
          Manage keys
        </Link>
      </p>
      {mint.isError && (
        <p role="alert" className="text-destructive text-sm">
          {mintErrorCopy(mint.error)}
        </p>
      )}
    </div>
  );
};
