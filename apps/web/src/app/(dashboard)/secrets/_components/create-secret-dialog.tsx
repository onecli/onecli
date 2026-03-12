"use client";

import { useState } from "react";
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
import { useAuth } from "@/providers/auth-provider";
import { createSecret } from "@/lib/actions/secrets";

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

interface CreateSecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export const CreateSecretDialog = ({
  open,
  onOpenChange,
  onCreated,
}: CreateSecretDialogProps) => {
  const { user } = useAuth();
  const [step, setStep] = useState<"type" | "form">("type");
  const [creating, setCreating] = useState(false);

  const [type, setType] = useState<SecretType>("anthropic");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [hostPattern, setHostPattern] = useState("api.anthropic.com");
  const [pathPattern, setPathPattern] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [valueFormat, setValueFormat] = useState("Bearer {value}");

  const resetForm = () => {
    setStep("type");
    setType("anthropic");
    setName("");
    setValue("");
    setHostPattern("api.anthropic.com");
    setPathPattern("");
    setHeaderName("Authorization");
    setValueFormat("Bearer {value}");
  };

  const handleSelectType = (selected: SecretType) => {
    setType(selected);
    const option = SECRET_TYPE_OPTIONS.find((o) => o.value === selected);
    setHostPattern(option?.hostDefault ?? "");
    setStep("form");
  };

  const handleBack = () => {
    setStep("type");
  };

  const isValid =
    name.trim() &&
    value.trim() &&
    hostPattern.trim() &&
    (type !== "generic" || headerName.trim());

  const handleCreate = async () => {
    if (!user?.id || !isValid) return;
    setCreating(true);
    try {
      await createSecret(
        {
          name,
          type,
          value,
          hostPattern,
          pathPattern: pathPattern || undefined,
          injectionConfig:
            type === "generic"
              ? { headerName, valueFormat: valueFormat || "{value}" }
              : null,
        },
        user.id,
      );
      onCreated();
      toast.success("Secret created");
      handleClose(false);
    } catch {
      toast.error("Failed to create secret");
    } finally {
      setCreating(false);
    }
  };

  const handleClose = (open: boolean) => {
    if (!open) resetForm();
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        {step === "type" ? (
          <TypeStep onSelect={handleSelectType} />
        ) : (
          <FormStep
            type={type}
            name={name}
            value={value}
            hostPattern={hostPattern}
            pathPattern={pathPattern}
            headerName={headerName}
            valueFormat={valueFormat}
            isValid={!!isValid}
            creating={creating}
            onNameChange={setName}
            onValueChange={setValue}
            onHostPatternChange={setHostPattern}
            onPathPatternChange={setPathPattern}
            onHeaderNameChange={setHeaderName}
            onValueFormatChange={setValueFormat}
            onBack={handleBack}
            onCancel={() => handleClose(false)}
            onCreate={handleCreate}
          />
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

interface FormStepProps {
  type: SecretType;
  name: string;
  value: string;
  hostPattern: string;
  pathPattern: string;
  headerName: string;
  valueFormat: string;
  isValid: boolean;
  creating: boolean;
  onNameChange: (v: string) => void;
  onValueChange: (v: string) => void;
  onHostPatternChange: (v: string) => void;
  onPathPatternChange: (v: string) => void;
  onHeaderNameChange: (v: string) => void;
  onValueFormatChange: (v: string) => void;
  onBack: () => void;
  onCancel: () => void;
  onCreate: () => void;
}

const FormStep = ({
  type,
  name,
  value,
  hostPattern,
  pathPattern,
  headerName,
  valueFormat,
  isValid,
  creating,
  onNameChange,
  onValueChange,
  onHostPatternChange,
  onPathPatternChange,
  onHeaderNameChange,
  onValueFormatChange,
  onBack,
  onCancel,
  onCreate,
}: FormStepProps) => {
  const typeOption = SECRET_TYPE_OPTIONS.find((o) => o.value === type)!;

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground -ml-1 rounded-md p-1 transition-colors"
          >
            <ArrowLeft className="size-4" />
          </button>
          <DialogTitle>{typeOption.label}</DialogTitle>
        </div>
        <DialogDescription>
          {type === "anthropic"
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
            onChange={(e) => onNameChange(e.target.value)}
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="secret-value">Secret value</Label>
          <Input
            id="secret-value"
            type="password"
            placeholder={
              type === "anthropic" ? "sk-ant-api03-..." : "Enter secret value"
            }
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
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
              onChange={(e) => onHostPatternChange(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              The host this secret applies to. Use{" "}
              <code className="text-xs">*.example.com</code> for wildcard
              subdomains.
            </p>
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
                      onChange={(e) => onHostPatternChange(e.target.value)}
                    />
                    <p className="text-muted-foreground text-xs">
                      The host this secret applies to. Use{" "}
                      <code className="text-xs">*.example.com</code> for
                      wildcard subdomains.
                    </p>
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
                    onChange={(e) => onPathPatternChange(e.target.value)}
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
                        onChange={(e) => onHeaderNameChange(e.target.value)}
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
                        onChange={(e) => onValueFormatChange(e.target.value)}
                      />
                      <p className="text-muted-foreground text-xs">
                        Use <code className="text-xs">{"{value}"}</code> as a
                        placeholder for the secret. Defaults to the raw value.
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
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onCreate} loading={creating} disabled={!isValid}>
          {creating ? "Creating..." : "Add Secret"}
        </Button>
      </DialogFooter>
    </>
  );
};

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
            ? "bg-emerald-500 size-1.5 rounded-full"
            : "bg-blue-500 size-1.5 rounded-full"
        }
      />
      {detected === "api_key" ? "API Key" : "OAuth Token"}
    </Badge>
  );
};
