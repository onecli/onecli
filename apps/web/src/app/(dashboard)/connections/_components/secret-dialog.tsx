"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { toast } from "sonner";
import { ArrowLeft, Key, Settings2 } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
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
import { SecretInput } from "@/components/secret-input";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@onecli/ui/components/accordion";
import { Badge } from "@onecli/ui/components/badge";
import { createSecret, updateSecret } from "@/lib/actions/secrets";
import { validateDisplayName } from "@/lib/validations/display-name";
import {
  type InjectionConfig,
  detectAnthropicAuthMode,
  isHeaderInjection,
  isParamInjection,
  looksLikeAnthropicKey,
  looksLikeOpenaiKey,
} from "@/lib/validations/secret";

type SecretType = "anthropic" | "openai" | "generic";

interface SecretTypeOption {
  value: SecretType;
  label: string;
  description: string;
  icon: React.ReactNode;
  hostDefault: string;
  nameDefault: string;
}

const AnthropicIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 300 300"
    fill="currentColor"
    className={className}
  >
    <path d="m172.36 49.15 80.42 201.7h44.1L216.46 49.15h-44.1Z" />
    <path d="m79.07 171.03 27.52-70.88 27.51 70.88H79.07ZM83.53 49.15 3.13 250.85h44.96l16.44-42.36h84.12l16.44 42.36h44.96L129.64 49.15H83.53Z" />
  </svg>
);

const OpenAIIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
  >
    <path d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z" />
  </svg>
);

const SECRET_TYPE_OPTIONS: SecretTypeOption[] = [
  {
    value: "anthropic",
    label: "Anthropic API Key",
    description: "Inject your Anthropic key into requests to api.anthropic.com",
    icon: <AnthropicIcon className="size-5" />,
    hostDefault: "api.anthropic.com",
    nameDefault: "Anthropic Token",
  },
  {
    value: "openai",
    label: "OpenAI API Key",
    description: "Inject your OpenAI key into requests to api.openai.com",
    icon: <OpenAIIcon className="size-5" />,
    hostDefault: "api.openai.com",
    nameDefault: "OpenAI Token",
  },
  {
    value: "generic",
    label: "Generic Secret",
    description:
      "Inject a custom header or URL parameter into matching requests",
    icon: <Key className="size-5" />,
    hostDefault: "",
    nameDefault: "",
  },
];

export interface SecretItem {
  id: string;
  name: string;
  type: string;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  isPlatform: boolean;
}

export interface SecretPrefill {
  type: SecretType;
  hostPattern: string;
  name: string;
  pathPattern?: string;
  headerName?: string;
  valueFormat?: string;
  paramName?: string;
  paramFormat?: string;
}

interface SecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** Pass an existing secret to edit. Omit for create mode. */
  secret?: SecretItem;
  /** Pre-populate fields and skip type selection step. */
  prefill?: SecretPrefill;
  /** When set, skip type selection and use this type directly for new secrets. */
  defaultType?: SecretType;
  /** Filter which types appear in TypeStep. */
  allowedTypes?: SecretType[];
}

export const SecretDialog = ({
  open,
  onOpenChange,
  onSaved,
  secret,
  prefill,
  defaultType,
  allowedTypes,
}: SecretDialogProps) => {
  const isEdit = !!secret;
  const invalidateCache = useInvalidateGatewayCache();
  const valueInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"type" | "form">("type");
  const [saving, setSaving] = useState(false);

  const [type, setType] = useState<SecretType>("anthropic");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [value, setValue] = useState("");
  const [hostPattern, setHostPattern] = useState("api.anthropic.com");
  const [pathPattern, setPathPattern] = useState("");
  const [injectionTarget, setInjectionTarget] = useState<"header" | "param">(
    "header",
  );
  const [headerName, setHeaderName] = useState("Authorization");
  const [valueFormat, setValueFormat] = useState("Bearer {value}");
  const [paramName, setParamName] = useState("");
  const [paramFormat, setParamFormat] = useState("");

  const nameError = useMemo(() => validateDisplayName(name), [name]);
  const showNameError = nameTouched && nameError !== null;
  const isNameValid = name.trim().length > 0 && nameError === null;

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

  // When opening, populate from secret (edit), prefill (create with defaults), or reset (create)
  useEffect(() => {
    if (open) {
      setNameTouched(false);
      if (secret) {
        const config = secret.injectionConfig as InjectionConfig | null;
        setStep("form");
        setType(secret.type as SecretType);
        setName(secret.name);
        setValue("");
        setHostPattern(secret.hostPattern);
        setPathPattern(secret.pathPattern ?? "");
        if (isParamInjection(config)) {
          setInjectionTarget("param");
          setParamName(config.paramName);
          setParamFormat(config.paramFormat ?? "");
          setHeaderName("Authorization");
          setValueFormat("Bearer {value}");
        } else if (isHeaderInjection(config)) {
          setInjectionTarget("header");
          setHeaderName(config.headerName);
          setValueFormat(config.valueFormat ?? "Bearer {value}");
          setParamName("");
          setParamFormat("");
        } else {
          setInjectionTarget("header");
          setHeaderName("Authorization");
          setValueFormat("Bearer {value}");
          setParamName("");
          setParamFormat("");
        }
      } else if (prefill) {
        const isParam = !!prefill.paramName;
        setStep("form");
        setType(prefill.type);
        setName(prefill.name);
        setValue("");
        setHostPattern(prefill.hostPattern);
        setPathPattern(prefill.pathPattern ?? "");
        setInjectionTarget(isParam ? "param" : "header");
        setHeaderName(prefill.headerName ?? "Authorization");
        setValueFormat(prefill.valueFormat ?? "Bearer {value}");
        setParamName(prefill.paramName ?? "");
        setParamFormat(prefill.paramFormat ?? "");
        setTimeout(() => valueInputRef.current?.focus(), 100);
      } else if (defaultType) {
        const option = SECRET_TYPE_OPTIONS.find((o) => o.value === defaultType);
        setStep("form");
        setType(defaultType);
        setName(option?.nameDefault ?? "");
        setValue("");
        setHostPattern(option?.hostDefault ?? "");
        setPathPattern("");
        setInjectionTarget("header");
        setHeaderName("Authorization");
        setValueFormat("Bearer {value}");
        setParamName("");
        setParamFormat("");
      } else {
        setStep("type");
        setType("anthropic");
        setName("");
        setValue("");
        setHostPattern("api.anthropic.com");
        setPathPattern("");
        setInjectionTarget("header");
        setHeaderName("Authorization");
        setValueFormat("Bearer {value}");
        setParamName("");
        setParamFormat("");
      }
    }
  }, [open, secret, prefill, defaultType]);

  const handleSelectType = (selected: SecretType) => {
    setType(selected);
    const option = SECRET_TYPE_OPTIONS.find((o) => o.value === selected);
    setHostPattern(option?.hostDefault ?? "");
    setName(option?.nameDefault ?? "");
    setStep("form");
  };

  const hasInjectionTarget =
    type !== "generic" ||
    (injectionTarget === "header" ? headerName.trim() : paramName.trim());

  const isPlatformEdit = isEdit && secret?.isPlatform;
  const isValid = isPlatformEdit
    ? !!value.trim()
    : isEdit
      ? hostPattern.trim() && !hostPatternError && hasInjectionTarget
      : isNameValid &&
        value.trim() &&
        hostPattern.trim() &&
        !hostPatternError &&
        hasInjectionTarget;

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    try {
      const buildInjectionConfig = () => {
        if (type !== "generic") return undefined;
        if (injectionTarget === "param") {
          return { paramName, paramFormat: paramFormat || "{value}" };
        }
        return { headerName, valueFormat: valueFormat || "{value}" };
      };

      if (isEdit) {
        await updateSecret(
          secret.id,
          secret.isPlatform
            ? { value: value.trim() }
            : {
                name: name !== secret.name ? name : undefined,
                value: value.trim() || undefined,
                hostPattern,
                pathPattern: pathPattern || null,
                injectionConfig: buildInjectionConfig() ?? undefined,
              },
        );
        toast.success("Secret updated");
      } else {
        await createSecret({
          name,
          type,
          value,
          hostPattern,
          pathPattern: pathPattern || undefined,
          injectionConfig: buildInjectionConfig() ?? null,
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
      <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-2rem)] grid-rows-[auto_1fr_auto]">
        {step === "type" && !isEdit ? (
          <TypeStep onSelect={handleSelectType} allowedTypes={allowedTypes} />
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                {!isEdit && !defaultType && (
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
                {isPlatformEdit
                  ? "Replace the trial key with your own Anthropic key to continue using Claude."
                  : isEdit
                    ? "Update the secret\u2019s configuration. Leave the value field empty to keep the current value."
                    : type === "anthropic"
                      ? "Your key will be encrypted and injected into requests to api.anthropic.com."
                      : type === "openai"
                        ? "Your key will be encrypted and injected into requests to api.openai.com."
                        : "Configure a custom secret to inject as a header or URL parameter into matching requests."}
              </DialogDescription>
              {type === "generic" && !isEdit && !prefill && (
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-muted-foreground text-xs">
                    Try an example:
                  </span>
                  <button
                    type="button"
                    className="text-xs text-green-600 hover:text-green-500 underline underline-offset-2 transition-colors dark:text-green-400 dark:hover:text-green-300"
                    onClick={() => {
                      setName("GitHub Token");
                      setHostPattern("api.github.com");
                      setInjectionTarget("header");
                      setHeaderName("Authorization");
                      setValueFormat("Bearer {value}");
                    }}
                  >
                    Header injection
                  </button>
                  <span className="text-muted-foreground text-xs">|</span>
                  <button
                    type="button"
                    className="text-xs text-green-600 hover:text-green-500 underline underline-offset-2 transition-colors dark:text-green-400 dark:hover:text-green-300"
                    onClick={() => {
                      setName("Google Maps Key");
                      setHostPattern("maps.googleapis.com");
                      setInjectionTarget("param");
                      setParamName("key");
                      setParamFormat("{value}");
                    }}
                  >
                    URL parameter
                  </button>
                </div>
              )}
            </DialogHeader>

            <div className="min-h-0 space-y-4 overflow-y-auto py-2">
              {!isPlatformEdit && (
                <div className="space-y-2">
                  <Label htmlFor="secret-name">Name</Label>
                  <Input
                    id="secret-name"
                    placeholder={
                      type === "anthropic"
                        ? "e.g. Anthropic Production Key"
                        : type === "openai"
                          ? "e.g. OpenAI Production Key"
                          : "e.g. GitHub Token"
                    }
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => setNameTouched(true)}
                    autoFocus
                    className={cn(showNameError && "border-destructive")}
                  />
                  {showNameError && (
                    <p className="text-destructive text-xs">{nameError}</p>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="secret-value">
                  {isPlatformEdit
                    ? "Your API key"
                    : isEdit
                      ? "New value"
                      : "Secret value"}{" "}
                  {isEdit && !isPlatformEdit && (
                    <span className="text-muted-foreground font-normal">
                      (leave empty to keep current)
                    </span>
                  )}
                </Label>
                <SecretInput
                  ref={valueInputRef}
                  id="secret-value"
                  placeholder={
                    type === "anthropic"
                      ? "sk-ant-api03-..."
                      : type === "openai"
                        ? "sk-proj-..."
                        : "Enter secret value"
                  }
                  value={value}
                  onChange={(e) => {
                    const val = e.target.value;
                    setValue(val);
                    if (type === "anthropic" && !name.trim()) {
                      const detected = detectAnthropicAuthMode(val);
                      if (detected === "api-key") setName("Anthropic API Key");
                      else if (detected === "oauth")
                        setName("Anthropic OAuth Token");
                    }
                    if (type === "openai" && !name.trim()) {
                      if (looksLikeOpenaiKey(val)) setName("OpenAI API Key");
                    }
                  }}
                />
                <div className="flex items-center gap-2">
                  {type === "anthropic" &&
                  value.trim() &&
                  !looksLikeAnthropicKey(value) ? (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {detectAnthropicAuthMode(value) !== null ? (
                        "This key looks incomplete. Make sure you copied the full value."
                      ) : (
                        <>
                          Keys typically start with{" "}
                          <code className="text-[11px]">sk-ant-api</code> or{" "}
                          <code className="text-[11px]">sk-ant-oat</code>
                        </>
                      )}
                    </p>
                  ) : type === "openai" &&
                    value.trim() &&
                    !looksLikeOpenaiKey(value) ? (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {value.startsWith("sk-ant-") ? (
                        "This looks like an Anthropic key, not an OpenAI key."
                      ) : value.startsWith("sk-") ? (
                        "This key looks incomplete. Make sure you copied the full value."
                      ) : (
                        <>
                          Keys typically start with{" "}
                          <code className="text-[11px]">sk-proj-</code> or{" "}
                          <code className="text-[11px]">sk-</code>
                        </>
                      )}
                    </p>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      {type === "anthropic"
                        ? "Paste your API key or OAuth token from the Anthropic Console."
                        : type === "openai"
                          ? "Paste your API key from the OpenAI Dashboard."
                          : "Encrypted at rest. You won\u2019t be able to view this value again."}
                    </p>
                  )}
                  {type === "anthropic" && <AnthropicKeyBadge value={value} />}
                </div>
              </div>

              {type === "generic" && !prefill && (
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

              {type === "generic" && (
                <div className="flex items-center gap-3">
                  <Label
                    id="inject-as-label"
                    className="text-muted-foreground shrink-0 text-xs"
                  >
                    Inject as
                  </Label>
                  <div
                    className="border-input inline-flex overflow-hidden rounded-md border"
                    role="radiogroup"
                    aria-labelledby="inject-as-label"
                    onKeyDown={(e) => {
                      if (
                        ![
                          "ArrowRight",
                          "ArrowDown",
                          "ArrowLeft",
                          "ArrowUp",
                        ].includes(e.key)
                      )
                        return;
                      e.preventDefault();
                      const next =
                        injectionTarget === "header" ? "param" : "header";
                      setInjectionTarget(next);
                      e.currentTarget
                        .querySelectorAll<HTMLButtonElement>('[role="radio"]')
                        [next === "header" ? 0 : 1]?.focus();
                    }}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={injectionTarget === "header"}
                      tabIndex={injectionTarget === "header" ? 0 : -1}
                      className={cn(
                        "border-input px-3 py-1.5 text-xs font-medium transition-colors",
                        injectionTarget === "header"
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      onClick={() => setInjectionTarget("header")}
                    >
                      Header
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={injectionTarget === "param"}
                      tabIndex={injectionTarget === "param" ? 0 : -1}
                      className={cn(
                        "border-input border-l px-3 py-1.5 text-xs font-medium transition-colors",
                        injectionTarget === "param"
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      onClick={() => setInjectionTarget("param")}
                    >
                      URL Parameter
                    </button>
                  </div>
                </div>
              )}

              {type === "generic" && (
                <div
                  key={`name-${injectionTarget}`}
                  className="animate-in fade-in duration-150 space-y-2"
                >
                  <Label
                    htmlFor={
                      injectionTarget === "header"
                        ? "secret-header"
                        : "secret-param"
                    }
                  >
                    {injectionTarget === "header"
                      ? "Header name"
                      : "Parameter name"}
                  </Label>
                  <Input
                    id={
                      injectionTarget === "header"
                        ? "secret-header"
                        : "secret-param"
                    }
                    placeholder={
                      injectionTarget === "header"
                        ? "e.g. Authorization"
                        : "e.g. api_key"
                    }
                    value={
                      injectionTarget === "header" ? headerName : paramName
                    }
                    onChange={(e) =>
                      injectionTarget === "header"
                        ? setHeaderName(e.target.value)
                        : setParamName(e.target.value)
                    }
                  />
                </div>
              )}

              {isPlatformEdit ? null : (
                <Accordion
                  type="single"
                  collapsible
                  className="border-none"
                  defaultValue={undefined}
                >
                  <AccordionItem
                    value="advanced"
                    className="border-t border-b-0"
                  >
                    <AccordionTrigger className="py-3 hover:no-underline">
                      <span className="text-muted-foreground flex items-center gap-2 text-xs font-normal">
                        <Settings2 className="size-3.5" />
                        Advanced settings
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="pb-0">
                      <div className="space-y-4">
                        {(type !== "generic" || !!prefill) && (
                          <div className="space-y-2">
                            <Label htmlFor="secret-host">Host pattern</Label>
                            <Input
                              id="secret-host"
                              placeholder="e.g. api.example.com or *.example.com"
                              value={hostPattern}
                              onChange={(e) => setHostPattern(e.target.value)}
                              disabled={!!prefill}
                            />
                            {hostPatternError ? (
                              <p className="text-xs text-red-500">
                                {hostPatternError}
                              </p>
                            ) : (
                              <p className="text-muted-foreground text-xs">
                                The host this secret applies to. Use{" "}
                                <code className="text-xs">*.example.com</code>{" "}
                                for wildcard subdomains.
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
                          <div
                            key={`format-${injectionTarget}`}
                            className="animate-in fade-in duration-150 space-y-2"
                          >
                            <Label
                              htmlFor={
                                injectionTarget === "header"
                                  ? "secret-format"
                                  : "secret-param-format"
                              }
                            >
                              Value format{" "}
                              <span className="text-muted-foreground font-normal">
                                (optional)
                              </span>
                            </Label>
                            <Input
                              id={
                                injectionTarget === "header"
                                  ? "secret-format"
                                  : "secret-param-format"
                              }
                              placeholder={
                                injectionTarget === "header"
                                  ? "e.g. Bearer {value}"
                                  : "e.g. {value}"
                              }
                              value={
                                injectionTarget === "header"
                                  ? valueFormat
                                  : paramFormat
                              }
                              onChange={(e) =>
                                injectionTarget === "header"
                                  ? setValueFormat(e.target.value)
                                  : setParamFormat(e.target.value)
                              }
                            />
                            <p className="text-muted-foreground text-xs">
                              Use <code className="text-xs">{"{value}"}</code>{" "}
                              as a placeholder for the secret. Defaults to the
                              raw value.
                            </p>
                          </div>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
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

const TypeStep = ({
  onSelect,
  allowedTypes,
}: {
  onSelect: (type: SecretType) => void;
  allowedTypes?: SecretType[];
}) => {
  const options = allowedTypes
    ? SECRET_TYPE_OPTIONS.filter((o) => allowedTypes.includes(o.value))
    : SECRET_TYPE_OPTIONS;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add secret</DialogTitle>
        <DialogDescription>
          Choose the type of credential to store.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 py-2">
        {options.map((option) => (
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
};

const AnthropicKeyBadge = ({ value }: { value: string }) => {
  const detected = detectAnthropicAuthMode(value);
  if (!detected) return null;

  return (
    <Badge
      variant="outline"
      className="text-muted-foreground animate-in fade-in shrink-0 gap-1.5 text-[10px] font-normal"
    >
      <span
        className={
          detected === "api-key"
            ? "bg-brand size-1.5 rounded-full"
            : "bg-blue-500 size-1.5 rounded-full"
        }
      />
      {detected === "api-key" ? "API Key" : "OAuth Token"}
    </Badge>
  );
};
