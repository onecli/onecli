"use client";

import { useState, useEffect, useRef, useMemo, type RefObject } from "react";
import Image from "next/image";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { toast } from "sonner";
import {
  ArrowLeft,
  CircleHelp,
  Key,
  Lock,
  Route,
  Server,
  Settings2,
  Terminal,
  Upload,
  X,
} from "lucide-react";
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
import { updateSecret as defaultUpdateSecret } from "@/lib/actions/secrets";
import { useQueryClient } from "@tanstack/react-query";
import { secrets, type SavedSecret } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { CreateSecretInput } from "@onecli/api/validations/secret";
import type { SecretActions } from "./types";
import { CopyableCommand } from "./copyable-command";
import { inlineLinkClassName } from "./inline-link";
import { AnthropicKeyBadge } from "./anthropic-key-badge";
import { keyFormatWarning } from "./key-format-warning";
import {
  OnePasswordPickerDialog,
  type OpDisplay,
  type OpSelection,
} from "./onepassword-picker-dialog";
import { useOnePasswordReady } from "@/hooks/use-onepassword-picker";
import { validateDisplayName } from "@onecli/api/validations/display-name";
import {
  DEFAULT_GENERIC_INJECTION,
  buildGenericInjectionConfig,
  injectionFromConfig,
  injectionFromPrefill,
  isGenericInjectionValid,
  isPathLimit,
  type GenericInjection,
} from "./generic-injection";
import { SentAsFields } from "./sent-as-fields";
import { CustomConnectionExamples } from "./custom-connection-examples";
import { OptionalField } from "./optional-field";
import {
  type InjectionConfig,
  detectAnthropicAuthMode,
  looksLikeAnthropicKey,
  looksLikeOpenaiKey,
  parseOpenaiAuthJson,
} from "@onecli/api/validations/secret";

type SecretType =
  | "anthropic"
  | "openai"
  | "opencode-go"
  | "openrouter"
  | "local"
  | "generic";

/** The docs guide behind the Anthropic dialog's "Need help?" link. */
const ANTHROPIC_SETUP_GUIDE_URL =
  "https://onecli.sh/docs/integrations/anthropic";

/** How long the focus handoff below waits after open or the type→form step.
 * Exported so tests can let it land before they interact. */
export const FOCUS_HANDOFF_MS = 100;

/**
 * Hand focus to an input once it exists — the value input when the name
 * arrives pre-filled (the VALUE is the missing piece), the name input when
 * it doesn't. The delay outruns Radix's open-autofocus and the type→form
 * re-render (the input may not be in the DOM at call time); the
 * optional-chained ref makes a post-close timer a no-op.
 */
const focusInputSoon = (ref: RefObject<HTMLInputElement | null>) => {
  setTimeout(() => ref.current?.focus(), FOCUS_HANDOFF_MS);
};

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
    label: "Anthropic",
    description:
      "Inject a Claude subscription token or API key into requests to api.anthropic.com",
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
    value: "opencode-go",
    label: "OpenCode Go",
    description:
      "Inject an OpenCode Go subscription key into requests to opencode.ai",
    icon: <Terminal className="size-5" />,
    hostDefault: "opencode.ai",
    nameDefault: "OpenCode Go Token",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "Inject an OpenRouter API key into requests to openrouter.ai",
    icon: <Route className="size-5" />,
    hostDefault: "openrouter.ai",
    nameDefault: "OpenRouter Token",
  },
  {
    value: "local",
    label: "Local (OpenAI-compatible)",
    description:
      "Point at a local OpenAI-compatible server like Ollama or LM Studio",
    icon: <Server className="size-5" />,
    // The host is derived from the Base URL, never asked for separately.
    hostDefault: "",
    nameDefault: "Local LLM",
  },
  {
    value: "generic",
    label: "Custom connection",
    description: "Any API with a key: header, URL parameter or path",
    icon: <Key className="size-5" />,
    hostDefault: "",
    nameDefault: "",
  },
];

/**
 * Quick-select endpoints for the `local` type. Each preset with a port/path
 * fills the Base URL from the default localhost host; `custom` leaves the
 * free-text input to the user. A future runtime is a one-line addition here.
 */
const LOCAL_PRESETS = [
  { id: "ollama", label: "Ollama", port: 11434, path: "/v1" },
  { id: "lmstudio", label: "LM Studio", port: 1234, path: "/v1" },
  { id: "custom", label: "Custom" },
] as const;

type LocalPreset = (typeof LOCAL_PRESETS)[number];
type LocalPresetId = LocalPreset["id"];

/** The default Base URL a preset fills — null for the free-text `custom`. */
const presetUrl = (preset: LocalPreset): string | null =>
  "port" in preset ? `http://localhost:${preset.port}${preset.path}` : null;

/** The host the API stores as hostPattern, taken from the Base URL. */
const deriveHost = (baseUrl: string): string => {
  try {
    return new URL(baseUrl.trim()).host;
  } catch {
    return "";
  }
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
  /** After a successful save. Carries the created secret so the caller can
   * act on exactly it (attach it to an agent, open its "choose agents"
   * window); `undefined` after an edit. */
  onSaved?: (created: SavedSecret | undefined) => void;
  /** Pass an existing secret to edit. Omit for create mode. */
  secret?: SecretItem;
  /** Pre-populate fields and skip type selection step. */
  prefill?: SecretPrefill;
  /** When set, skip type selection and use this type directly for new secrets. */
  defaultType?: SecretType;
  /** Filter which types appear in TypeStep. */
  allowedTypes?: SecretType[];
  /** The scope's own create/update (the org pages pass org-level actions);
   * omitted, the dialog writes to the workspace. */
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
  const nameInputRef = useRef<HTMLInputElement>(null);
  const baseUrlInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"type" | "form">("type");
  const [saving, setSaving] = useState(false);

  const [type, setType] = useState<SecretType>("anthropic");
  const [openaiMode, setOpenaiMode] = useState<"api-key" | "codex">("api-key");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [value, setValue] = useState("");
  const [hostPattern, setHostPattern] = useState("api.anthropic.com");
  const [pathPattern, setPathPattern] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [localPreset, setLocalPreset] = useState<LocalPresetId>("custom");
  const [generic, setGeneric] = useState<GenericInjection>(
    DEFAULT_GENERIC_INJECTION,
  );
  const [pathLimitOpen, setPathLimitOpen] = useState(false);
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

  // The amber hint under an LLM key input (null for generic secrets, an empty
  // field, or a value that looks right).
  const formatWarning =
    type === "generic" ? null : keyFormatWarning(type, value);

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

  // The `local` type is validated by its Base URL instead of a host pattern:
  // the host is derived from the URL, so emptiness is caught below and this
  // only reports a malformed value. http/https only, matching the server.
  const baseUrlError = (() => {
    if (type !== "local") return null;
    const v = baseUrl.trim();
    if (!v) return null;
    try {
      const url = new URL(v);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        return "Base URL must start with http:// or https://";
      if (!url.hostname) return "Base URL must include a host";
      return null;
    } catch {
      return "Enter a valid URL, e.g. http://localhost:11434/v1";
    }
  })();
  const hasBaseUrl = baseUrl.trim().length > 0 && baseUrlError === null;

  // When opening, populate from secret (edit), prefill (create with defaults), or reset (create)
  useEffect(() => {
    if (open) {
      setNameTouched(false);
      setAdvancedOpen("");
      setOpenaiMode("api-key");
      setOpSelection(null);
      setPickerOpen(false);
      // Custom-connection injection resets here; only the edit and prefill
      // branches below repopulate it.
      setGeneric(DEFAULT_GENERIC_INJECTION);
      setPathLimitOpen(false);
      setBaseUrl("");
      setLocalPreset("custom");
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
        if (secret.type === "local") {
          const stored = secret.metadata?.baseUrl;
          if (typeof stored === "string") setBaseUrl(stored);
        }
        setPathLimitOpen(isPathLimit(secret.pathPattern));
        setGeneric(injectionFromConfig(config));
      } else if (prefill) {
        setStep("form");
        setType(prefill.type as SecretType);
        if (prefill.type === "openai") setOpenaiMode("codex");
        setName(prefill.name);
        setValue("");
        setHostPattern(prefill.hostPattern);
        setPathPattern(prefill.pathPattern ?? "");
        // The gateway's link always carries `path=/*`, which limits nothing.
        setPathLimitOpen(isPathLimit(prefill.pathPattern));
        setGeneric(injectionFromPrefill(prefill));
        if (prefill.type === "local") focusInputSoon(baseUrlInputRef);
        else focusInputSoon(valueInputRef);
      } else if (defaultType) {
        const option = SECRET_TYPE_OPTIONS.find((o) => o.value === defaultType);
        setStep("form");
        setType(defaultType);
        setName(option?.nameDefault ?? "");
        setValue("");
        setHostPattern(option?.hostDefault ?? "");
        setPathPattern("");
        // No nameDefault (the generic door): the name is the missing piece.
        // On a REOPEN the input mounts with the PREVIOUS session's name still
        // in state (this effect resets it a beat later), so its mount-time
        // autoFocus can compute false — the explicit focus covers that.
        if (defaultType === "local") focusInputSoon(baseUrlInputRef);
        else if (option?.nameDefault) focusInputSoon(valueInputRef);
        else focusInputSoon(nameInputRef);
      } else {
        setStep("type");
        setType("anthropic");
        setName("");
        setValue("");
        setHostPattern("api.anthropic.com");
        setPathPattern("");
      }
    }
  }, [open, secret, prefill, defaultType]);

  const handleSelectType = (selected: SecretType) => {
    setType(selected);
    const option = SECRET_TYPE_OPTIONS.find((o) => o.value === selected);
    setHostPattern(option?.hostDefault ?? "");
    setName(option?.nameDefault ?? "");
    setStep("form");
    if (selected === "local") {
      setBaseUrl("");
      setLocalPreset("custom");
      focusInputSoon(baseUrlInputRef);
    } else if (option?.nameDefault) {
      focusInputSoon(valueInputRef);
    }
  };

  const isGeneric = type === "generic";
  const hasInjectionTarget = !isGeneric || isGenericInjectionValid(generic);

  const isValid = isEdit
    ? (type === "local"
        ? hasBaseUrl
        : hostPattern.trim() && !hostPatternError) && hasInjectionTarget
    : isNameValid &&
      (fromOnePassword || type === "local" || !!value.trim()) &&
      (type === "local"
        ? hasBaseUrl
        : hostPattern.trim() && !hostPatternError) &&
      hasInjectionTarget;

  // A custom connection's path limit is optional, and hidden when the key
  // goes in the URL path (the path template already scopes it) unless the
  // connection being edited already has one. Closed or hidden means no
  // limit, so a value typed before either is never saved.
  const pathLimitHidden =
    isGeneric &&
    generic.sentAs === "path" &&
    !(isEdit && isPathLimit(secret.pathPattern));
  const effectivePathPattern =
    isGeneric && (pathLimitHidden || !pathLimitOpen) ? "" : pathPattern;

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    try {
      const buildInjectionConfig = () =>
        isGeneric ? buildGenericInjectionConfig(generic) : undefined;

      const updateSecret = secretActions?.updateSecret ?? defaultUpdateSecret;
      const createSecret =
        secretActions?.createSecret ??
        ((input: unknown) => secrets.create(input as CreateSecretInput));

      let created: SavedSecret | undefined;
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
          ...(type === "local" && baseUrl.trim()
            ? { baseUrl: baseUrl.trim() }
            : {}),
          hostPattern,
          pathPattern: effectivePathPattern || null,
          injectionConfig: buildInjectionConfig() ?? undefined,
        });
        toast.success(isGeneric ? "Connection updated" : "Secret updated");
      } else {
        const effectiveHostPattern =
          type === "local" ? deriveHost(baseUrl) : hostPattern;
        const { id } = await createSecret(
          opSelection
            ? {
                name,
                type,
                valueSource: "onepassword",
                opRef: opSelection.opRef,
                opDisplay: opSelection.opDisplay,
                ...(type === "local" ? { baseUrl: baseUrl.trim() } : {}),
                hostPattern: effectiveHostPattern,
                pathPattern: effectivePathPattern || undefined,
                injectionConfig: buildInjectionConfig() ?? null,
              }
            : {
                name,
                type,
                ...(type === "local" ? { baseUrl: baseUrl.trim() } : {}),
                ...(type === "local"
                  ? value.trim()
                    ? { value: value.trim() }
                    : {}
                  : { value }),
                hostPattern: effectiveHostPattern,
                pathPattern: effectivePathPattern || undefined,
                injectionConfig: buildInjectionConfig() ?? null,
              },
        );
        created = { id, name };
        toast.success(isGeneric ? "Connection added" : "Secret created");
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
      // Creating a workspace LLM key auto-attaches it to the agents that could
      // reach none, so this is a grant write too: the attach-list and policy
      // views are stale without this.
      queryClient.invalidateQueries({ queryKey: queryKeys.grants.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.policy.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.all() });
      onSaved?.(created);
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
          "Invalid auth.json: must contain tokens.access_token/refresh_token or OPENAI_API_KEY",
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
                {isGeneric
                  ? isEdit
                    ? "Change where it goes, or paste a new API key / Secret."
                    : "Paste an API key / Secret and where it goes."
                  : isEdit
                    ? "Update the secret\u2019s configuration. Leave the value field empty to keep the current value."
                    : type === "anthropic"
                      ? "Your token or key is encrypted and injected into requests to api.anthropic.com."
                      : type === "openai"
                        ? `Inject credentials into requests to ${openaiMode === "codex" ? "chatgpt.com" : "api.openai.com"}.`
                        : type === "opencode-go"
                          ? "Your subscription key is encrypted and injected into requests to opencode.ai."
                          : type === "openrouter"
                            ? "Your API key is encrypted and injected into requests to openrouter.ai."
                            : type === "local"
                              ? "Point the gateway at an OpenAI-compatible server. The key is optional; the host is taken from the Base URL."
                              : "Paste an API key / Secret and where it goes."}
              </DialogDescription>
              {isGeneric && !isEdit && !prefill && (
                <CustomConnectionExamples
                  onPick={(example) => {
                    setName(example.name);
                    setHostPattern(example.hostPattern);
                    setGeneric({
                      ...DEFAULT_GENERIC_INJECTION,
                      ...example.injection,
                    });
                  }}
                />
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
                          className={inlineLinkClassName}
                        >
                          platform.openai.com
                        </a>
                        .{" "}
                        <a
                          href="https://onecli.sh/docs/integrations/openai#setup-api-key"
                          target="_blank"
                          rel="noopener noreferrer"
                          className={inlineLinkClassName}
                        >
                          Setup guide
                        </a>
                      </>
                    ) : (
                      <>
                        Run{" "}
                        <CopyableCommand
                          command="codex login --device-auth"
                          toastMessage="Copied. Run it in your terminal, then upload the auth.json it writes."
                        />{" "}
                        and upload the auth.json file.{" "}
                        <a
                          href="https://onecli.sh/docs/integrations/openai#setup-codex-oauth"
                          target="_blank"
                          rel="noopener noreferrer"
                          className={inlineLinkClassName}
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
                  <CopyableCommand
                    command="codex login --device-auth"
                    toastMessage="Copied. Run it in your terminal, then upload the auth.json it writes."
                  />{" "}
                  and upload the auth.json file.{" "}
                  <a
                    href="https://onecli.sh/docs/integrations/openai#setup-codex-oauth"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={inlineLinkClassName}
                  >
                    Setup guide
                  </a>
                </p>
              )}

              <div className="space-y-2">
                <Label htmlFor="secret-name">Name</Label>
                <Input
                  ref={nameInputRef}
                  id="secret-name"
                  placeholder={
                    type === "anthropic"
                      ? "e.g. Anthropic Production Key"
                      : isOAuthMode
                        ? "e.g. Codex Personal"
                        : type === "openai"
                          ? "e.g. OpenAI Production Key"
                          : type === "opencode-go"
                            ? "e.g. OpenCode Go Subscription"
                            : type === "openrouter"
                              ? "e.g. OpenRouter API Key"
                              : type === "local"
                                ? "e.g. Local Ollama"
                                : "e.g. Airtable"
                  }
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setNameTouched(true)}
                  // Focus lands here only when the name opens EMPTY; a
                  // pre-filled name hands the cursor to the value input (see
                  // the open effect and handleSelectType).
                  autoFocus={!name.trim()}
                  className={cn(showNameError && "border-destructive")}
                />
                {showNameError && (
                  <p className="text-destructive text-xs">{nameError}</p>
                )}
              </div>

              {type === "local" && (
                <div className="space-y-2">
                  <Label htmlFor="secret-base-url">Base URL</Label>
                  <Input
                    ref={baseUrlInputRef}
                    id="secret-base-url"
                    className="font-mono"
                    placeholder="http://localhost:11434/v1"
                    value={baseUrl}
                    onChange={(e) => {
                      const next = e.target.value;
                      setBaseUrl(next);
                      const match = LOCAL_PRESETS.find(
                        (preset) => presetUrl(preset) === next,
                      );
                      setLocalPreset(match?.id ?? "custom");
                    }}
                  />
                  <div
                    className="flex w-full items-center gap-1 rounded-lg border p-1"
                    role="radiogroup"
                    aria-label="Base URL preset"
                  >
                    {LOCAL_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        role="radio"
                        aria-checked={localPreset === preset.id}
                        className={cn(
                          "flex-1 rounded-md px-3 py-1 text-sm font-medium transition-colors",
                          localPreset === preset.id
                            ? "bg-brand/10 text-brand"
                            : "text-muted-foreground hover:bg-brand/5 hover:text-brand/80",
                        )}
                        onClick={() => {
                          setLocalPreset(preset.id);
                          const url = presetUrl(preset);
                          if (url !== null) setBaseUrl(url);
                          baseUrlInputRef.current?.focus();
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  {baseUrlError ? (
                    <p className="text-destructive text-xs">{baseUrlError}</p>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      The OpenAI-compatible endpoint. The host is taken from
                      this URL, so there is no separate host field.
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="secret-value">
                  {isOAuthMode ? (
                    <>
                      Token file{" "}
                      <code className="bg-muted text-muted-foreground ml-1 select-all rounded px-1.5 py-0.5 text-xs font-normal">
                        ~/.codex/auth.json
                      </code>
                    </>
                  ) : isGeneric ? (
                    isEdit ? (
                      "New API key / Secret"
                    ) : (
                      "API key / Secret"
                    )
                  ) : isEdit ? (
                    "New value"
                  ) : type === "local" ? (
                    "API key"
                  ) : (
                    "Secret value"
                  )}{" "}
                  {type === "local" && !isEdit && (
                    <span className="text-muted-foreground font-normal">
                      (optional)
                    </span>
                  )}
                  {isEdit && !isOAuthMode && !fromOnePassword && (
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

                {opSelection ? (
                  <OnePasswordSelectedField
                    display={opSelection.opDisplay}
                    onChange={() => setPickerOpen(true)}
                    onClear={() => setOpSelection(null)}
                  />
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
                              ? "sk-ant-oat01-… or sk-ant-api03-…"
                              : type === "openai"
                                ? "sk-proj-…"
                                : type === "opencode-go"
                                  ? "Paste your OpenCode Go key"
                                  : type === "openrouter"
                                    ? "sk-or-…"
                                    : type === "local"
                                      ? "Optional — only if your server requires one"
                                      : "Paste your API key / Secret"
                          }
                          value={value}
                          onChange={(e) => {
                            const val = e.target.value;
                            setValue(val);
                            if (name.trim()) return;
                            const pasted = val.trim();
                            // Name the key by its kind only once the value is
                            // a complete credential: a half-typed `sk-ant-…`
                            // would read as an API key before the `oat` lands.
                            if (
                              type === "anthropic" &&
                              looksLikeAnthropicKey(pasted)
                            ) {
                              setName(
                                detectAnthropicAuthMode(pasted) === "oauth"
                                  ? "Claude Subscription"
                                  : "Anthropic API Key",
                              );
                            }
                            if (
                              type === "openai" &&
                              looksLikeOpenaiKey(pasted)
                            ) {
                              setName("OpenAI API Key");
                            }
                            if (
                              type === "openrouter" &&
                              !name.trim() &&
                              pasted.startsWith("sk-or-")
                            ) {
                              setName("OpenRouter API Key");
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
                    {/* A stable live region: the amber warning and the kind
                        badge swap in as the user pastes, and a region that
                        mounts with its content isn't reliably announced. */}
                    <div role="status" className="flex items-center gap-2">
                      {formatWarning ? (
                        <p className="min-w-0 text-xs text-amber-600 dark:text-amber-400">
                          {formatWarning}
                        </p>
                      ) : (
                        <p className="text-muted-foreground min-w-0 text-xs">
                          {type === "anthropic" ? (
                            <>
                              From{" "}
                              <CopyableCommand
                                command="claude setup-token"
                                variant="link"
                                tooltip="Run it in a terminal with Claude Code (needs a Pro, Max, Team, or Enterprise plan), approve in the browser, then paste the token it prints. Click to copy."
                                toastMessage="Copied. Run it in your terminal, approve in the browser, then paste the token here."
                              />
                              , or an API key from the{" "}
                              <a
                                href="https://platform.claude.com/settings/keys"
                                target="_blank"
                                rel="noopener noreferrer"
                                className={inlineLinkClassName}
                              >
                                Claude Console
                              </a>
                            </>
                          ) : type === "openai" ? (
                            <>
                              Paste your API key, or{" "}
                              <button
                                type="button"
                                className={inlineLinkClassName}
                                onClick={() => fileInputRef.current?.click()}
                              >
                                upload auth.json
                              </button>
                            </>
                          ) : type === "opencode-go" ? (
                            "Paste the subscription key from your OpenCode Go account. Encrypted at rest."
                          ) : type === "openrouter" ? (
                            <>
                              Paste your API key from{" "}
                              <a
                                href="https://openrouter.ai/settings/keys"
                                target="_blank"
                                rel="noopener noreferrer"
                                className={inlineLinkClassName}
                              >
                                openrouter.ai
                              </a>
                              .
                            </>
                          ) : type === "local" ? (
                            "Sent as a Bearer token to the Base URL's host. Leave empty for a keyless server like Ollama or LM Studio."
                          ) : (
                            <span className="flex items-center gap-1">
                              <Lock aria-hidden className="size-3 shrink-0" />
                              Encrypted. Never shown again.
                            </span>
                          )}
                        </p>
                      )}
                      {type === "anthropic" && (
                        <AnthropicKeyBadge value={value.trim()} />
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

              {isGeneric && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="secret-host">API host</Label>
                    <Input
                      id="secret-host"
                      placeholder="api.example.com"
                      value={hostPattern}
                      onChange={(e) => setHostPattern(e.target.value)}
                    />
                    {hostPatternError && (
                      <p className="text-xs text-red-500">{hostPatternError}</p>
                    )}
                  </div>

                  <SentAsFields
                    value={generic}
                    hostPattern={hostPattern}
                    onChange={(patch) =>
                      setGeneric((prev) => ({ ...prev, ...patch }))
                    }
                  />

                  {!pathLimitHidden && (
                    <OptionalField
                      label="Limit to a path"
                      open={pathLimitOpen}
                      onOpenChange={setPathLimitOpen}
                    >
                      <Label htmlFor="secret-path" className="sr-only">
                        Path pattern
                      </Label>
                      <Input
                        id="secret-path"
                        placeholder="/v1/*"
                        value={pathPattern}
                        onChange={(e) => setPathPattern(e.target.value)}
                      />
                    </OptionalField>
                  )}
                </>
              )}

              {!isGeneric && (
                <Accordion
                  type="single"
                  collapsible
                  className="border-none"
                  value={advancedOpen}
                  onValueChange={setAdvancedOpen}
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
                        {type !== "local" && (
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
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </div>

            <DialogFooter>
              {type === "anthropic" && (
                // The step-by-step guide for both credentials (installing
                // Claude Code for `claude setup-token`, or a Console API key).
                // Left-aligned so it never competes with the primary action.
                <Button
                  variant="link"
                  asChild
                  className="px-0 has-[>svg]:px-0 sm:mr-auto"
                >
                  <a
                    href={ANTHROPIC_SETUP_GUIDE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <CircleHelp aria-hidden />
                    Need help?
                  </a>
                </Button>
              )}
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} loading={saving} disabled={!isValid}>
                {saving
                  ? isEdit
                    ? "Saving..."
                    : "Creating..."
                  : isEdit
                    ? "Save changes"
                    : isGeneric
                      ? "Add connection"
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
