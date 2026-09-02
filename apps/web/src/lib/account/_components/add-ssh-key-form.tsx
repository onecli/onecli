"use client";

import { useState } from "react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Textarea } from "@onecli/ui/components/textarea";
import { ApiError } from "@/lib/api";
import type { SshKey } from "@/lib/api";
import { useCreateSshKey } from "@/hooks/use-ssh-keys";

/**
 * Register-a-key form, shared by the account SSH keys card and the agent SSH
 * page's first-run arm. Refusals are STATES rendered inline off
 * `ApiError.status` (the ssh-section convention), never toasts.
 */
const addKeyErrorCopy = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 422) {
      return "That doesn't look like an ed25519 key. Generate one with ssh-keygen -t ed25519, then paste the .pub file.";
    }
    // 409 is precise server copy: already registered, or the registry cap.
    if (error.status === 409) return error.message;
  }
  return "Couldn't add the key. It may be a hiccup; try again.";
};

export const AddSshKeyForm = ({
  onSuccess,
}: {
  onSuccess?: (key: SshKey) => void;
}) => {
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const create = useCreateSshKey();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !publicKey.trim()) return;
    create.mutate(
      { name: name.trim(), publicKey: publicKey.trim() },
      {
        onSuccess: (key) => {
          setName("");
          setPublicKey("");
          onSuccess?.(key);
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-2">
      <Label htmlFor="ssh-key-name">Name</Label>
      <Input
        id="ssh-key-name"
        placeholder="MacBook Pro"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="max-w-sm"
        // Matches the server cap, so the 422 arm below can only ever mean
        // "not an ed25519 key" — a long name must not read as a bad key.
        maxLength={100}
      />
      <Label htmlFor="ssh-key-public-key" className="mt-2">
        Public key
      </Label>
      <Textarea
        id="ssh-key-public-key"
        value={publicKey}
        onChange={(e) => setPublicKey(e.target.value)}
        placeholder="ssh-ed25519 AAAA… you@laptop"
        rows={3}
        spellCheck={false}
        autoComplete="off"
        className="font-mono text-xs"
      />
      <p className="text-muted-foreground text-xs">
        No key yet? Create one with{" "}
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
          ssh-keygen -t ed25519
        </code>{" "}
        and paste the output of{" "}
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
          cat ~/.ssh/id_ed25519.pub
        </code>
        .
      </p>
      {create.isError && (
        <p role="alert" className="text-destructive text-sm">
          {addKeyErrorCopy(create.error)}
        </p>
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          loading={create.isPending}
          disabled={name.trim().length === 0 || publicKey.trim().length === 0}
        >
          {create.isPending ? "Adding…" : "Add key"}
        </Button>
      </div>
    </form>
  );
};
