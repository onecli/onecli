"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { useAuth } from "@/providers/auth-provider";
import { getSecrets } from "@/lib/actions/secrets";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { SecretCard } from "./secret-card";
import { CreateSecretDialog } from "./create-secret-dialog";

interface Secret {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  createdAt: Date;
  _count: { policies: number };
}

export const SecretsContent = () => {
  const { user } = useAuth();
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const fetchSecrets = useCallback(async () => {
    if (!user?.id) return;
    const result = await getSecrets(user.id);
    setSecrets(result);
    setLoading(false);
  }, [user?.id]);

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
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" />
          Add Secret
        </Button>
      </div>

      {secrets.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-muted-foreground text-sm">
            No secrets yet. Add one to get started.
          </p>
        </Card>
      ) : (
        secrets.map((secret) => (
          <SecretCard key={secret.id} secret={secret} onUpdate={fetchSecrets} />
        ))
      )}

      <CreateSecretDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={fetchSecrets}
      />
    </div>
  );
};
