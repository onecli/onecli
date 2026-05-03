"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Plus, KeyRound } from "lucide-react";
import { getSecrets } from "@/lib/actions/secrets";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { SecretCard } from "./secret-card";
import { SecretDialog, type SecretPrefill } from "./secret-dialog";

interface Secret {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  isPlatform: boolean;
  createdAt: Date;
}

export const SecretsContent = () => {
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
  }, []);

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

  // Auto-open create dialog from URL params (e.g., ?create=generic&host=api.example.com)
  useEffect(() => {
    if (paramHandled.current || loading) return;
    const createType = searchParams.get("create");
    const host = searchParams.get("host");
    const action = searchParams.get("action");
    if (action === "new") {
      paramHandled.current = true;
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    } else if (createType === "anthropic") {
      paramHandled.current = true;
      setPrefill({
        type: "anthropic",
        hostPattern: "api.anthropic.com",
        name: "Anthropic Token",
      });
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    } else if (createType === "generic" && host) {
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
  }, [searchParams, loading, router]);

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
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" />
          Add Secret
        </Button>
      </div>

      {secrets.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
            <KeyRound className="text-muted-foreground size-6" />
          </div>
          <p className="text-sm font-medium">No secrets yet</p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            Add a secret to inject encrypted credentials into gateway requests.
          </p>
        </Card>
      ) : (
        secrets.map((secret) => (
          <SecretCard key={secret.id} secret={secret} onUpdate={fetchSecrets} />
        ))
      )}

      <SecretDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setPrefill(undefined);
        }}
        onSaved={fetchSecrets}
        prefill={prefill}
      />
    </div>
  );
};
