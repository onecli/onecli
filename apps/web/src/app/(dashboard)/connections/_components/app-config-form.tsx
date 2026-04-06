"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, Settings2 } from "lucide-react";
import { toast } from "sonner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@onecli/ui/components/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@onecli/ui/components/alert-dialog";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Switch } from "@onecli/ui/components/switch";
import {
  saveAppConfig,
  getAppConfigStatus,
  deleteAppConfigAction,
  setAppConfigEnabled,
} from "@/lib/actions/app-config";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

interface AppConfigFormProps {
  provider: string;
  appName: string;
  fields: {
    name: string;
    label: string;
    description?: string;
    placeholder: string;
    secret?: boolean;
  }[];
  hasEnvDefaults: boolean;
  isConnected: boolean;
  /** Called after any config change that invalidates the connection (save, toggle, delete). */
  onConfigChange?: () => void;
}

export const AppConfigForm = ({
  provider,
  appName,
  fields,
  hasEnvDefaults,
  isConnected,
  onConfigChange,
}: AppConfigFormProps) => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [hasCredentials, setHasCredentials] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    "save" | "toggle-on" | "toggle-off" | null
  >(null);

  const fetchConfig = useCallback(async () => {
    try {
      const config = await getAppConfigStatus(provider);
      if (config) {
        setValues(config.settings);
        setHasCredentials(config.hasCredentials);
        setEnabled(config.enabled);
      } else {
        setValues({});
        setHasCredentials(false);
        setEnabled(false);
      }
    } catch {
      // Failed to fetch
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const doSave = async () => {
    setSaving(true);
    try {
      await saveAppConfig(provider, values);
      toast.success("Credentials saved");
      await fetchConfig();
      onConfigChange?.();
    } catch {
      toast.error("Failed to save credentials");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (isConnected) {
      setPendingAction("save");
    } else {
      doSave();
    }
  };

  const doToggle = async (checked: boolean) => {
    setEnabled(checked);
    try {
      await setAppConfigEnabled(provider, checked);
      toast.success(
        checked ? "Custom credentials enabled" : "Custom credentials disabled",
      );
      onConfigChange?.();
    } catch {
      setEnabled(!checked);
      toast.error("Failed to update");
    }
  };

  const handleToggle = (checked: boolean) => {
    if (checked && !hasCredentials) {
      setEnabled(false);
      return;
    }
    if (isConnected) {
      setPendingAction(checked ? "toggle-on" : "toggle-off");
    } else {
      doToggle(checked);
    }
  };

  const doDelete = async () => {
    try {
      await deleteAppConfigAction(provider);
      setValues({});
      setHasCredentials(false);
      setEnabled(false);
      toast.success("Credentials removed");
      onConfigChange?.();
    } catch {
      toast.error("Failed to remove credentials");
    }
  };

  const handleConfirmAction = async () => {
    if (pendingAction === "save") await doSave();
    else if (pendingAction === "toggle-on") await doToggle(true);
    else if (pendingAction === "toggle-off") await doToggle(false);
    setPendingAction(null);
  };

  const hasInput = fields.some((f) => !!values[f.name]);
  const defaultOpen = enabled || !hasEnvDefaults;

  if (loading) {
    return (
      <div className="flex items-center justify-center border-t py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={defaultOpen ? "credentials" : undefined}
    >
      <AccordionItem value="credentials" className="border-b-0 border-t">
        <AccordionTrigger className="py-3 hover:no-underline">
          <span className="text-muted-foreground flex items-center gap-2 text-xs font-normal">
            <Settings2 className="size-3.5" />
            Custom credentials
          </span>
        </AccordionTrigger>
        <AccordionContent className="pb-1">
          <Card className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">
                  Use your own developer credentials
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {enabled
                    ? "Your custom credentials are active."
                    : hasCredentials
                      ? "Your credentials are saved but disabled."
                      : hasEnvDefaults
                        ? "Override platform defaults with your own."
                        : `Required to connect ${appName}.`}
                </p>
                {!hasEnvDefaults &&
                  !hasCredentials &&
                  !enabled &&
                  process.env.NEXT_PUBLIC_EDITION !== "cloud" && (
                    <p className="text-xs text-muted-foreground mt-1.5">
                      Or connect instantly with{" "}
                      <a
                        href="https://app.onecli.sh"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground font-medium underline underline-offset-2 transition-colors hover:text-foreground/80"
                      >
                        OneCLI Cloud
                      </a>{" "}
                      - no credentials needed.
                    </p>
                  )}
              </div>
              <Switch checked={enabled} onCheckedChange={handleToggle} />
            </div>

            {fields.map((field) => (
              <div key={field.name} className="grid gap-1.5">
                <Label htmlFor={`config-${field.name}`}>{field.label}</Label>
                {field.description && (
                  <p className="text-xs text-muted-foreground">
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
                  placeholder={
                    field.secret && hasCredentials
                      ? "Leave empty to keep current"
                      : field.placeholder
                  }
                  className="font-mono text-sm"
                />
              </div>
            ))}

            <RedirectUri provider={provider} />

            <div className="flex items-center gap-3">
              <Button
                size="sm"
                onClick={handleSave}
                loading={saving}
                disabled={!hasInput}
              >
                {saving ? "Saving..." : "Save credentials"}
              </Button>
              {hasCredentials && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    >
                      Remove
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Remove custom credentials?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {hasEnvDefaults
                          ? `This will delete your credentials. ${appName} will fall back to platform defaults.`
                          : `This will delete your credentials. ${appName} will no longer be available until reconfigured.`}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={doDelete}
                        className="bg-destructive text-white hover:bg-destructive/90"
                      >
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </Card>
        </AccordionContent>
      </AccordionItem>

      {/* Confirmation dialog when config change would disconnect an active connection */}
      <AlertDialog
        open={!!pendingAction}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This will disconnect {appName}</AlertDialogTitle>
            <AlertDialogDescription>
              Changing credentials will disconnect your current {appName}{" "}
              connection. You&apos;ll need to reconnect afterward.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmAction}>
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Accordion>
  );
};

const RedirectUri = ({ provider }: { provider: string }) => {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:10254";
  const redirectUri = `${appUrl}/api/apps/${provider}/callback`;
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="grid gap-1.5">
      <Label>Redirect URI</Label>
      <p className="text-xs text-muted-foreground">
        Add this URL to your OAuth app&apos;s allowed redirect URIs.
      </p>
      <div className="flex items-center gap-3">
        <div className="flex-1 rounded-md border bg-muted/50 px-3 py-2 font-mono text-sm text-foreground truncate">
          {redirectUri}
        </div>
        <button
          type="button"
          onClick={() => copy(redirectUri)}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? (
            <Check className="size-4 text-brand" />
          ) : (
            <Copy className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
};
