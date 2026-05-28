"use client";

import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { SecretInput } from "@/components/secret-input";
import { apiFetch } from "@/lib/api-fetch";
import { ConnectLayout } from "./connect-layout";

interface FileImportConfig {
  label: string;
  accept: string;
  keyMap: Record<string, string>;
}

interface CredentialsFlowField {
  name: string;
  label: string;
  description?: string;
  placeholder: string;
  secret?: boolean;
  optional?: boolean;
  group?: string;
}

export interface CredentialsFlowProps {
  app: {
    id: string;
    name: string;
    icon: string;
    darkIcon?: string;
    connectionType: string;
    labelHint?: string;
  };
  fields: CredentialsFlowField[];
  fileImport?: FileImportConfig;
  connectionId?: string;
  preContent?: ReactNode;
  hiddenFields?: Record<string, string>;
  onSuccess: () => void;
  onError: (message: string) => void;
  projectId?: string;
  orgId?: string;
}

export const CredentialsFlow = ({
  app,
  fields,
  fileImport,
  connectionId,
  preContent,
  hiddenFields,
  onSuccess,
  onError,
  projectId,
  orgId,
}: CredentialsFlowProps) => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [connectionLabel, setConnectionLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasGroups = fields.some((f) => f.group);
  const groups = hasGroups
    ? [...new Set(fields.filter((f) => f.group).map((f) => f.group!))]
    : [];
  const [activeGroup, setActiveGroup] = useState<string | null>(
    groups[0] ?? null,
  );

  const allVisibleFields = hasGroups
    ? fields.filter((f) => !f.group || f.group === activeGroup)
    : fields;

  const visibleFields = allVisibleFields.filter((f) => !f.optional);
  const advancedFields = allVisibleFields.filter((f) => f.optional);

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !fileImport) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string) as Record<
          string,
          unknown
        >;
        const mapped: Record<string, string> = {};
        for (const [jsonKey, fieldName] of Object.entries(fileImport.keyMap)) {
          const val = json[jsonKey];
          if (typeof val === "string" && val) {
            mapped[fieldName] = val;
          }
        }

        if (hasGroups && typeof json.type === "string") {
          const detectedGroup = groups.find((g) => g === json.type);
          if (detectedGroup) {
            setActiveGroup(detectedGroup);
          }
        }

        setValues(mapped);
      } catch {
        onError("Invalid JSON file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const switchGroup = (group: string) => {
    setActiveGroup(group);
    setValues({});
  };

  const hasInput = visibleFields.every((f) => !!values[f.name]?.trim());

  const handleSubmit = async () => {
    if (!hasInput) return;
    setSubmitting(true);
    try {
      const resp = await apiFetch(`/v1/apps/${app.id}/connect`, {
        method: "POST",
        body: JSON.stringify({
          fields: { ...values, ...hiddenFields },
          connectionId,
          ...(connectionLabel.trim() ? { label: connectionLabel.trim() } : {}),
        }),
        headers: {
          ...(projectId ? { "X-Project-Id": projectId } : {}),
          ...(orgId ? { "X-Organization-Id": orgId } : {}),
        },
      });
      if (!resp.ok) {
        const data = (await resp.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to connect");
      }
      onSuccess();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setSubmitting(false);
    }
  };

  const alternateGroup =
    hasGroups && groups.length > 1
      ? groups.find((g) => g !== activeGroup)
      : null;

  const groupLabel = (group: string) => {
    if (group === "service_account") return "service account key";
    if (group === "authorized_user") return "user credentials";
    return group;
  };

  return (
    <ConnectLayout
      appName={app.name}
      appIcon={app.icon}
      appDarkIcon={app.darkIcon}
    >
      <div className="space-y-5 py-2">
        {preContent}
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
                variant="outline"
                className="w-full"
                onClick={() => fileInputRef.current?.click()}
              >
                {fileImport.label}
              </Button>
            </div>
            <div className="flex items-center gap-3">
              <div className="bg-border h-px flex-1" />
              <span className="text-muted-foreground/60 text-[10px] uppercase tracking-widest">
                or fill manually
              </span>
              <div className="bg-border h-px flex-1" />
            </div>
          </>
        )}
        {visibleFields.map((field, i) => (
          <FieldInput
            key={field.name}
            field={field}
            value={values[field.name] ?? ""}
            onChange={(val) =>
              setValues((prev) => ({ ...prev, [field.name]: val }))
            }
            connectionType={app.connectionType}
            autoFocus={i === 0}
          />
        ))}
        <Collapsible>
          <CollapsibleTrigger className="group flex w-full items-center gap-2.5 text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground">
            <div className="bg-border h-px flex-1" />
            <span className="flex items-center gap-1">
              <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
              Advanced
            </span>
            <div className="bg-border h-px flex-1" />
          </CollapsibleTrigger>
          <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
            <div className="mt-4 space-y-5">
              <div className="grid gap-1.5">
                <Label htmlFor="connect-label">Connection label</Label>
                <Input
                  id="connect-label"
                  type="text"
                  value={connectionLabel}
                  onChange={(e) => setConnectionLabel(e.target.value)}
                  placeholder={
                    app.labelHint?.replace(/^e\.g\.\s*/, "") ||
                    "personal, work…"
                  }
                  className="text-sm"
                />
                <p className="text-[11px] text-muted-foreground/60">
                  Optional - helps identify this account when you have multiple
                  connections.
                </p>
              </div>
              {advancedFields.map((field) => (
                <FieldInput
                  key={field.name}
                  field={field}
                  value={values[field.name] ?? ""}
                  onChange={(val) =>
                    setValues((prev) => ({ ...prev, [field.name]: val }))
                  }
                  connectionType={app.connectionType}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
        <Button
          className="w-full"
          onClick={handleSubmit}
          loading={submitting}
          disabled={!hasInput}
        >
          {submitting ? "Connecting..." : `Connect ${app.name}`}
        </Button>
        {alternateGroup && (
          <p className="text-center text-xs text-muted-foreground">
            <button
              type="button"
              className="underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60"
              onClick={() => switchGroup(alternateGroup)}
            >
              Use {groupLabel(alternateGroup)} instead
            </button>
          </p>
        )}
      </div>
    </ConnectLayout>
  );
};

const FieldInput = ({
  field,
  value,
  onChange,
  connectionType,
  autoFocus,
}: {
  field: CredentialsFlowField;
  value: string;
  onChange: (value: string) => void;
  connectionType: string;
  autoFocus?: boolean;
}) => (
  <div className="grid gap-1.5">
    <Label htmlFor={`connect-${field.name}`}>
      {field.label}
      {!field.optional && <span className="text-destructive ml-0.5">*</span>}
    </Label>
    {field.description && (
      <p className="text-xs text-muted-foreground">{field.description}</p>
    )}
    {field.secret === true ||
    (field.secret === undefined && connectionType === "api_key") ? (
      <SecretInput
        id={`connect-${field.name}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        autoFocus={autoFocus}
      />
    ) : (
      <Input
        id={`connect-${field.name}`}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className="font-mono text-sm"
        autoFocus={autoFocus}
      />
    )}
  </div>
);
