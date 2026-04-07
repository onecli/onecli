"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Switch } from "@onecli/ui/components/switch";
import { Label } from "@onecli/ui/components/label";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { toast } from "sonner";
import {
  getTelemetryStatus,
  updateTelemetryPreference,
} from "@/lib/actions/telemetry";

export const TelemetryToggle = () => {
  const [enabled, setEnabled] = useState(false);
  const [forcedByEnv, setForcedByEnv] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTelemetryStatus().then((status) => {
      setEnabled(status.enabled);
      setForcedByEnv(status.forcedByEnv);
      setLoading(false);
    });
  }, []);

  const handleToggle = async (checked: boolean) => {
    setEnabled(checked);
    try {
      await updateTelemetryPreference(checked);
      toast.success(checked ? "Telemetry enabled" : "Telemetry disabled");
    } catch {
      setEnabled(!checked);
      toast.error("Failed to update telemetry preference");
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-6 w-10" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Anonymous Telemetry</CardTitle>
        <CardDescription>
          Help improve OneCLI by sending anonymous install and update events.
          Only version, architecture, and edition are collected. No personal
          data or hostnames are ever sent.{" "}
          <a
            href="https://onecli.sh/docs/reference/telemetry"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Learn more
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <Switch
            id="telemetry"
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={forcedByEnv}
          />
          <Label htmlFor="telemetry">{enabled ? "Enabled" : "Disabled"}</Label>
        </div>
        {forcedByEnv && (
          <p className="text-muted-foreground mt-2 text-xs">
            Telemetry is disabled by the <code>DO_NOT_TRACK</code> environment
            variable and cannot be changed here.
          </p>
        )}
      </CardContent>
    </Card>
  );
};
