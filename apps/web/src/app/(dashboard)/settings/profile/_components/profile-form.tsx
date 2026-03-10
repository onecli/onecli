"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { useAuth } from "@/providers/auth-provider";
import { getUserByAuthId, updateProfile } from "@/lib/actions/user";

export function ProfileForm() {
  const { user: authUser } = useAuth();
  const [name, setName] = useState("");
  const [initialName, setInitialName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!authUser?.id) return;
    getUserByAuthId(authUser.id).then((user) => {
      if (user) {
        setName(user.name ?? "");
        setInitialName(user.name ?? "");
        setEmail(user.email ?? "");
      }
      setLoading(false);
    });
  }, [authUser?.id]);

  const handleSave = async () => {
    if (!authUser?.id) return;
    setSaving(true);
    try {
      await updateProfile({ name, authId: authUser.id });
      setInitialName(name);
      toast.success("Profile updated");
    } catch {
      toast.error("Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading profile...
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Personal Info</CardTitle>
        <CardDescription>Update your display name.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" value={email} disabled />
          <p className="text-muted-foreground text-xs">
            Email is managed by your Google account.
          </p>
        </div>
        <Button
          onClick={handleSave}
          disabled={saving || name === initialName}
          className="w-fit"
        >
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </CardContent>
    </Card>
  );
}
