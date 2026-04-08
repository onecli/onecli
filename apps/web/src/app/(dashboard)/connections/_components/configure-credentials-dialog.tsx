"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { saveAppConfig, setAppConfigEnabled } from "@/lib/actions/app-config";
import type { OAuthConfigField } from "@/lib/apps/types";
import { IS_CLOUD } from "@/lib/env";
import { AppIcon } from "./app-icon";

interface ConfigureCredentialsDialogProps {
  provider: string;
  appName: string;
  appIcon: string;
  appDarkIcon?: string;
  fields: OAuthConfigField[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigured: () => void;
}

export const ConfigureCredentialsDialog = ({
  provider,
  appName,
  appIcon,
  appDarkIcon,
  fields,
  open,
  onOpenChange,
  onConfigured,
}: ConfigureCredentialsDialogProps) => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const allFilled = fields.every((f) => !!values[f.name]?.trim());

  const handleSave = async () => {
    if (!allFilled) return;
    setSaving(true);
    try {
      await saveAppConfig(provider, values);
      await setAppConfigEnabled(provider, true);
      setValues({});
      onConfigured();
    } catch {
      toast.error("Failed to save credentials");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <AppIcon icon={appIcon} darkIcon={appDarkIcon} name={appName} />
            </div>
            <div>
              <DialogTitle className="text-base">{appName}</DialogTitle>
              <p className="text-muted-foreground text-xs">
                This connection requires setup
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {fields.map((field, i) => (
            <div key={field.name} className="grid gap-1.5">
              <Label htmlFor={`config-${field.name}`}>
                {field.label}
                <span className="text-destructive ml-0.5">*</span>
              </Label>
              {field.description && (
                <p className="text-muted-foreground text-xs">
                  {field.description}
                </p>
              )}
              <Input
                id={`config-${field.name}`}
                type={field.secret ? "password" : "text"}
                value={values[field.name] ?? ""}
                onChange={(e) =>
                  setValues((prev) => ({
                    ...prev,
                    [field.name]: e.target.value,
                  }))
                }
                placeholder={field.placeholder}
                className="font-mono text-sm"
                autoFocus={i === 0}
              />
            </div>
          ))}

          <Button
            className="w-full"
            onClick={handleSave}
            loading={saving}
            disabled={!allFilled}
          >
            {saving ? "Saving..." : "Save & Connect"}
          </Button>

          {!IS_CLOUD && (
            <p className="text-muted-foreground text-center text-xs">
              Or use{" "}
              <a
                href="https://app.onecli.sh"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground font-medium underline underline-offset-2 transition-colors hover:text-foreground/80"
              >
                OneCLI Cloud
              </a>{" "}
              for pre-configured connections.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
