"use client";

import { useEffect, useState } from "react";
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
import { Skeleton } from "@onecli/ui/components/skeleton";
import { toast } from "sonner";
import { getPublicUrl, updatePublicUrl } from "@/lib/actions/project";

const validateUrl = (value: string): string | null => {
  if (!value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "URL must use http or https";
    }
    return null;
  } catch {
    return "Please enter a valid URL (e.g., https://example.com)";
  }
};

export const PublicUrlForm = () => {
  const [url, setUrl] = useState("");
  const [initialUrl, setInitialUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPublicUrl().then((resolved) => {
      setUrl(resolved);
      setInitialUrl(resolved);
      setLoading(false);
    });
  }, []);

  const handleSave = async () => {
    const validationError = validateUrl(url);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    try {
      const trimmed = url.replace(/\/+$/, "");
      await updatePublicUrl(trimmed || null);
      setUrl(trimmed);
      setInitialUrl(trimmed);
      toast.success("Public URL updated");
    } catch {
      toast.error("Failed to update public URL");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
          <Skeleton className="h-9 w-24" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Public URL</CardTitle>
        <CardDescription>
          The URL used for OAuth redirect callbacks. Set this to your public IP
          or tunnel URL if you&apos;re running behind a reverse proxy or tunnel.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="public-url">URL</Label>
          <Input
            id="public-url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            placeholder="http://localhost:10254"
            className="font-mono text-sm"
          />
          {error ? (
            <p className="text-destructive text-xs">{error}</p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Leave as default for local development. For tunnels or VPS, use
              your public address (e.g., https://abc123.ngrok-free.app).
            </p>
          )}
        </div>
        <Button
          onClick={handleSave}
          loading={saving}
          disabled={url === initialUrl}
          className="w-fit"
        >
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </CardContent>
    </Card>
  );
};
