"use client";

import { useState } from "react";
import { Globe, Trash2 } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
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
import type { OrgDomain } from "@/lib/api";
import {
  useDomains,
  useCreateDomain,
  useVerifyDomain,
  useDeleteDomain,
} from "@/hooks/use-domains";
import { usePlanGate } from "@/lib/plan-gate";
import { DomainTxtRecord } from "./domain-txt-record";
import { PlanGatedSubmitButton } from "./plan-gated-submit-button";

export const OrgDomainsCard = () => {
  const { data: domainList = [], isPending } = useDomains();
  const createMutation = useCreateDomain();
  const verifyMutation = useVerifyDomain();
  const deleteMutation = useDeleteDomain();
  const planGate = usePlanGate();

  const [domainInput, setDomainInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<OrgDomain | null>(null);

  const locked = planGate.isLocked("sso");

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (planGate.guard("sso")) return;
    const domain = domainInput.trim();
    if (!domain) return;
    createMutation.mutate(domain, { onSuccess: () => setDomainInput("") });
  };

  return (
    <>
      <Card>
        <CardContent className="space-y-5">
          <form onSubmit={handleAdd} className="grid gap-2">
            <Label htmlFor="domain-input">Add a domain</Label>
            <div className="flex gap-2">
              <Input
                id="domain-input"
                placeholder="example.com"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                className="max-w-sm"
              />
              <PlanGatedSubmitButton
                className="shrink-0"
                locked={locked}
                pending={createMutation.isPending}
                complete={!!domainInput.trim()}
                pendingLabel="Adding..."
                label="Add domain"
              />
            </div>
            <p className="text-muted-foreground text-xs">
              You&apos;ll prove ownership by publishing a DNS TXT record.
            </p>
          </form>

          {isPending ? (
            <p className="text-muted-foreground text-sm">Loading domains...</p>
          ) : domainList.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-6 py-10 text-center">
              <Globe className="text-muted-foreground mb-1 size-5" />
              <p className="text-sm font-medium">No domains yet</p>
              <p className="text-muted-foreground text-sm">
                Claim your company domain to enable SSO.
              </p>
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {domainList.map((domain) => {
                const verified = domain.verifiedAt !== null;
                const verifying =
                  verifyMutation.isPending &&
                  verifyMutation.variables === domain.id;
                return (
                  <div key={domain.id} className="space-y-3 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {domain.domain}
                        </span>
                        {verified ? (
                          <Badge
                            variant="secondary"
                            className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
                          >
                            Verified
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Pending</Badge>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {!verified && (
                          <Button
                            size="sm"
                            variant="outline"
                            loading={verifying}
                            disabled={verifyMutation.isPending}
                            onClick={() => verifyMutation.mutate(domain.id)}
                          >
                            {verifying ? "Checking..." : "Verify"}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${domain.domain}`}
                          onClick={() => setDeleteTarget(domain)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>

                    {!verified && <DomainTxtRecord domain={domain} />}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {deleteTarget?.domain}?</AlertDialogTitle>
            <AlertDialogDescription>
              The domain loses its verification. Features that depend on it
              (like SSO sign-in routing) will stop working for this domain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
