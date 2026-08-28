"use client";

import { useState } from "react";
import { Check, CircleCheck, Copy, KeyRound, Lock, Trash2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card, CardContent } from "@onecli/ui/components/card";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { formatRelative } from "@onecli/api/lib/format";
import type { ScimToken } from "@/lib/api";
import { API_ORIGIN } from "@/lib/api-fetch";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useGroups } from "@/hooks/use-groups";
import {
  useScimTokens,
  useCreateScimToken,
  useRevokeScimToken,
} from "@/hooks/use-scim-tokens";
import { usePlanGate } from "@/lib/plan-gate";

/**
 * SCIM provisioning: the base URL + bearer tokens an IdP admin pastes into
 * Entra/Okta so the IdP creates, updates, and deactivates members
 * automatically. The token plaintext is shown exactly once, at generation.
 */
export const ScimCard = () => {
  const { data: tokens = [], isPending } = useScimTokens();
  const { data: groups = [] } = useGroups();
  const createMutation = useCreateScimToken();
  const revokeMutation = useRevokeScimToken();
  const planGate = usePlanGate();
  const urlCopy = useCopyToClipboard();
  const tokenCopy = useCopyToClipboard();

  const [generateOpen, setGenerateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ScimToken | null>(null);

  // The canonical base is the API host in every edition (SCIM is served by
  // the api-server).
  const scimBaseUrl = `${API_ORIGIN}/scim/v2`;

  const locked = planGate.isLocked("sso");
  const scimGroupCount = groups.filter((g) => g.source === "scim").length;
  const lastUsed = tokens
    .map((t) => t.lastUsedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);

  const handleGenerateClick = () => {
    if (planGate.guard("sso")) return;
    setGenerateOpen(true);
  };

  const handleGenerate = () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed, {
      onSuccess: (created) => setCreatedToken(created.token),
    });
  };

  const handleGenerateClose = (open: boolean) => {
    if (!open) {
      setLabel("");
      setCreatedToken(null);
    }
    setGenerateOpen(open);
  };

  return (
    <>
      <Card>
        <CardContent className="space-y-5">
          <div className="flex items-start justify-between gap-6">
            <div className="grid gap-1">
              <Label className="flex items-center gap-1.5">
                {locked && <Lock className="size-3.5" />}
                SCIM provisioning
              </Label>
              <p className="text-muted-foreground text-sm">
                Let your identity provider create, update, and deactivate
                members automatically. Paste the base URL and a token into your
                IdP&apos;s provisioning settings.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={handleGenerateClick}
            >
              Generate token
            </Button>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="scim-base-url">SCIM base URL</Label>
            <div className="bg-muted flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5">
              <code
                id="scim-base-url"
                className="min-w-0 truncate font-mono text-sm"
              >
                {scimBaseUrl}
              </code>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="Copy SCIM base URL"
                onClick={() => urlCopy.copy(scimBaseUrl)}
              >
                {urlCopy.copied ? (
                  <Check className="text-brand size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            </div>
          </div>

          {isPending ? (
            <p className="text-muted-foreground text-sm">Loading tokens...</p>
          ) : tokens.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-6 py-8 text-center">
              <KeyRound className="text-muted-foreground mb-1 size-5" />
              <p className="text-sm font-medium">No provisioning tokens yet</p>
              <p className="text-muted-foreground text-sm">
                Generate a token to connect your IdP.
              </p>
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {tokens.map((token) => (
                <div
                  key={token.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {token.label}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Added {new Date(token.createdAt).toLocaleDateString()} ·{" "}
                      {token.lastUsedAt
                        ? `Last used ${formatRelative(token.lastUsedAt)}`
                        : "Never used"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive size-7 shrink-0"
                    aria-label={`Revoke token ${token.label}`}
                    onClick={() => setRevokeTarget(token)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {scimGroupCount > 0 && (
            <p className="text-muted-foreground text-xs">
              {scimGroupCount} {scimGroupCount === 1 ? "group" : "groups"}{" "}
              synced from your IdP
              {lastUsed ? ` · Last change ${formatRelative(lastUsed)}` : ""}
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={generateOpen} onOpenChange={handleGenerateClose}>
        <DialogContent>
          {createdToken ? (
            <>
              <div className="flex flex-col items-center pt-2 text-center">
                <div className="bg-brand/10 mb-3 flex size-10 items-center justify-center rounded-full">
                  <CircleCheck className="text-brand size-5" />
                </div>
                <DialogHeader className="items-center">
                  <DialogTitle>Token created</DialogTitle>
                  <DialogDescription>
                    Paste it into your IdP now. You won&apos;t be able to see it
                    again.
                  </DialogDescription>
                </DialogHeader>
              </div>
              {/* min-w-0: DialogContent is a grid, and grid items default to
                  min-width:auto — the unbreakable token would otherwise set
                  this item's min-content width and overflow the dialog. */}
              <div className="min-w-0 py-2">
                <div className="bg-muted flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
                  <code className="min-w-0 truncate font-mono text-sm font-medium select-all">
                    {createdToken}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label="Copy SCIM token"
                    onClick={() => tokenCopy.copy(createdToken)}
                  >
                    {tokenCopy.copied ? (
                      <Check className="text-brand size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </Button>
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => handleGenerateClose(false)}
                  className="w-full"
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Generate SCIM token</DialogTitle>
                <DialogDescription>
                  Name it after the IdP it&apos;s for, so you can tell tokens
                  apart when rotating them.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 py-2">
                <Label htmlFor="scim-token-label">Label</Label>
                <Input
                  id="scim-token-label"
                  placeholder="e.g. Okta"
                  value={label}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleGenerate();
                  }}
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => handleGenerateClose(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleGenerate}
                  loading={createMutation.isPending}
                  disabled={!label.trim() || createMutation.isPending}
                >
                  {createMutation.isPending ? "Generating..." : "Generate"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke &quot;{revokeTarget?.label}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your identity provider loses access immediately, and provisioning
              stops until you generate a new token and paste it into the IdP.
              Members and groups it already synced are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={revokeMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!revokeTarget) return;
                revokeMutation.mutate(revokeTarget.id, {
                  onSuccess: () => setRevokeTarget(null),
                });
              }}
            >
              {revokeMutation.isPending ? "Revoking..." : "Revoke token"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
