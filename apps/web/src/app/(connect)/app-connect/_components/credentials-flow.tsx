"use client";

import { useRef, useState } from "react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
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
  group?: string;
}

export interface CredentialsFlowProps {
  app: {
    id: string;
    name: string;
    icon: string;
    darkIcon?: string;
    connectionType: string;
  };
  fields: CredentialsFlowField[];
  fileImport?: FileImportConfig;
  connectionId?: string;
  onSuccess: () => void;
  onError: (message: string) => void;
}

export const CredentialsFlow = ({
  app,
  fields,
  fileImport,
  connectionId,
  onSuccess,
  onError,
}: CredentialsFlowProps) => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasGroups = fields.some((f) => f.group);
  const groups = hasGroups
    ? [...new Set(fields.filter((f) => f.group).map((f) => f.group!))]
    : [];
  const [activeGroup, setActiveGroup] = useState<string | null>(
    groups[0] ?? null,
  );

  const visibleFields = hasGroups
    ? fields.filter((f) => !f.group || f.group === activeGroup)
    : fields;

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
      const resp = await fetch(`/api/apps/${app.id}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: values, connectionId }),
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
          <div key={field.name} className="grid gap-1.5">
            <Label htmlFor={`connect-${field.name}`}>
              {field.label}
              <span className="text-destructive ml-0.5">*</span>
            </Label>
            {field.description && (
              <p className="text-xs text-muted-foreground">
                {field.description}
              </p>
            )}
            <Input
              id={`connect-${field.name}`}
              type={
                field.secret === true ||
                (field.secret === undefined && app.connectionType === "api_key")
                  ? "password"
                  : "text"
              }
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
