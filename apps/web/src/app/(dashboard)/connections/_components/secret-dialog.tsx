"use client";

import { useState, useEffect } from "react";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { toast } from "sonner";
import { ArrowLeft, Bot, Key, Settings2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@onecli/ui/components/accordion";
import { Badge } from "@onecli/ui/components/badge";
import { createSecret, updateSecret } from "@/lib/actions/secrets";

const detectAnthropicKeyType = (
  val: string,
): "api_key" | "oauth_token" | null => {
  if (val.startsWith("sk-ant-api")) return "api_key";
  if (val.startsWith("sk-ant-oat")) return "oauth_token";
  return null;
};

type SecretType = "anthropic" | "generic";

interface SecretTypeOption {
  value: SecretType;
  label: string;
  description: string;
  icon: React.ReactNode;
  hostDefault: string;
}

const SECRET_TYPE_OPTIONS: SecretTypeOption[] = [
  {
    value: "anthropic",
    label: "Anthropic API Key",
    description: "Inject your Anthropic key into requests to api.anthropic.com",
    icon: <Bot className="size-5" />,
    hostDefault: "api.anthropic.com",
  },
  {
    value: "generic",
    label: "Generic Secret",
    description: "Inject a custom header into requests matching any host",
    icon: <Key className="size-5" />,
    hostDefault: "",
  },
];

interface InjectionConfig {
  headerName: string;
  valueFormat: string;
}

export interface SecretItem {
  id: string;
  name: string;
  type: string;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
}

interface SecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** Pass an existing secret to edit. Omit for create mode. */
  secret?: SecretItem;
}

export const SecretDialog = ({
  open,
  onOpenChange,
  onSaved,
  secret,
}: SecretDialogProps) => {
  const isEdit = !!secret;
  const invalidateCache = useInvalidateGatewayCache();
  const [step, setStep] = useState<"type" | "form">("type");
  const [saving, setSaving] = useState(false);

  const [type, setType] = useState<SecretType>("anthropic");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [hostPattern, setHostPattern] = useState("api.anthropic.com");
  const [pathPattern, setPathPattern] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [valueFormat, setValueFormat] = useState("Bearer {value}");

  // Inline validation for host pattern
  const hostPatternError = (() => {
    const v = hostPattern.trim();
    if (!v) return null;
    if (v.includes("://"))
      return "Enter a hostname, not a URL (remove http:// or https://)";
    if (v.includes("/"))
      return "Enter a hostname only (use the path pattern field for paths)";
    if (v.includes(" ")) return "Hostname must not contain spaces";
    return null;
  })();

  // When opening, populate from secret (edit) or reset (create)
  useEffect(() => {
    if (open) {
      if (secret) {
        const config = secret.injectionConfig as InjectionConfig | null;
        setStep("form");
        setType(secret.type as SecretType);
        setName(secret.name);
        setValue("");
        setHostPattern(secret.hostPattern);
        setPathPattern(secret.pathPattern ?? "");
        setHeaderName(config?.headerName ?? "Authorization");
        setValueFormat(config?.valueFormat ?? "Bearer {value}");
      } else {
        setStep("type");
        setType("anthropic");
        setName("");
        setValue("");
        setHostPattern("api.anthropic.com");
        setPathPattern("");
        setHeaderName("Authorization");
        setValueFormat("Bearer {value}");
      }
    }
  }, [open, secret]);

  const handleSelectType = (selected: SecretType) => {
    setType(selected);
    const option = SECRET_TYPE_OPTIONS.find((o) => o.value === selected);
    setHostPattern(option?.hostDefault ?? "");
    setStep("form");
  };

  const isValid = isEdit
    ? hostPattern.trim() &&
      !hostPatternError &&
      (type !== "generic" || headerName.trim())
    : name.trim() &&
      value.trim() &&
      hostPattern.trim() &&
      !hostPatternError &&
      (type !== "generic" || headerName.trim());

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    try {
      if (isEdit) {
        await updateSecret(secret.id, {
          name: name !== secret.name ? name : undefined,
          value: value.trim() || undefined,
          hostPattern,
          pathPattern: pathPattern || null,
          injectionConfig:
            type === "generic"
              ? { headerName, valueFormat: valueFormat || "{value}" }
              : undefined,
        });
        toast.success("Secret updated");
      } else {
        await createSecret({
          name,
          type,
          value,
          hostPattern,
          pathPattern: pathPattern || undefined,
          injectionConfig:
            type === "generic"
              ? { headerName, valueFormat: valueFormat || "{value}" }
              : null,
        });
        toast.success("Secret created");
      }
      onSaved();
      onOpenChange(false);
      invalidateCache();
    } catch {
      toast.error(
        isEdit ? "Failed to update secret" : "Failed to create secret",
      );
    } finally {
      setSaving(false);
    }
  };

  const typeOption = SECRET_TYPE_OPTIONS.find((o) => o.value === type)!;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {step === "type" && !isEdit ? (
          <TypeStep onSelect={handleSelectType} />
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                {!isEdit && (
                  <button
                    onClick={() => setStep("type")}
                    className="text-muted-foreground hover:text-foreground -ml-1 rounded-md p-1 transition-colors"
                  >
                    <ArrowLeft className="size-4" />
                  </button>
                )}
                <DialogTitle>
                  {isEdit ? `Edit ${secret.name}` : typeOption.label}
                </DialogTitle>
              </div>
              <DialogDescription>
                {isEdit
                  ? "Update the secret\u2019s configuration. Leave the value field empty to keep the current value."
                  : type === "anthropic"
                    ? "Your key will be encrypted and injected into requests to api.anthropic.com."
                    : "Configure a custom secret to inject as a header into matching requests."}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="secret-name">Name</Label>
                <Input
                  id="secret-name"
                  placeholder={
                    type === "anthropic"
                      ? "e.g. Anthropic Production Key"
                      : "e.g. GitHub Token"
                  }
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="secret-value">
                  {isEdit ? "New value" : "Secret value"}{" "}
                  {isEdit && (
                    <span className="text-muted-foreground font-normal">
                      (leave empty to keep current)
                    </span>
                  )}
                </Label>
                <Input
                  id="secret-value"
                  type="password"
                  placeholder={
                    type === "anthropic"
                      ? "sk-ant-api03-..."
                      : "Enter secret value"
                  }
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                <div className="flex items-center gap-2">
                  <p className="text-muted-foreground text-xs">
                    {type === "anthropic"
                      ? "Paste your API key or OAuth token from the Anthropic Console."
                      : "Encrypted at rest. You won\u2019t be able to view this value again."}
                  </p>
                  {type === "anthropic" && <AnthropicKeyBadge value={value} />}
                </div>
              </div>

              {type === "generic" && (
                <div className="space-y-2">
                  <Label htmlFor="secret-host">Host pattern</Label>
                  <Input
                    id="secret-host"
                    placeholder="e.g. api.example.com or *.example.com"
                    value={hostPattern}
                    onChange={(e) => setHostPattern(e.target.value)}
                  />
                  {hostPatternError ? (
                    <p className="text-xs text-red-500">{hostPatternError}</p>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      The host this secret applies to. Use{" "}
                      <code className="text-xs">*.example.com</code> for
                      wildcard subdomains.
                    </p>
                  )}
                </div>
              )}

              <Accordion type="single" collapsible className="border-none">
                <AccordionItem value="advanced" className="border-t border-b-0">
                  <AccordionTrigger className="py-3 hover:no-underline">
                    <span className="text-muted-foreground flex items-center gap-2 text-xs font-normal">
                      <Settings2 className="size-3.5" />
                      Injection settings
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="pb-0">
                    <div className="space-y-4">
                      {type === "anthropic" && (
                        <div className="space-y-2">
                          <Label htmlFor="secret-host">Host pattern</Label>
                          <Input
                            id="secret-host"
                            placeholder="e.g. api.example.com or *.example.com"
                            value={hostPattern}
                            onChange={(e) => setHostPattern(e.target.value)}
                          />
                          {hostPatternError ? (
                            <p className="text-xs text-red-500">
                              {hostPatternError}
                            </p>
                          ) : (
                            <p className="text-muted-foreground text-xs">
                              The host this secret applies to. Use{" "}
                              <code className="text-xs">*.example.com</code> for
                              wildcard subdomains.
                            </p>
                          )}
                        </div>
                      )}

                      <div className="space-y-2">
                        <Label htmlFor="secret-path">
                          Path pattern{" "}
                          <span className="text-muted-foreground font-normal">
                            (optional)
                          </span>
                        </Label>
                        <Input
                          id="secret-path"
                          placeholder="e.g. /v1/*"
                          value={pathPattern}
                          onChange={(e) => setPathPattern(e.target.value)}
                        />
                      </div>

                      {type === "generic" && (
                        <>
                          <div className="space-y-2">
                            <Label htmlFor="secret-header">Header name</Label>
                            <Input
                              id="secret-header"
                              placeholder="e.g. Authorization"
                              value={headerName}
                              onChange={(e) => setHeaderName(e.target.value)}
                            />
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="secret-format">
                              Value format{" "}
                              <span className="text-muted-foreground font-normal">
                                (optional)
                              </span>
                            </Label>
                            <Input
                              id="secret-format"
                              placeholder="e.g. Bearer {value}"
                              value={valueFormat}
                              onChange={(e) => setValueFormat(e.target.value)}
                            />
                            <p className="text-muted-foreground text-xs">
                              Use <code className="text-xs">{"{value}"}</code>{" "}
                              as a placeholder for the secret. Defaults to the
                              raw value.
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} loading={saving} disabled={!isValid}>
                {saving
                  ? isEdit
                    ? "Saving..."
                    : "Creating..."
                  : isEdit
                    ? "Save Changes"
                    : "Add Secret"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

const TypeStep = ({ onSelect }: { onSelect: (type: SecretType) => void }) => (
  <>
    <DialogHeader>
      <DialogTitle>Add secret</DialogTitle>
      <DialogDescription>
        Choose the type of credential to store.
      </DialogDescription>
    </DialogHeader>

    <div className="grid gap-3 py-2">
      {SECRET_TYPE_OPTIONS.map((option) => (
        <button
          key={option.value}
          onClick={() => onSelect(option.value)}
          className="border-border hover:border-foreground/20 hover:bg-muted/50 flex items-start gap-4 rounded-lg border p-4 text-left transition-colors"
        >
          <div className="bg-muted text-muted-foreground mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-md">
            {option.icon}
          </div>
          <div className="space-y-1">
            <div className="text-sm font-medium">{option.label}</div>
            <div className="text-muted-foreground text-xs">
              {option.description}
            </div>
          </div>
        </button>
      ))}
    </div>
  </>
);

const AnthropicKeyBadge = ({ value }: { value: string }) => {
  const detected = detectAnthropicKeyType(value);
  if (!detected) return null;

  return (
    <Badge
      variant="outline"
      className="text-muted-foreground animate-in fade-in shrink-0 gap-1.5 text-[10px] font-normal"
    >
      <span
        className={
          detected === "api_key"
            ? "bg-brand size-1.5 rounded-full"
            : "bg-blue-500 size-1.5 rounded-full"
        }
      />
      {detected === "api_key" ? "API Key" : "OAuth Token"}
    </Badge>
  );
};
