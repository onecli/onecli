"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { Loader2, Settings2 } from "lucide-react";
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
import { cn } from "@onecli/ui/lib/utils";
import { SecretInput } from "@/components/secret-input";
import type { PageScope } from "@/lib/api";
import {
  useAppConfigStatus,
  useSaveAppConfig,
  useDeleteAppConfig,
  useToggleAppConfig,
} from "@/hooks/use-app-config";
import { IS_CLOUD } from "@/lib/env";
import { RedirectUri } from "./redirect-uri";

export interface AppConfigFormHandle {
  /** Open the Custom credentials section, scroll it into view, and briefly highlight it. */
  reveal: () => void;
}

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
  hint?: string;
  hasEnvDefaults: boolean;
  isConnected: boolean;
  pageScope?: PageScope;
  /** Imperative handle so the page header can open + scroll to this section. */
  ref?: Ref<AppConfigFormHandle>;
}

export const AppConfigForm = ({
  provider,
  appName,
  fields,
  hint,
  hasEnvDefaults,
  isConnected,
  pageScope = "project",
  ref,
}: AppConfigFormProps) => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [pendingAction, setPendingAction] = useState<
    "save" | "toggle-on" | "toggle-off" | null
  >(null);
  const [openValue, setOpenValue] = useState("");
  const [openInitialized, setOpenInitialized] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wantScrollRef = useRef(false);

  const statusQuery = useAppConfigStatus(provider, pageScope);
  const saveMutation = useSaveAppConfig(provider, pageScope);
  const deleteMutation = useDeleteAppConfig(provider, pageScope);
  const toggleMutation = useToggleAppConfig(provider, pageScope);

  const loading = statusQuery.isPending;
  // An org-inherited status (`source: "organization"`) means there is no
  // project row behind it — the credentials live on the organization, and the
  // delete/toggle mutations would 404 here. For this editor that is the same
  // as "not configured yet": show the add-credentials state.
  const orgInherited = statusQuery.data?.source === "organization";
  const hasCredentials =
    !orgInherited && (statusQuery.data?.hasCredentials ?? false);
  const enabled = !orgInherited && (statusQuery.data?.enabled ?? false);

  // Blast radius of removing/replacing these credentials — present only on the
  // org config surface (project responses omit `dependents`). Drives the confirm
  // gating and the precise counts in the dialogs; zero on the project page, so
  // that flow stays keyed on `isConnected` alone.
  const dependents = statusQuery.data?.dependents;
  const dependentTotal =
    (dependents?.orgConnections ?? 0) + (dependents?.projectConnections ?? 0);
  const dependentSentence = (() => {
    if (!dependents || dependentTotal === 0) return null;
    const parts: string[] = [];
    if (dependents.orgConnections > 0) {
      parts.push(
        `${dependents.orgConnections} organization ${
          dependents.orgConnections === 1 ? "connection" : "connections"
        }`,
      );
    }
    if (dependents.projectConnections > 0) {
      parts.push(
        `${dependents.projectConnections} project ${
          dependents.projectConnections === 1 ? "connection" : "connections"
        }`,
      );
    }
    // Passive voice reads correctly both after the Remove dialog's lead-in
    // ("…platform defaults. N connections will be disconnected.") and as the
    // opening of the disconnect dialog — avoiding a stacked "This will …".
    return `${parts.join(" and ")} will be disconnected.`;
  })();

  // Keep the editable fields in sync with the fetched settings (also clears
  // them after a delete, once the invalidated query settles). Keyed on the
  // settings reference — not the whole payload — so the optimistic toggle
  // (which replaces the payload but spreads the same settings object) can't
  // wipe in-progress edits.
  const settings = statusQuery.data?.settings;
  const hasStatus = !!statusQuery.data;
  useEffect(() => {
    if (hasStatus) setValues(settings ?? {});
  }, [hasStatus, settings]);

  // On first load, open the section by default when custom credentials are
  // enabled or there are no platform defaults to fall back on. Adjusted during
  // render (guarded) so the section mounts already-open — no open/close flash;
  // never overrides an explicit reveal() or later refetches.
  if (!loading && !openInitialized) {
    setOpenInitialized(true);
    // Org-inherited credentials behave like platform defaults here: the app is
    // usable without project-level setup, so the section stays collapsed.
    if (enabled || (!hasEnvDefaults && !orgInherited)) {
      setOpenValue("credentials");
    }
  }

  const revealSection = useCallback(() => {
    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    rootRef.current?.scrollIntoView({
      behavior: prefersReduced ? "auto" : "smooth",
      block: "start",
    });
    // Move focus to the section's disclosure trigger (without a second scroll) so
    // keyboard and screen-reader users are taken here too — and hear its expanded
    // state — matching the visual scroll for pointer users.
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      reveal: () => {
        setOpenInitialized(true);
        setOpenValue("credentials");
        setHighlight(true);
        wantScrollRef.current = true;
        // Let the accordion begin expanding before scrolling. If the section is
        // still loading (no ref yet), the effect below scrolls once it mounts.
        window.setTimeout(() => {
          if (rootRef.current && wantScrollRef.current) {
            wantScrollRef.current = false;
            revealSection();
          }
        }, 150);
        window.setTimeout(() => setHighlight(false), 2000);
      },
    }),
    [revealSection],
  );

  // If reveal() fired before the section finished loading, reveal once it mounts.
  useEffect(() => {
    if (loading || !wantScrollRef.current) return;
    wantScrollRef.current = false;
    const t = window.setTimeout(revealSection, 150);
    return () => window.clearTimeout(t);
  }, [loading, revealSection]);

  const doSave = async () => {
    try {
      await saveMutation.mutateAsync(values);
      toast.success("Credentials saved");
    } catch {
      toast.error("Failed to save credentials");
    }
  };

  const handleSave = () => {
    if (isConnected || dependentTotal > 0) {
      setPendingAction("save");
    } else {
      doSave();
    }
  };

  const doToggle = (checked: boolean) => {
    toggleMutation.mutate(checked, {
      onSuccess: () =>
        toast.success(
          checked
            ? "Custom credentials enabled"
            : "Custom credentials disabled",
        ),
      onError: () => toast.error("Failed to update"),
    });
  };

  const handleToggle = (checked: boolean) => {
    if (checked && !hasCredentials) return;
    if (isConnected || dependentTotal > 0) {
      setPendingAction(checked ? "toggle-on" : "toggle-off");
    } else {
      doToggle(checked);
    }
  };

  const doDelete = async () => {
    try {
      await deleteMutation.mutateAsync();
      toast.success("Credentials removed");
    } catch {
      toast.error("Failed to remove credentials");
    }
  };

  const handleConfirmAction = async () => {
    if (pendingAction === "save") await doSave();
    else if (pendingAction === "toggle-on") doToggle(true);
    else if (pendingAction === "toggle-off") doToggle(false);
    setPendingAction(null);
  };

  const hasInput = fields.some((f) => !!values[f.name]);
  const saving = saveMutation.isPending;

  if (loading) {
    return (
      <div className="flex items-center justify-center border-t py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Accordion
      ref={rootRef}
      type="single"
      collapsible
      value={openValue}
      onValueChange={setOpenValue}
      className={cn(
        "scroll-mt-6 rounded-lg transition-shadow motion-reduce:transition-none",
        highlight && "ring-2 ring-ring/70",
      )}
    >
      <AccordionItem value="credentials" className="border-b-0 border-t">
        <AccordionTrigger ref={triggerRef} className="py-3 hover:no-underline">
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
                        : (hint ?? `Required to connect ${appName}.`)}
                </p>
                {!hasEnvDefaults &&
                  !hasCredentials &&
                  !enabled &&
                  !IS_CLOUD && (
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
                {field.secret ? (
                  <SecretInput
                    id={`config-${field.name}`}
                    value={values[field.name] ?? ""}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [field.name]: e.target.value,
                      }))
                    }
                    placeholder={
                      hasCredentials
                        ? "Leave empty to keep current"
                        : field.placeholder
                    }
                  />
                ) : (
                  <Input
                    id={`config-${field.name}`}
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
                  />
                )}
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
                      className="text-red-400 hover:text-red-300 hover:bg-red-400/10"
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
                        {dependentSentence ? ` ${dependentSentence}` : ""}
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
              {dependentSentence
                ? `${dependentSentence} You'll need to reconnect afterward.`
                : `Changing credentials will disconnect your current ${appName} connection. You'll need to reconnect afterward.`}
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
