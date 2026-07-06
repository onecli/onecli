"use client";

import { useState } from "react";
import Image from "next/image";
import { useQueryClient } from "@tanstack/react-query";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { queryKeys } from "@/lib/api/keys";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import { Badge } from "@onecli/ui/components/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@onecli/ui/components/alert-dialog";
import { deleteSecret as defaultDeleteSecret } from "@/lib/actions/secrets";
import type { SecretActions } from "./types";
import {
  type InjectionConfig,
  isHeaderInjection,
  isParamInjection,
  isPathRegexInjection,
  isPathTemplateInjection,
  parseGoogleServiceAccountMetadata,
} from "@onecli/api/validations/secret";
import { SecretDialog } from "./secret-dialog";

interface SecretCardProps {
  secret: {
    id: string;
    name: string;
    type: string;
    typeLabel: string;
    valueSource?: string;
    opRef?: string | null;
    hostPattern: string;
    pathPattern: string | null;
    injectionConfig: unknown;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  };
  onUpdate?: () => void;
  secretActions?: SecretActions;
  readOnly?: boolean;
  badge?: string;
}

export const SecretCard = ({
  secret,
  onUpdate,
  secretActions,
  readOnly,
  badge,
}: SecretCardProps) => {
  const invalidateCache = useInvalidateGatewayCache();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await (secretActions?.deleteSecret ?? defaultDeleteSecret)(secret.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
      onUpdate?.();
      invalidateCache();
      toast.success("Secret deleted");
    } catch {
      toast.error("Failed to delete secret");
    } finally {
      setDeleting(false);
    }
  };

  const config = secret.injectionConfig as InjectionConfig | null;
  const opDisplay =
    secret.valueSource === "onepassword"
      ? (secret.metadata?.opDisplay as
          | { vault: string; item: string; field: string }
          | undefined)
      : undefined;
  const saMeta =
    secret.type === "google_service_account"
      ? parseGoogleServiceAccountMetadata(secret.metadata)
      : null;

  return (
    <>
      <Card className={cn("p-5", readOnly && "opacity-60 border-dashed")}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">{secret.name}</h3>
              <Badge variant="secondary" className="text-xs">
                {secret.typeLabel}
              </Badge>
              {secret.valueSource === "onepassword" && (
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <Image
                    src="/icons/onepassword.svg"
                    alt=""
                    width={12}
                    height={12}
                  />
                  1Password
                </Badge>
              )}
              {badge && (
                <Badge variant="outline" className="text-[10px]">
                  {badge}
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                Host:{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono">
                  {secret.hostPattern}
                </code>
              </span>
              {opDisplay && (
                <span className="text-muted-foreground">
                  Value:{" "}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono">
                    {opDisplay.vault} › {opDisplay.item} › {opDisplay.field}
                  </code>
                </span>
              )}
              {saMeta && (
                <span className="text-muted-foreground">
                  Email:{" "}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono">
                    {saMeta.clientEmail}
                  </code>
                </span>
              )}
              {secret.pathPattern && (
                <span className="text-muted-foreground">
                  Path:{" "}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono">
                    {secret.pathPattern}
                  </code>
                </span>
              )}
              {secret.type === "generic" &&
                config &&
                isHeaderInjection(config) && (
                  <span className="text-muted-foreground">
                    Header{" "}
                    <code className="bg-muted rounded px-1 py-0.5 font-mono">
                      {config.headerName}
                    </code>
                  </span>
                )}
              {secret.type === "generic" &&
                config &&
                isParamInjection(config) && (
                  <span className="text-muted-foreground">
                    Query param{" "}
                    <code className="bg-muted rounded px-1 py-0.5 font-mono">
                      ?{config.paramName}
                    </code>
                  </span>
                )}
              {secret.type === "generic" &&
                config &&
                isPathTemplateInjection(config) && (
                  <span className="text-muted-foreground">
                    URL path{" "}
                    <code className="bg-muted rounded px-1 py-0.5 font-mono">
                      {config.pathTemplate}
                    </code>
                  </span>
                )}
              {secret.type === "generic" &&
                config &&
                isPathRegexInjection(config) && (
                  <span className="text-muted-foreground">
                    URL path{" "}
                    <code className="bg-muted rounded px-1 py-0.5 font-mono">
                      {config.pathRegex}
                    </code>
                  </span>
                )}
            </div>

            <p className="text-muted-foreground text-xs">
              Created {new Date(secret.createdAt).toLocaleDateString()}
            </p>
          </div>

          {!readOnly && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="size-3.5" />
              </Button>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7">
                    <Trash2 className="size-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete secret?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete{" "}
                      <strong>{secret.name}</strong> and its encrypted value.
                      This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={deleting}
                    >
                      {deleting ? "Deleting..." : "Delete"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>
      </Card>

      {!readOnly && (
        <SecretDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          secret={secret}
          onSaved={onUpdate}
          secretActions={secretActions}
        />
      )}
    </>
  );
};
