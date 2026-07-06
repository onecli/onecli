"use client";

import { useEffect, useState, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Plus, KeyRound } from "lucide-react";
import { secrets as secretsApi } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { SecretCard } from "./secret-card";
import { SecretDialog, type SecretPrefill } from "./secret-dialog";
import type { SecretActions } from "./types";
import { safeDecode } from "./safe-decode";
import { labelForScope, type ScopeLabelMap } from "./scope-label";

interface Secret {
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
  scope?: string | null;
  createdAt: Date;
}

interface SecretsContentProps {
  typeFilter: "generic" | "llm";
  getSecrets?: () => Promise<Secret[]>;
  secretActions?: SecretActions;
  pageScope?: string;
  scopeLabels?: ScopeLabelMap;
  renderCreateButton?: (onCreate: () => void) => React.ReactNode;
}

export const SecretsContent = ({
  typeFilter,
  getSecrets,
  secretActions,
  pageScope = "project",
  scopeLabels,
  renderCreateButton,
}: SecretsContentProps) => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: secrets = [], isPending: loading } = useQuery<Secret[]>({
    queryKey: [...queryKeys.secrets.list(), pageScope],
    queryFn: (getSecrets ?? secretsApi.list) as () => Promise<Secret[]>,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [prefill, setPrefill] = useState<SecretPrefill | undefined>();
  const paramHandled = useRef(false);

  const LLM_TYPES = new Set(["anthropic", "openai"]);
  const allFiltered = secrets.filter((s: Secret) =>
    typeFilter === "llm" ? LLM_TYPES.has(s.type) : !LLM_TYPES.has(s.type),
  );
  const ownSecrets = allFiltered.filter(
    (s: Secret) => s.scope === pageScope || !s.scope,
  );
  const inheritedSecrets = allFiltered.filter(
    (s: Secret) => s.scope && s.scope !== pageScope,
  );

  useEffect(() => {
    if (paramHandled.current || loading) return;
    const createType = searchParams.get("create");
    const host = searchParams.get("host");
    const action = searchParams.get("action");
    if (action === "new") {
      paramHandled.current = true;
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    } else if (createType === "anthropic" && typeFilter === "llm") {
      paramHandled.current = true;
      setPrefill({
        type: "anthropic",
        hostPattern: "api.anthropic.com",
        name: "Anthropic Token",
      });
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    } else if (createType === "openai" && typeFilter === "llm") {
      paramHandled.current = true;
      setPrefill({
        type: "openai",
        hostPattern: "api.openai.com",
        name: "OpenAI Token",
      });
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    } else if (createType === "codex" && typeFilter === "llm") {
      paramHandled.current = true;
      setPrefill({
        type: "openai",
        hostPattern: "chatgpt.com",
        name: "Codex Token",
      });
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    } else if (createType === "generic" && typeFilter === "generic" && host) {
      paramHandled.current = true;
      setPrefill({
        type: "generic",
        hostPattern: host,
        pathPattern: safeDecode(searchParams.get("path")),
        name: safeDecode(searchParams.get("name")) ?? `${host} Secret`,
        headerName: safeDecode(searchParams.get("header")),
        valueFormat: safeDecode(searchParams.get("format")),
        paramName: safeDecode(searchParams.get("param")),
        paramFormat: safeDecode(searchParams.get("paramFormat")),
      });
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    }
  }, [searchParams, loading, router, typeFilter]);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i} className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-4 w-32" />
              </div>
              <div className="flex gap-2">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {renderCreateButton ? (
          renderCreateButton(() => setCreateOpen(true))
        ) : (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            {typeFilter === "llm" ? "Add LLM Key" : "Add Secret"}
          </Button>
        )}
      </div>

      {ownSecrets.length === 0 && inheritedSecrets.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
            <KeyRound className="text-muted-foreground size-6" />
          </div>
          <p className="text-sm font-medium">
            {typeFilter === "llm" ? "No LLM keys yet" : "No custom secrets yet"}
          </p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            {typeFilter === "llm"
              ? "Add an LLM API key to route requests through the gateway."
              : "Add a custom secret to inject encrypted credentials into gateway requests."}
          </p>
        </Card>
      ) : (
        <>
          {ownSecrets.map((secret) => (
            <SecretCard
              key={secret.id}
              secret={secret}
              secretActions={secretActions}
            />
          ))}
          {inheritedSecrets.map((secret) => (
            <SecretCard
              key={`inherited-${secret.id}`}
              secret={secret}
              readOnly
              badge={labelForScope(secret.scope, scopeLabels)}
            />
          ))}
        </>
      )}

      <SecretDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setPrefill(undefined);
        }}
        prefill={prefill}
        defaultType={undefined}
        allowedTypes={
          typeFilter === "llm"
            ? ["anthropic", "openai"]
            : ["generic", "google_service_account"]
        }
        secretActions={secretActions}
      />
    </div>
  );
};
