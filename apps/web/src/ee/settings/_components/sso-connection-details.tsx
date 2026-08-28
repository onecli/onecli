"use client";

import { useState } from "react";
import { CheckCircle2, Trash2, XCircle } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
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
import type { OrgSsoConnection, SsoTestResult } from "@/lib/api";
import {
  useDeleteSsoConnection,
  useTestSsoConnection,
  useUpdateSsoConnection,
} from "@/hooks/use-sso-connections";
import { SsoItPanel } from "./sso-it-panel";

const statusBadge = (status: OrgSsoConnection["status"]) => {
  if (status === "active") {
    return (
      <Badge
        variant="secondary"
        className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
      >
        Active
      </Badge>
    );
  }
  if (status === "disabled") {
    return <Badge variant="outline">Disabled</Badge>;
  }
  return <Badge variant="secondary">Pending</Badge>;
};

export const SsoConnectionDetails = ({
  connection,
}: {
  connection: OrgSsoConnection;
}) => {
  const updateMutation = useUpdateSsoConnection();
  const deleteMutation = useDeleteSsoConnection();
  const testMutation = useTestSsoConnection();

  const [confirm, setConfirm] = useState<"disable" | "delete" | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [newSecret, setNewSecret] = useState("");
  const [testResult, setTestResult] = useState<SsoTestResult | null>(null);

  const disabled = connection.status === "disabled";
  const certExpiresAt = connection.config.certExpiresAt
    ? new Date(connection.config.certExpiresAt)
    : null;

  const runTest = () =>
    testMutation.mutate(connection.id, {
      onSuccess: (result) => setTestResult(result),
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {connection.displayName}
          </span>
          {statusBadge(connection.status)}
          <Badge variant="outline" className="text-[10px] uppercase">
            {connection.type}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!disabled && (
            <Button
              size="sm"
              variant="outline"
              loading={testMutation.isPending}
              onClick={runTest}
            >
              {testMutation.isPending ? "Testing..." : "Test"}
            </Button>
          )}
          {disabled ? (
            <Button
              size="sm"
              variant="outline"
              loading={updateMutation.isPending}
              onClick={() =>
                updateMutation.mutate({
                  connectionId: connection.id,
                  input: { enabled: true },
                })
              }
            >
              {updateMutation.isPending ? "Enabling..." : "Enable"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirm("disable")}
            >
              Disable
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${connection.displayName}`}
            onClick={() => setConfirm("delete")}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="text-muted-foreground text-xs">
        Provider ID{" "}
        <code className="font-mono select-all">
          {connection.cognitoProviderName}
        </code>
        {certExpiresAt && (
          <>
            {" · "}signing certificate expires{" "}
            {certExpiresAt.toISOString().slice(0, 10)}
          </>
        )}
      </div>

      {testResult && (
        <div className="divide-y rounded-lg border">
          {testResult.checks.map((check) => (
            <div
              key={check.name}
              className="flex items-center gap-2 p-2.5 text-sm"
            >
              {check.ok ? (
                <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
              ) : (
                <XCircle className="text-destructive size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{check.name}</span>
              {check.detail && (
                <span className="text-muted-foreground shrink-0 text-xs">
                  {check.detail}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <SsoItPanel connection={connection} />

      {connection.type === "oidc" && !disabled && (
        <Button size="sm" variant="outline" onClick={() => setRotateOpen(true)}>
          Rotate client secret
        </Button>
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "delete"
                ? `Remove ${connection.displayName}?`
                : `Disable ${connection.displayName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "delete"
                ? "The identity provider is removed from the login service and this configuration is deleted. Team members can no longer sign in through it."
                : "SSO sign-in through this provider stops working until you enable it again. The configuration is kept."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm === "delete") {
                  deleteMutation.mutate(connection.id);
                } else {
                  updateMutation.mutate({
                    connectionId: connection.id,
                    input: { enabled: false },
                  });
                }
                setConfirm(null);
              }}
            >
              {confirm === "delete" ? "Remove" : "Disable"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate client secret</AlertDialogTitle>
            <AlertDialogDescription>
              Paste the new client secret from your identity provider. The old
              secret stops working as soon as your IdP invalidates it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="sso-new-secret">New client secret</Label>
            <Input
              id="sso-new-secret"
              type="password"
              value={newSecret}
              onChange={(e) => setNewSecret(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setNewSecret("")}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!newSecret.trim()}
              onClick={() => {
                updateMutation.mutate({
                  connectionId: connection.id,
                  input: { clientSecret: newSecret },
                });
                setNewSecret("");
                setRotateOpen(false);
              }}
            >
              Rotate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
