"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, KeyRound } from "lucide-react";
import { getSecrets } from "@/lib/actions/secrets";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { SecretCard } from "./secret-card";
import { SecretDialog } from "./secret-dialog";
import { VaultAccessCard } from "./vault-access-card";

interface Secret {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  createdAt: Date;
}

export const SecretsContent = () => {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const fetchSecrets = useCallback(async () => {
    const result = await getSecrets();
    setSecrets(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

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
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Local Secrets</h3>
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
              Add a secret to inject encrypted credentials into gateway
              requests.
            </p>
          </Card>
        ) : (
          secrets.map((secret) => (
            <SecretCard
              key={secret.id}
              secret={secret}
              onUpdate={fetchSecrets}
            />
          ))
        )}

        <SecretDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onSaved={fetchSecrets}
        />
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-medium">Bitwarden Vault</h3>
        <VaultAccessCard />
      </section>
    </div>
  );
};
