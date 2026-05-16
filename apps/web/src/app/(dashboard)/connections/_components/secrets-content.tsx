"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Plus, KeyRound } from "lucide-react";
import { getSecrets as defaultGetSecrets } from "@/lib/actions/secrets";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { SecretCard } from "./secret-card";
import { SecretDialog, type SecretPrefill } from "./secret-dialog";
import type { SecretActions } from "./types";

interface Secret {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  isPlatform: boolean;
  scope?: string;
  createdAt: Date;
}

interface SecretsContentProps {
  typeFilter: "generic" | "llm";
  getSecrets?: () => Promise<Secret[]>;
  secretActions?: SecretActions;
  pageScope?: "project" | "organization";
  renderCreateButton?: (onCreate: () => void) => React.ReactNode;
}

export const SecretsContent = ({
  typeFilter,
  getSecrets = defaultGetSecrets,
  secretActions,
  pageScope = "project",
  renderCreateButton,
}: SecretsContentProps) => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [prefill, setPrefill] = useState<SecretPrefill | undefined>();
  const paramHandled = useRef(false);

  const fetchSecrets = useCallback(async () => {
    const result = await getSecrets();
    setSecrets(result);
    setLoading(false);
  }, [getSecrets]);

  const allFiltered = secrets.filter((s) =>
    typeFilter === "generic" ? s.type === "generic" : s.type !== "generic",
  );
  const ownSecrets = allFiltered.filter(
    (s) => s.scope === pageScope || !s.scope,
  );
  const inheritedSecrets = allFiltered.filter(
    (s) => s.scope && s.scope !== pageScope,
  );

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

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
    } else if (createType === "generic" && typeFilter === "generic" && host) {
      paramHandled.current = true;
      setPrefill({
        type: "generic",
        hostPattern: host,
        pathPattern: searchParams.get("path") ?? undefined,
        name: searchParams.get("name") ?? `${host} Secret`,
        headerName: searchParams.get("header") ?? undefined,
        valueFormat: searchParams.get("format") ?? undefined,
        paramName: searchParams.get("param") ?? undefined,
        paramFormat: searchParams.get("paramFormat") ?? undefined,
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
              onUpdate={fetchSecrets}
              secretActions={secretActions}
            />
          ))}
          {inheritedSecrets.map((secret) => (
            <SecretCard
              key={`inherited-${secret.id}`}
              secret={secret}
              onUpdate={fetchSecrets}
              readOnly
              badge="Organization"
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
        onSaved={fetchSecrets}
        prefill={prefill}
        defaultType={typeFilter === "generic" ? "generic" : undefined}
        allowedTypes={
          typeFilter === "llm" ? ["anthropic", "openai"] : undefined
        }
        secretActions={secretActions}
      />
    </div>
  );
};
