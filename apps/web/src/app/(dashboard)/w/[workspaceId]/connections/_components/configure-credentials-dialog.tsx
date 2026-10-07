"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { SecretInput } from "@/components/secret-input";
import type { PageScope } from "@/lib/api";
import { useSaveAppConfig } from "@/hooks/use-app-config";
import type { OAuthConfigField } from "@onecli/api/apps/types";
import { CloudUpsell } from "@/lib/components/cloud-upsell";
import { AppIcon } from "@/lib/components/app-icon";
import { SetupGuideLink } from "@/lib/components/setup-guide-link";
import { RedirectUri } from "./redirect-uri";
import { ConfigFieldOptions } from "./config-field-options";
import { buildConfigPayload, resolveConfigValue } from "./config-field-values";

interface ConfigureCredentialsDialogProps {
  provider: string;
  appName: string;
  appIcon: string;
  appDarkIcon?: string;
  fields: OAuthConfigField[];
  hint?: string;
  /** The app's OneCLI setup guide (`AppDefinition.setupGuideUrl`). */
  setupGuideUrl?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigured: () => void;
  pageScope?: PageScope;
}

export const ConfigureCredentialsDialog = ({
  provider,
  appName,
  appIcon,
  appDarkIcon,
  fields,
  hint,
  setupGuideUrl,
  open,
  onOpenChange,
  onConfigured,
  pageScope = "workspace",
}: ConfigureCredentialsDialogProps) => {
  const [values, setValues] = useState<Record<string, string>>({});
  // Field ids are prefixed per instance: the app page mounts this dialog next
  // to AppConfigForm, which renders the same fields, and a shared `config-…`
  // id would point every label at whichever element came first in the DOM.
  const idPrefix = useId();
  const saveMutation = useSaveAppConfig(provider, pageScope);
  const saving = saveMutation.isPending;

  const allFilled = fields.every((f) => !!resolveConfigValue(f, values).trim());

  const handleSave = async () => {
    if (!allFilled) return;
    try {
      // upsertAppConfig enables the config on save — no separate toggle call.
      await saveMutation.mutateAsync(buildConfigPayload(fields, values));
      setValues({});
      onConfigured();
    } catch {
      toast.error("Failed to save credentials");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted dark:bg-white/10 dark:border-white/10">
              <AppIcon icon={appIcon} darkIcon={appDarkIcon} name={appName} />
            </div>
            <div>
              <DialogTitle className="text-base">{appName}</DialogTitle>
              <DialogDescription className="text-xs">
                This connection requires setup
              </DialogDescription>
            </div>
          </div>
          {hint && <p className="pt-1 text-muted-foreground text-xs">{hint}</p>}
          <SetupGuideLink appName={appName} url={setupGuideUrl} />
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <RedirectUri provider={provider} />
          {fields.map((field, i) => {
            const inputId = `${idPrefix}-${field.name}`;
            const labelId = `${inputId}-label`;
            return (
              <div key={field.name} className="grid gap-1.5">
                <Label
                  id={labelId}
                  htmlFor={field.options ? undefined : inputId}
                >
                  {field.label}
                  <span className="text-destructive ml-0.5">*</span>
                </Label>
                {field.description && (
                  <p className="text-muted-foreground text-xs">
                    {field.description}
                  </p>
                )}
                {field.options ? (
                  <ConfigFieldOptions
                    labelId={labelId}
                    options={field.options}
                    value={resolveConfigValue(field, values)}
                    onChange={(value) =>
                      setValues((prev) => ({ ...prev, [field.name]: value }))
                    }
                  />
                ) : field.secret ? (
                  <SecretInput
                    id={inputId}
                    value={values[field.name] ?? ""}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [field.name]: e.target.value,
                      }))
                    }
                    placeholder={field.placeholder}
                    autoFocus={i === 0}
                  />
                ) : (
                  <Input
                    id={inputId}
                    type="text"
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
                )}
              </div>
            );
          })}

          <Button
            className="w-full"
            onClick={handleSave}
            loading={saving}
            disabled={!allFilled}
          >
            {saving ? "Saving..." : "Save & Connect"}
          </Button>

          <CloudUpsell
            before="Or use"
            after="for pre-configured connections."
            className="text-center"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};
