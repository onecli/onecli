"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { useAuth } from "@/providers/auth-provider";
import { getPolicies } from "@/lib/actions/policies";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PolicyCard } from "./policy-card";
import { CreatePolicyDialog } from "./create-policy-dialog";

interface Policy {
  id: string;
  createdAt: Date;
  agent: { id: string; name: string };
  secret: { id: string; name: string; type: string; hostPattern: string };
}

export const PoliciesContent = () => {
  const { user } = useAuth();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const fetchPolicies = useCallback(async () => {
    if (!user?.id) return;
    const result = await getPolicies(user.id);
    setPolicies(result);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i} className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-36" />
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
          Add Policy
        </Button>
      </div>

      {policies.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-muted-foreground text-sm">
            No policies yet. Create agents and secrets first, then link them
            here.
          </p>
        </Card>
      ) : (
        policies.map((policy) => (
          <PolicyCard
            key={policy.id}
            policy={policy}
            onUpdate={fetchPolicies}
          />
        ))
      )}

      <CreatePolicyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={fetchPolicies}
      />
    </div>
  );
};
