"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Label } from "@onecli/ui/components/label";
import { PasswordInput } from "@/components/password-input";
import { createOnpremAuthClient } from "@/lib/auth/auth-client";
import { authErrorMessage } from "@/lib/auth/auth-errors";

/** Matches the identity layer's own floor, so the form refuses before the API does. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Change the password on a self-hosted account.
 *
 * Every other session is revoked as part of the change: the usual reason to
 * change a password is that someone else may know the old one, and leaving
 * their session alive would defeat the point. That includes anything the
 * gateway is holding, which reads the same session rows.
 */
export const ChangePasswordCard = ({
  hasPassword,
}: {
  hasPassword: boolean;
}) => {
  const client = useMemo(() => createOnpremAuthClient(), []);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);

  if (!hasPassword) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            This account signs in with Google, so there is no password to
            change.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const canSubmit =
    currentPassword !== "" && newPassword.length >= MIN_PASSWORD_LENGTH;

  const submit = async () => {
    setSaving(true);
    const { error } = await client.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setSaving(false);

    if (error) {
      toast.error(authErrorMessage(error));
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    toast.success("Password changed. Other sessions were signed out.");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Changing it signs out every other session, everywhere.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit && !saving) submit();
          }}
          className="grid max-w-sm gap-4"
        >
          <div className="grid gap-2">
            <Label htmlFor="current-password">Current password</Label>
            <PasswordInput
              id="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              disabled={saving}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-password">New password</Label>
            <PasswordInput
              id="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              disabled={saving}
            />
            <p className="text-muted-foreground text-xs">
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>
          <div>
            <Button type="submit" loading={saving} disabled={!canSubmit}>
              {saving ? "Changing..." : "Change password"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
};
