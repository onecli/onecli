"use client";

import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  isConnectFieldShown,
  type AppDefinition,
  type ConnectFileImport,
  type ConnectFormField,
} from "@onecli/api/apps/types";
import type { ConnectResponse } from "@onecli/api/apps/connect-credentials";
import { Button } from "@onecli/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { SetupGuideLink } from "@/lib/components/setup-guide-link";
import { useSaveCredentials } from "@/hooks/use-save-credentials";
import { ConnectLayout } from "./connect-layout";
import { OrDivider } from "./or-divider";
import { FieldInput } from "./field-input";
import { ConnectionStringPaste } from "./connection-string-paste";
import { ConnectionTestError } from "@/lib/api/connection-test-error";
import { ConnectionTestResult } from "@/lib/connections/connection-test-result";
import type { ReconnectPrefill } from "@/lib/actions/reconnect-prefill";

const focusFeedback = (node: HTMLDivElement | null) => node?.focus();

/** Defaults are submitted even when Advanced is never opened. */
const initialValues = (fields: ConnectFormField[]): Record<string, string> =>
  Object.fromEntries(
    fields.flatMap((f) =>
      f.options && f.defaultValue !== undefined
        ? [[f.name, f.defaultValue]]
        : [],
    ),
  );

/** Prefilled values for this form's own non-secret fields only. */
const knownValues = (
  fields: ConnectFormField[],
  prefill: Record<string, string> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    fields.flatMap((f) =>
      !f.secret && prefill?.[f.name] ? [[f.name, prefill[f.name]!]] : [],
    ),
  );

/** Whether `values` set any of `fields` away from its default, so the
 *  Advanced section opens to show it instead of saving it out of sight. */
const leavesDefault = (
  fields: ConnectFormField[],
  values: Record<string, string> | undefined,
): boolean =>
  fields.some(
    (f) =>
      !!values?.[f.name] &&
      values[f.name] !== (f.defaultValue ?? f.placeholder),
  );

/** The label field's placeholder: the app's hint without its `e.g.`, and
 *  without quotes around a single example (`"Orders (prod)"`). */
const labelPlaceholder = (hint: string | undefined): string => {
  const example = hint?.replace(/^e\.g\.\s*/, "");
  if (!example) return "personal, work…";
  return /^"[^"]*"$/.test(example) ? example.slice(1, -1) : example;
};

export interface CredentialsFlowProps {
  app: {
    id: string;
    name: string;
    icon: string;
    darkIcon?: string;
    connectionType: string;
    labelHint?: string;
    /** Set for database apps (PostgreSQL): the form leads with a name. */
    database?: AppDefinition["database"];
    setupGuideUrl?: string;
  };
  fields: ConnectFormField[];
  fileImport?: ConnectFileImport;
  connectionId?: string;
  /** A reconnect's previous non-secret values: the form starts from them,
   *  and from Advanced open when one of them lives there. */
  prefill?: ReconnectPrefill;
  preContent?: ReactNode;
  onSuccess: (connection?: { id: string; label: string | null }) => void;
  onError: (message: string) => void;
  workspaceId?: string;
  orgId?: string;
  agentId?: string;
  method?: string;
  onBack?: () => void;
  /** Opt-in verification keeps this form mounted until it resolves. */
  onSaved?: (response: ConnectResponse) => Promise<void>;
  progressLabel?: string;
  inlineErrors?: boolean;
  /** Database verification requires an explicit scope before any save. */
  beforeSave?: () => void;
}

export const CredentialsFlow = ({
  app,
  fields,
  fileImport,
  connectionId,
  prefill,
  preContent,
  onSuccess,
  onError,
  workspaceId,
  orgId,
  agentId,
  method,
  onBack,
  onSaved,
  progressLabel,
  inlineErrors = false,
  beforeSave,
}: CredentialsFlowProps) => {
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...initialValues(fields),
    ...knownValues(fields, prefill?.fields),
  }));
  const [connectionLabel, setConnectionLabel] = useState(prefill?.label ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refused connection check, rendered with its code's own help.
  const [testError, setTestError] = useState<ConnectionTestError | null>(null);
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const save = useSaveCredentials();
  const hasGroups = fields.some((f) => f.group);
  const groups = [
    ...new Set(fields.flatMap((f) => (f.group ? [f.group] : []))),
  ];
  const [activeGroup, setActiveGroup] = useState<string | null>(
    groups[0] ?? null,
  );
  const allVisibleFields = (
    hasGroups
      ? fields.filter((f) => !f.group || f.group === activeGroup)
      : fields
  ).filter((f) => isConnectFieldShown(f, values));
  const visibleFields = allVisibleFields.filter((f) => !f.optional);
  const advancedFields = allVisibleFields.filter((f) => f.optional);
  const hasInput = visibleFields.every((f) => !!values[f.name]?.trim());
  const busy = submitting || !!progressLabel;
  // A database is named like a saved favorite in a SQL client: the first
  // field, not tucked under Advanced.
  const nameFirst = !!app.database;
  const prefilled =
    Object.keys(knownValues(fields, prefill?.fields)).length > 0;
  // Reconnecting with a non-default Advanced value (a port, a TLS mode, a
  // CA): show it, so a user can see what they are about to save again.
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    leavesDefault(advancedFields, prefill?.fields),
  );
  const labelField = (
    <div className="grid gap-1.5">
      <Label htmlFor="connect-label">
        {nameFirst ? "Name" : "Connection label"}
      </Label>
      <Input
        id="connect-label"
        name="label"
        autoComplete="off"
        type="text"
        value={connectionLabel}
        onChange={(e) => setConnectionLabel(e.target.value)}
        placeholder={labelPlaceholder(app.labelHint)}
        className="min-h-11 text-sm"
        aria-describedby="connect-label-help"
        autoFocus={nameFirst && !prefilled}
      />
      <p
        id="connect-label-help"
        className="text-xs text-muted-foreground dark:text-foreground/70"
      >
        {nameFirst
          ? "Optional. Defaults to the database name."
          : "Optional - helps identify this account when you have multiple connections."}
      </p>
    </div>
  );

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !fileImport) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (submittingRef.current) return;
      try {
        const json: unknown = JSON.parse(String(reader.result));
        if (typeof json !== "object" || json === null)
          throw new Error("Invalid JSON file");
        const mapped: Record<string, string> = {};
        for (const [jsonKey, fieldName] of Object.entries(fileImport.keyMap)) {
          if (jsonKey in json) {
            const val: unknown = Reflect.get(json, jsonKey);
            if (typeof val === "string" && val) mapped[fieldName] = val;
          }
        }
        if (
          hasGroups &&
          "type" in json &&
          typeof json.type === "string" &&
          groups.includes(json.type)
        )
          setActiveGroup(json.type);
        setValues({ ...initialValues(fields), ...mapped });
      } catch {
        onError("Invalid JSON file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleSubmit = async () => {
    if (!hasInput || submittingRef.current || progressLabel) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      beforeSave?.();
      let response: ConnectResponse;
      try {
        response = await save.mutateAsync({
          appId: app.id,
          scope: orgId
            ? { kind: "organization", organizationId: orgId }
            : { kind: "workspace", workspaceId },
          body: {
            // Only what is on screen: a field hidden by `showWhen` (a CA
            // certificate under Encrypt only) is never submitted.
            fields: Object.fromEntries(
              Object.entries(values).filter(([name]) => {
                const f = fields.find((x) => x.name === name);
                return !f || isConnectFieldShown(f, values);
              }),
            ),
            connectionId,
            ...(connectionLabel.trim()
              ? { label: connectionLabel.trim() }
              : {}),
            ...(method ? { method } : {}),
            ...(agentId ? { agentId } : {}),
          },
        });
      } finally {
        // Credentials belong only to the mounted form, never the mutation cache.
        save.reset();
      }
      if (onSaved) await onSaved(response);
      else onSuccess(response.connection);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect";
      setTestError(err instanceof ConnectionTestError ? err : null);
      if (inlineErrors) setError(message);
      else onError(message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  const alternateGroup =
    hasGroups && groups.length > 1
      ? groups.find((g) => g !== activeGroup)
      : null;
  const groupLabel = (group: string) =>
    group === "service_account"
      ? "service account key"
      : group === "authorized_user"
        ? "user credentials"
        : group;

  return (
    <ConnectLayout
      appName={app.name}
      appIcon={app.icon}
      appDarkIcon={app.darkIcon}
    >
      <form
        aria-label={`${app.name} credentials`}
        aria-busy={busy}
        className="space-y-5 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        {preContent}
        <SetupGuideLink appName={app.name} url={app.setupGuideUrl} />
        <fieldset disabled={busy} className="min-w-0 space-y-5">
          {fileImport && (
            <>
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={fileImport.accept}
                  onChange={handleFileImport}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {fileImport.label}
                </Button>
              </div>
              <OrDivider label="or fill manually" />
            </>
          )}
          {nameFirst && (
            <ConnectionStringPaste
              onParsed={(parsed) => {
                setValues((prev) => ({
                  ...prev,
                  ...knownValues(fields, parsed),
                  // The password is secret, so `knownValues` skips it.
                  ...(parsed.password ? { password: parsed.password } : {}),
                }));
                // A pasted non-default port or TLS mode lives under Advanced:
                // show it, so nothing is filled out of sight.
                if (leavesDefault(advancedFields, parsed))
                  setAdvancedOpen(true);
              }}
            />
          )}
          {nameFirst && labelField}
          {visibleFields.map((field, i) => (
            <FieldInput
              key={field.name}
              field={field}
              value={values[field.name] ?? ""}
              onChange={(val) =>
                setValues((prev) => ({ ...prev, [field.name]: val }))
              }
              connectionType={app.connectionType}
              autoFocus={
                prefilled ? field.secret === true : !nameFirst && i === 0
              }
            />
          ))}
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger
              type="button"
              className="group flex min-h-11 w-full items-center gap-2.5 text-xs text-muted-foreground dark:text-foreground/70 transition-colors hover:text-foreground"
            >
              <div className="bg-border h-px flex-1" />
              <span className="flex items-center gap-1">
                <ChevronRight
                  aria-hidden="true"
                  className="size-3 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                />
                Advanced
              </span>
              <div className="bg-border h-px flex-1" />
            </CollapsibleTrigger>
            <CollapsibleContent className="overflow-hidden motion-safe:data-[state=closed]:animate-collapsible-up motion-safe:data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
              <div className="mt-4 space-y-5">
                {!nameFirst && labelField}
                {advancedFields.map((field) => (
                  <FieldInput
                    key={field.name}
                    field={field}
                    value={values[field.name] ?? ""}
                    onChange={(val) => {
                      setValues((prev) => ({ ...prev, [field.name]: val }));
                      // The SSL-off message tells the user to change TLS;
                      // once they do, it no longer describes the form.
                      if (
                        field.name === "sslmode" &&
                        testError?.code === "SERVER_NO_TLS"
                      ) {
                        setError(null);
                        setTestError(null);
                      }
                    }}
                    connectionType={app.connectionType}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </fieldset>
        {error &&
          (testError?.code === "SERVER_NO_TLS" ? (
            // A server setting to change, not a failure: the same amber
            // view, with the SSL guide, as the connection card shows.
            <div tabIndex={-1} ref={focusFeedback}>
              <ConnectionTestResult pending={false} error={testError} />
            </div>
          ) : (
            <div
              role="alert"
              tabIndex={-1}
              ref={focusFeedback}
              className="space-y-1 text-sm text-destructive dark:text-destructive-foreground break-words"
            >
              <p>{error}</p>
              <p>Review the connection details above, then save and retry.</p>
            </div>
          ))}
        <Button
          type="submit"
          aria-live="polite"
          className="min-h-11 w-full"
          loading={busy}
          disabled={!hasInput || busy}
        >
          {progressLabel ??
            (submitting
              ? onSaved
                ? "Saving connection…"
                : "Connecting…"
              : error
                ? "Save and retry"
                : `Connect ${app.name}`)}
        </Button>
        {alternateGroup && (
          <p className="text-center text-xs text-muted-foreground dark:text-foreground/70">
            <button
              type="button"
              disabled={busy}
              className="underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60"
              onClick={() => {
                setActiveGroup(alternateGroup);
                setValues(initialValues(fields));
              }}
            >
              Use {groupLabel(alternateGroup)} instead
            </button>
          </p>
        )}
        {onBack && (
          <p className="text-center text-xs text-muted-foreground dark:text-foreground/70">
            <button
              type="button"
              disabled={busy}
              className="underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60"
              onClick={onBack}
            >
              Use OAuth instead
            </button>
          </p>
        )}
      </form>
    </ConnectLayout>
  );
};
