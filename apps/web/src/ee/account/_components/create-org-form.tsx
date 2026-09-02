"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { useAuth } from "@/providers/auth-provider";
import { createOrganizationAction } from "@/ee/settings/actions";

export const CreateOrgForm = () => {
  const { user } = useAuth();
  const router = useRouter();
  const defaultName = user?.name
    ? `${user.name}'s Org`
    : user?.email
      ? `${user.email.split("@")[0]}'s Org`
      : "";
  const [name, setName] = useState(defaultName);
  const [pending, startTransition] = useTransition();

  const handleCreate = () => {
    startTransition(async () => {
      const result = await createOrganizationAction(name);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.push(result.data.redirectTo);
    });
  };

  return (
    <Card className="w-full max-w-lg p-8">
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold">Create a new organization</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Organizations are a way to group your workspaces. Each organization
            can be configured with different team members and billing settings.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="org-name">Name</Label>
          <Input
            id="org-name"
            placeholder="My Organization"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <p className="text-muted-foreground text-xs">
            What is the name of your company or team? You can change this later.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleCreate} disabled={pending || !name.trim()}>
            {pending ? "Creating..." : "Create organization"}
          </Button>
        </div>
      </div>
    </Card>
  );
};
