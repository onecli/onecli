"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import Image from "next/image";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { toast } from "sonner";
import { ArrowLeft, Copy, Key, Settings2, Upload, X } from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { SecretInput } from "@/components/secret-input";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@onecli/ui/components/accordion";
import { Badge } from "@onecli/ui/components/badge";
import { updateSecret as defaultUpdateSecret } from "@/lib/actions/secrets";
import { useQueryClient } from "@tanstack/react-query";
import { secrets } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { CreateSecretInput } from "@onecli/api/validations/secret";
import type { SecretActions } from "./types";
import {
  OnePasswordPickerDialog,
  type OpDisplay,
  type OpSelection,
} from "./onepassword-picker-dialog";
import { useOnePasswordReady } from "@/hooks/use-onepassword-picker";
import { validateDisplayName } from "@onecli/api/validations/display-name";
import {
  type InjectionConfig,
  GOOGLE_SA_DEFAULT_HOST,
  detectAnthropicAuthMode,
  isHeaderInjection,
  isParamInjection,
  isPathRegexInjection,
  isPathTemplateInjection,
  looksLikeAnthropicKey,
  looksLikeOpenaiKey,
  parseGoogleServiceAccountJson,
  parseOpenaiAuthJson,
} from "@onecli/api/validations/secret";

type SecretType = "anthropic" | "openai" | "generic" | "google_service_account";

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

const GoogleIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
  >
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
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
    label: "OpenAI",
    description:
      "Inject an API key or Codex OAuth credentials into requests to OpenAI",
    icon: <OpenAIIcon className="size-5" />,
    hostDefault: "api.openai.com",
    nameDefault: "OpenAI Token",
  },
  {
    value: "google_service_account",
    label: "Google Service Account",
    description:
      "Inject a Google SA Bearer token into requests to googleapis.com",
    icon: <GoogleIcon className="size-5" />,
    hostDefault: GOOGLE_SA_DEFAULT_HOST,
    nameDefault: "Google Service Account",
  },
  {
    value: "generic",
    label: "Generic Secret",
    description:
      "Inject a custom header, URL parameter, or URL path into matching requests",
    icon: <Key className="size-5" />,
    hostDefault: "",
    nameDefault: "",
  },
];

const PATH_PREVIEW_MASK = "••••••";
const PATH_PREVIEW_FILLER = "<token>";

/**
 * Build a masked before/after preview of a path-injection rewrite for the
 * dialog. Mirrors the gateway's substitution shape without revealing the secret:
 * template mode shows the request path with the `{value}` slot filled; regex mode
 * shows the pattern and the masked replacement.
 */
const buildPathPreview = (
  mode: "template" | "regex",
  template: string,
  regex: string,
  replacement: string,
): { before: string; after: string } | null => {
  if (mode === "template") {
    if (!template.includes("{value}")) return null;
    const [prefix, suffix = ""] = template.split("{value}");
    const tail = suffix || "/…";
    return {
      before: `${prefix}${PATH_PREVIEW_FILLER}${tail}`,
      after: `${prefix}${PATH_PREVIEW_MASK}${tail}`,
    };
  }
  if (!regex.trim() || !replacement.includes("{value}")) return null;
  return {
    before: regex,
    after: replacement.replaceAll("{value}", PATH_PREVIEW_MASK),
  };
};

export interface SecretItem {
  id: string;
  name: string;
  type: string;
  valueSource?: string;
  opRef?: string | null;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  metadata: Record<string, unknown> | null;
}

/** Recover readable picker titles for an existing 1Password-sourced secret. */
const readOpDisplay = (
  metadata: Record<string, unknown> | null,
  opRef: string,
): OpDisplay => {
  const d = metadata?.opDisplay as Partial<OpDisplay> | undefined;
  if (d?.vault && d?.item && d?.field) {
    return { vault: d.vault, item: d.item, field: d.field };
  }
  // Fallback to the raw reference IDs so something still renders.
  const [vault = "1Password", item = "", field = ""] = opRef
    .replace("op://", "")
    .split("/");
  return { vault, item, field };
};

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
  onSaved?: () => void;
  /** Pass an existing secret to edit. Omit for create mode. */
  secret?: SecretItem;
  /** Pre-populate fields and skip type selection step. */
  prefill?: SecretPrefill;
  /** When set, skip type selection and use this type directly for new secrets. */
  defaultType?: SecretType;
  /** Filter which types appear in TypeStep. */
  allowedTypes?: SecretType[];
  secretActions?: SecretActions;
}

export const SecretDialog = ({
  open,
  onOpenChange,
  onSaved,
  secret,
  prefill,
  defaultType,
  allowedTypes,
  secretActions,
}: SecretDialogProps) => {
  const isEdit = !!secret;
  const invalidateCache = useInvalidateGatewayCache();
  const queryClient = useQueryClient();
  const valueInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"type" | "form">("type");
  const [saving, setSaving] = useState(false);

  const [type, setType] = useState<SecretType>("anthropic");
  const [openaiMode, setOpenaiMode] = useState<"api-key" | "codex">("api-key");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saFileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [value, setValue] = useState("");
  const [hostPattern, setHostPattern] = useState("api.anthropic.com");
  const [pathPattern, setPathPattern] = useState("");
  const [injectionTarget, setInjectionTarget] = useState<
    "header" | "param" | "path"
  >("header");
  const [headerName, setHeaderName] = useState("Authorization");
  const [valueFormat, setValueFormat] = useState("Bearer {value}");
  const [paramName, setParamName] = useState("");
  const [paramFormat, setParamFormat] = useState("");
  const [pathMode, setPathMode] = useState<"template" | "regex">("template");
  const [pathTemplate, setPathTemplate] = useState("");
  const [pathRegex, setPathRegex] = useState("");
  const [pathReplacement, setPathReplacement] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState("");
  const [opSelection, setOpSelection] = useState<OpSelection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Only poll 1Password connectivity while the dialog is open; deduped across
  // every mounted SecretDialog via the shared query key.
  const { isReady: opConnected } = useOnePasswordReady(open);

  // The value source is implied by whether a 1Password field is chosen — no
  // separate mode toggle. OAuth file upload only applies to a typed OpenAI
  // secret; a 1Password value is always a raw API key.
  const fromOnePassword = !!opSelection;
  const isOAuthMode =
    type === "openai" && openaiMode === "codex" && !fromOnePassword;

  const isGoogleSA = type === "google_service_account";
  const parsedSA = useMemo(
    () =>
      isGoogleSA && value.trim()
        ? parseGoogleServiceAccountJson(value.trim())
        : null,
    [isGoogleSA, value],
  );

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
      setAdvancedOpen("");
      setOpenaiMode("api-key");
      setOpSelection(null);
      setPickerOpen(false);
      // Path-injection fields reset here; only the edit branches below repopulate
      // them, so every other branch leaves them at these defaults.
      setPathMode("template");
      setPathTemplate("");
      setPathRegex("");
      setPathReplacement("");
      if (secret) {
        const config = secret.injectionConfig as InjectionConfig | null;
        setStep("form");
        setType(secret.type as SecretType);
        if (secret.type === "openai" && secret.metadata?.authMode === "oauth")
          setOpenaiMode("codex");
        if (secret.valueSource === "onepassword" && secret.opRef) {
          setOpSelection({
            opRef: secret.opRef,
            opDisplay: readOpDisplay(secret.metadata, secret.opRef),
          });
        }
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
        } else if (isPathTemplateInjection(config)) {
          setInjectionTarget("path");
          setPathMode("template");
          setPathTemplate(config.pathTemplate);
          setHeaderName("Authorization");
          setValueFormat("Bearer {value}");
          setParamName("");
          setParamFormat("");
        } else if (isPathRegexInjection(config)) {
          setInjectionTarget("path");
          setPathMode("regex");
          setPathRegex(config.pathRegex);
          setPathReplacement(config.pathReplacement);
          setHeaderName("Authorization");
          setValueFormat("Bearer {value}");
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
        setType(prefill.type as SecretType);
        if (prefill.type === "openai") setOpenaiMode("codex");
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
    if (selected === "google_service_account") {
      setOpSelection(null);
      setValue("");
    }
    setStep("form");
  };

  const hasPathTarget =
    pathMode === "template"
      ? pathTemplate.startsWith("/") &&
        pathTemplate.split("{value}").length === 2
      : pathRegex.trim().length > 0 && pathReplacement.includes("{value}");

  const hasInjectionTarget =
    type !== "generic" ||
    (injectionTarget === "header"
      ? headerName.trim().length > 0
      : injectionTarget === "param"
        ? paramName.trim().length > 0
        : hasPathTarget);

  const saValueValid = !isGoogleSA || !value.trim() || !!parsedSA;

  const pathPreview = useMemo(
    () =>
      injectionTarget === "path"
        ? buildPathPreview(pathMode, pathTemplate, pathRegex, pathReplacement)
        : null,
    [injectionTarget, pathMode, pathTemplate, pathRegex, pathReplacement],
  );

  const isValid = isEdit
    ? hostPattern.trim() &&
      !hostPatternError &&
      hasInjectionTarget &&
      saValueValid
    : isNameValid &&
      ((!isGoogleSA && fromOnePassword) || !!value.trim()) &&
      hostPattern.trim() &&
      !hostPatternError &&
      hasInjectionTarget &&
      saValueValid;

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    try {
      const buildInjectionConfig = () => {
        if (type !== "generic") return null;
        if (injectionTarget === "param") {
          return { paramName, paramFormat: paramFormat || "{value}" };
        }
        if (injectionTarget === "path") {
          return pathMode === "template"
            ? { pathTemplate }
            : { pathRegex, pathReplacement };
        }
        return { headerName, valueFormat: valueFormat || "{value}" };
      };

      const updateSecret = secretActions?.updateSecret ?? defaultUpdateSecret;
      const createSecret =
        secretActions?.createSecret ??
        ((input: unknown) => secrets.create(input as CreateSecretInput));

      if (isEdit) {
        await updateSecret(secret.id, {
          name: name !== secret.name ? name : undefined,
          ...(opSelection
            ? {
                valueSource: "onepassword" as const,
                opRef: opSelection.opRef,
                opDisplay: opSelection.opDisplay,
              }
            : value.trim()
              ? { valueSource: "inline" as const, value: value.trim() }
              : {}),
          hostPattern,
          pathPattern: pathPattern || null,
          injectionConfig: buildInjectionConfig() ?? undefined,
        });
        toast.success("Secret updated");
      } else {
        await createSecret(
          opSelection
            ? {
                name,
                type,
                valueSource: "onepassword",
                opRef: opSelection.opRef,
                opDisplay: opSelection.opDisplay,
                hostPattern,
                pathPattern: pathPattern || undefined,
                injectionConfig: buildInjectionConfig() ?? null,
              }
            : {
                name,
                type,
                value,
                hostPattern,
                pathPattern: pathPattern || undefined,
                injectionConfig: buildInjectionConfig() ?? null,
              },
        );
        toast.success("Secret created");
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
      onSaved?.();
      onOpenChange(false);
      invalidateCache();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : isEdit
            ? "Failed to update secret"
            : "Failed to create secret",
      );
    } finally {
      setSaving(false);
    }
  };

  const typeOption = SECRET_TYPE_OPTIONS.find((o) => o.value === type)!;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const contents = (ev.target?.result as string)?.trim();
      if (!contents) return;
      const detected = parseOpenaiAuthJson(contents);
      if (!detected) {
        toast.error(
          "Invalid auth.json — must contain tokens.access_token/refresh_token or OPENAI_API_KEY",
        );
        return;
      }
      if (detected.mode === "api-key" && detected.apiKey) {
        setValue(detected.apiKey);
        setOpenaiMode("api-key");
        setHostPattern("api.openai.com");
        if (!name.trim()) setName("OpenAI API Key");
      } else {
        setValue(contents);
        setOpenaiMode("codex");
        setHostPattern("chatgpt.com");
        if (!name.trim()) setName("Codex Token");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleSaFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const contents = (ev.target?.result as string)?.trim();
      if (!contents) return;
      const sa = parseGoogleServiceAccountJson(contents);
      if (!sa) {
        toast.error(
          'Invalid service account JSON — must contain type "service_account", private_key, and client_email',
        );
        return;
      }
      setValue(contents);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

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
                {isEdit
                  ? "Update the secret\u2019s configuration. Leave the value field empty to keep the current value."
                  : type === "anthropic"
                    ? "Your key will be encrypted and injected into requests to api.anthropic.com."
                    : type === "openai"
                      ? `Inject credentials into requests to ${openaiMode === "codex" ? "chatgpt.com" : "api.openai.com"}.`
                      : isGoogleSA
                        ? "Upload a service account JSON key. The gateway will sign JWTs and inject Bearer tokens automatically."
                        : "Configure a custom secret to inject as a header, URL parameter, or URL path into matching requests."}
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
                      setAdvancedOpen("advanced");
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
                      setAdvancedOpen("advanced");
                    }}
                  >
                    URL parameter
                  </button>
                  <span className="text-muted-foreground text-xs">|</span>
                  <button
                    type="button"
                    className="text-xs text-green-600 hover:text-green-500 underline underline-offset-2 transition-colors dark:text-green-400 dark:hover:text-green-300"
                    onClick={() => {
                      setName("Telegram Bot Token");
                      setHostPattern("api.telegram.org");
                      setInjectionTarget("path");
                      setPathMode("template");
                      setPathTemplate("/bot{value}");
                      setAdvancedOpen("advanced");
                    }}
                  >
                    URL path
                  </button>
                </div>
              )}
            </DialogHeader>

            <div className="min-h-0 space-y-4 overflow-y-auto py-2">
              {type === "openai" && !isEdit && !fromOnePassword && (
                <div className="space-y-2">
                  <div
                    className="flex w-full items-center gap-1 rounded-lg border p-1"
                    role="radiogroup"
                    aria-label="OpenAI auth method"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={openaiMode === "api-key"}
                      className={cn(
                        "flex-1 rounded-md px-3 py-1 text-sm font-medium transition-colors",
                        openaiMode === "api-key"
                          ? "bg-brand/10 text-brand"
                          : "text-muted-foreground hover:bg-brand/5 hover:text-brand/80",
                      )}
                      onClick={() => {
                        setOpenaiMode("api-key");
                        setName("OpenAI Token");
                        setHostPattern("api.openai.com");
                        setValue("");
                      }}
                    >
                      API Key
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={openaiMode === "codex"}
                      className={cn(
                        "flex-1 rounded-md px-3 py-1 text-sm font-medium transition-colors",
                        openaiMode === "codex"
                          ? "bg-brand/10 text-brand"
                          : "text-muted-foreground hover:bg-brand/5 hover:text-brand/80",
                      )}
                      onClick={() => {
                        setOpenaiMode("codex");
                        setName("Codex Token");
                        setHostPattern("chatgpt.com");
                        setValue("");
                      }}
                    >
                      Codex (OAuth)
                    </button>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {openaiMode === "api-key" ? (
                      <>
                        Paste your API key from{" "}
                        <a
                          href="https://platform.openai.com/api-keys"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground underline underline-offset-2"
                        >
                          platform.openai.com
                        </a>
                        .{" "}
                        <a
                          href="https://onecli.sh/docs/integrations/openai#setup-api-key"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground underline underline-offset-2"
                        >
                          Setup guide
                        </a>
                      </>
                    ) : (
                      <>
                        Run{" "}
                        <code className="bg-muted rounded px-1 py-0.5 text-[11px]">
                          codex login --device-auth
                        </code>{" "}
                        and upload the auth.json file.{" "}
                        <a
                          href="https://onecli.sh/docs/integrations/openai#setup-codex-oauth"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground underline underline-offset-2"
                        >
                          Setup guide
                        </a>
                      </>
                    )}
                  </p>
                </div>
              )}

              {type === "openai" && isEdit && isOAuthMode && (
                <p className="text-muted-foreground text-xs">
                  Run{" "}
                  <code className="bg-muted rounded px-1 py-0.5 text-[11px]">
                    codex login --device-auth
                  </code>{" "}
                  and upload the auth.json file.{" "}
                  <a
                    href="https://onecli.sh/docs/integrations/openai#setup-codex-oauth"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground underline underline-offset-2"
                  >
                    Setup guide
                  </a>
                </p>
              )}

              <div className="space-y-2">
                <Label htmlFor="secret-name">Name</Label>
                <Input
                  id="secret-name"
                  placeholder={
                    type === "anthropic"
                      ? "e.g. Anthropic Production Key"
                      : isOAuthMode
                        ? "e.g. Codex Personal"
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

              <div className="space-y-2">
                <Label htmlFor="secret-value">
                  {isGoogleSA ? (
                    "Service account JSON key"
                  ) : isOAuthMode ? (
                    <>
                      Token file{" "}
                      <code className="bg-muted text-muted-foreground ml-1 select-all rounded px-1.5 py-0.5 text-xs font-normal">
                        ~/.codex/auth.json
                      </code>
                    </>
                  ) : isEdit ? (
                    "New value"
                  ) : (
                    "Secret value"
                  )}{" "}
                  {isEdit &&
                    !isGoogleSA &&
                    !isOAuthMode &&
                    !fromOnePassword && (
                      <span className="text-muted-foreground font-normal">
                        (leave empty to keep current)
                      </span>
                    )}
                </Label>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleFileUpload}
                />
                <input
                  ref={saFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleSaFileUpload}
                />

                {opSelection ? (
                  <OnePasswordSelectedField
                    display={opSelection.opDisplay}
                    onChange={() => setPickerOpen(true)}
                    onClear={() => setOpSelection(null)}
                  />
                ) : isGoogleSA ? (
                  <>
                    <textarea
                      id="secret-value"
                      className={cn(
                        "border-input bg-background placeholder:text-muted-foreground flex min-h-[120px] w-full rounded-md border px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        value.trim() && !parsedSA && "border-destructive",
                      )}
                      placeholder="Paste your service account JSON key or upload the .json file..."
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs transition-colors"
                        onClick={() => saFileInputRef.current?.click()}
                      >
                        <Upload className="size-3" />
                        Upload .json file
                      </button>
                    </div>
                    {value.trim() && !parsedSA && (
                      <p className="text-xs text-red-500">
                        Invalid JSON — must contain{" "}
                        <code className="text-[11px]">
                          type: &quot;service_account&quot;
                        </code>
                        , <code className="text-[11px]">private_key</code>, and{" "}
                        <code className="text-[11px]">client_email</code>.
                      </p>
                    )}
                    {parsedSA && (
                      <div className="bg-muted/40 space-y-1 rounded-md border p-3">
                        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                          Detected
                        </span>
                        <div className="space-y-0.5 text-xs">
                          <div>
                            <span className="text-muted-foreground">
                              Email:{" "}
                            </span>
                            <code className="text-foreground">
                              {parsedSA.client_email}
                            </code>
                          </div>
                          {parsedSA.project_id && (
                            <div>
                              <span className="text-muted-foreground">
                                Project:{" "}
                              </span>
                              <code className="text-foreground">
                                {parsedSA.project_id}
                              </code>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    <p className="text-muted-foreground text-xs">
                      MVP: Drive read-only access (drive.readonly). Broader
                      scopes coming soon.
                    </p>
                  </>
                ) : isOAuthMode ? (
                  <>
                    {value ? (
                      <div className="border-brand/30 bg-brand/5 flex items-center justify-between rounded-md border px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="bg-brand/10 flex size-6 items-center justify-center rounded-full">
                            <Upload className="text-brand size-3" />
                          </div>
                          <span className="text-sm font-medium">auth.json</span>
                        </div>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground shrink-0 text-xs transition-colors"
                          onClick={() => setValue("")}
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="border-input hover:border-brand/30 hover:bg-brand/5 flex w-full items-center gap-3 rounded-md border border-dashed px-4 py-3.5 transition-colors"
                      >
                        <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full">
                          <Upload className="text-muted-foreground size-4" />
                        </div>
                        <span className="text-sm font-medium">
                          Upload auth.json
                        </span>
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
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
                              if (detected === "api-key")
                                setName("Anthropic API Key");
                              else if (detected === "oauth")
                                setName("Anthropic OAuth Token");
                            }
                            if (type === "openai" && !name.trim()) {
                              if (looksLikeOpenaiKey(val))
                                setName("OpenAI API Key");
                            }
                          }}
                        />
                      </div>
                      {opConnected && (
                        <OnePasswordPickerButton
                          onClick={() => setPickerOpen(true)}
                        />
                      )}
                    </div>
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
                          {type === "anthropic" ? (
                            "Paste your API key or OAuth token from the Anthropic Console."
                          ) : type === "openai" ? (
                            <>
                              Paste your API key, or{" "}
                              <button
                                type="button"
                                className="text-foreground underline underline-offset-2"
                                onClick={() => fileInputRef.current?.click()}
                              >
                                upload auth.json
                              </button>
                            </>
                          ) : (
                            "Encrypted at rest. You won\u2019t be able to view this value again."
                          )}
                        </p>
                      )}
                      {type === "anthropic" && (
                        <AnthropicKeyBadge value={value} />
                      )}
                    </div>
                  </>
                )}
              </div>

              <OnePasswordPickerDialog
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                onSelect={(selection) => {
                  setOpSelection(selection);
                  setPickerOpen(false);
                  if (type === "openai") {
                    setOpenaiMode("api-key");
                    setHostPattern("api.openai.com");
                  }
                }}
              />

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

              <Accordion
                type="single"
                collapsible
                className="border-none"
                value={advancedOpen}
                onValueChange={setAdvancedOpen}
              >
                <AccordionItem value="advanced" className="border-t border-b-0">
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

                      {injectionTarget !== "path" && (
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
                              const order = [
                                "header",
                                "param",
                                "path",
                              ] as const;
                              const delta =
                                e.key === "ArrowRight" || e.key === "ArrowDown"
                                  ? 1
                                  : -1;
                              const nextIdx =
                                (order.indexOf(injectionTarget) +
                                  delta +
                                  order.length) %
                                order.length;
                              const next = order[nextIdx];
                              if (!next) return;
                              setInjectionTarget(next);
                              e.currentTarget
                                .querySelectorAll<HTMLButtonElement>(
                                  '[role="radio"]',
                                )
                                [nextIdx]?.focus();
                            }}
                          >
                            {(
                              [
                                ["header", "Header"],
                                ["param", "URL Parameter"],
                                ["path", "URL Path"],
                              ] as const
                            ).map(([target, label], i) => (
                              <button
                                key={target}
                                type="button"
                                role="radio"
                                aria-checked={injectionTarget === target}
                                tabIndex={injectionTarget === target ? 0 : -1}
                                className={cn(
                                  "px-3 py-1.5 text-xs font-medium transition-colors",
                                  i > 0 && "border-input border-l",
                                  injectionTarget === target
                                    ? "bg-accent text-foreground"
                                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                )}
                                onClick={() => setInjectionTarget(target)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {type === "generic" && injectionTarget !== "path" && (
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
                              injectionTarget === "header"
                                ? headerName
                                : paramName
                            }
                            onChange={(e) =>
                              injectionTarget === "header"
                                ? setHeaderName(e.target.value)
                                : setParamName(e.target.value)
                            }
                          />
                        </div>
                      )}

                      {type === "generic" && injectionTarget === "path" && (
                        <div className="animate-in fade-in duration-150 space-y-3">
                          <div className="flex items-center gap-3">
                            <Label
                              id="path-mode-label"
                              className="text-muted-foreground shrink-0 text-xs"
                            >
                              Mode
                            </Label>
                            <div
                              className="border-input inline-flex overflow-hidden rounded-md border"
                              role="radiogroup"
                              aria-labelledby="path-mode-label"
                            >
                              {(
                                [
                                  ["template", "Template"],
                                  ["regex", "Regex"],
                                ] as const
                              ).map(([mode, label], i) => (
                                <button
                                  key={mode}
                                  type="button"
                                  role="radio"
                                  aria-checked={pathMode === mode}
                                  className={cn(
                                    "px-3 py-1.5 text-xs font-medium transition-colors",
                                    i > 0 && "border-input border-l",
                                    pathMode === mode
                                      ? "bg-accent text-foreground"
                                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                  )}
                                  onClick={() => setPathMode(mode)}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>

                          {pathMode === "template" ? (
                            <div className="space-y-2">
                              <Label htmlFor="secret-path-template">
                                Path template
                              </Label>
                              <Input
                                id="secret-path-template"
                                className="font-mono"
                                placeholder="/bot{value}"
                                value={pathTemplate}
                                onChange={(e) =>
                                  setPathTemplate(e.target.value)
                                }
                              />
                              <p className="text-muted-foreground text-xs">
                                Put <code className="text-xs">{"{value}"}</code>{" "}
                                where the secret goes. The gateway replaces
                                whatever your agent sends in that spot (up to
                                the next <code className="text-xs">/</code>), so
                                the agent never needs the real secret.
                              </p>
                            </div>
                          ) : (
                            <>
                              <div className="space-y-2">
                                <Label htmlFor="secret-path-regex">
                                  Path pattern (regex)
                                </Label>
                                <Input
                                  id="secret-path-regex"
                                  className="font-mono"
                                  placeholder="^/bot[^/]+(/.*)?$"
                                  value={pathRegex}
                                  onChange={(e) => setPathRegex(e.target.value)}
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="secret-path-replacement">
                                  Replacement
                                </Label>
                                <Input
                                  id="secret-path-replacement"
                                  className="font-mono"
                                  placeholder="/bot{value}$1"
                                  value={pathReplacement}
                                  onChange={(e) =>
                                    setPathReplacement(e.target.value)
                                  }
                                />
                                <p className="text-muted-foreground text-xs">
                                  Use <code className="text-xs">$1</code> for
                                  capture groups and{" "}
                                  <code className="text-xs">{"{value}"}</code>{" "}
                                  for the secret.
                                </p>
                              </div>
                            </>
                          )}

                          {pathPreview && (
                            <div className="bg-muted/40 space-y-1.5 rounded-md border p-3">
                              <div className="flex items-center justify-between">
                                <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                                  Preview
                                </span>
                                {pathMode === "template" && (
                                  <button
                                    type="button"
                                    className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] transition-colors"
                                    onClick={async () => {
                                      const host =
                                        hostPattern
                                          .trim()
                                          .replace(/^\*\./, "") ||
                                        "api.example.com";
                                      try {
                                        await navigator.clipboard.writeText(
                                          `https://${host}${pathPreview.before}`,
                                        );
                                        toast.success("Example call copied");
                                      } catch {
                                        toast.error(
                                          "Couldn't copy to clipboard",
                                        );
                                      }
                                    }}
                                  >
                                    <Copy className="size-3" />
                                    Copy call
                                  </button>
                                )}
                              </div>
                              <div className="space-y-1 font-mono text-xs">
                                <div className="flex gap-2">
                                  <span className="text-muted-foreground w-24 shrink-0">
                                    {pathMode === "template"
                                      ? "Agent sends"
                                      : "Matches"}
                                  </span>
                                  <span className="break-all">
                                    {pathPreview.before}
                                  </span>
                                </div>
                                <div className="flex gap-2">
                                  <span className="text-muted-foreground w-24 shrink-0">
                                    {pathMode === "template"
                                      ? "Gateway sends"
                                      : "Rewrites to"}
                                  </span>
                                  <span className="text-foreground break-all">
                                    {pathPreview.after}
                                  </span>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {type === "generic" && injectionTarget !== "path" && (
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
                            {injectionTarget === "header"
                              ? "Header value"
                              : "Parameter value"}{" "}
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
                            Use <code className="text-xs">{"{value}"}</code> as
                            a placeholder for the secret. Defaults to the raw
                            value.
                          </p>
                        </div>
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

/** Trailing button on the value input that opens the 1Password field picker. */
const OnePasswordPickerButton = ({ onClick }: { onClick: () => void }) => (
  <TooltipProvider delayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onClick}
          aria-label="Use a 1Password field"
          className="size-9 shrink-0 transition-colors hover:border-[#1A8CFF]/40 hover:bg-[#1A8CFF]/5"
        >
          <Image src="/icons/onepassword.svg" alt="" width={20} height={20} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Use a 1Password field</TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

/** Read-only summary shown in place of the input once a 1Password field is chosen. */
const OnePasswordSelectedField = ({
  display,
  onChange,
  onClear,
}: {
  display: OpDisplay;
  onChange: () => void;
  onClear: () => void;
}) => (
  <div className="bg-muted/30 flex items-center justify-between gap-3 rounded-md border px-3 py-2">
    <div className="flex min-w-0 items-center gap-2.5">
      <Image
        src="/icons/onepassword.svg"
        alt="1Password"
        width={30}
        height={30}
        className="shrink-0"
      />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-medium">{display.field}</div>
        <div className="text-muted-foreground truncate font-mono text-xs">
          {display.vault}/{display.item}
        </div>
      </div>
    </div>
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={onChange}
      >
        Change
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={onClear}
        aria-label="Remove 1Password value"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  </div>
);
