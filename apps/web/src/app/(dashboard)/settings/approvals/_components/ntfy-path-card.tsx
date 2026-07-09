"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, RotateCw, Send, Sparkles, TriangleAlert } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Switch } from "@onecli/ui/components/switch";
import { Input } from "@onecli/ui/components/input";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import {
  saveApprovalPath,
  setApprovalPathEnabled,
  generateCallbackToken,
  sendTestApproval,
  getApprovalLog,
  revealApprovalSecret,
} from "@/lib/actions/approval-paths";
import { FieldLabel } from "./field-label";
import { PasswordInput } from "./password-input";

interface NtfyPathCardProps {
  enabled: boolean;
  settings: Record<string, string>;
  hasCredentials: boolean;
}

interface ApprovalLogEntry {
  at: string;
  message: string;
}

interface FieldDef {
  name: string;
  label: string;
  placeholder?: string;
  type?: "text" | "number" | "password";
  secret?: boolean;
  /** Hover instruction. */
  short?: string;
  /** Click-to-open detailed usage. */
  detail?: string;
  /** Returns a warning to show under the field for the current value, if any. */
  warn?: (value: string) => string | undefined;
}

const FIELDS: FieldDef[] = [
  {
    name: "serverUrl",
    label: "Server URL",
    placeholder: "https://ntfy.example.com or http://nas-ip:8089",
    short:
      "The ntfy server the gateway publishes to. A LAN/internal URL is fine.",
    detail:
      "The base URL of your ntfy server — where the gateway POSTs notifications.\n\nThis call is made by the gateway (server-side), so a LAN or internal address works (e.g. http://nas-ip:8089). Public HTTPS (https://ntfy.example.com) is fine too.\n\nIf the host uses an internal/private CA over HTTPS, add it to the gateway's GATEWAY_SKIP_VERIFY_HOSTS env var or TLS verification will fail.",
  },
  {
    name: "topic",
    label: "Topic",
    placeholder: "onecli-approvals",
    short: "The ntfy topic notifications are published to.",
    detail:
      "The ntfy topic name the gateway publishes approvals to, and that your phone/device subscribes to.\n\nOn a private ntfy server (auth-default-access: deny-all) the publish token below must have write access to this topic.",
  },
  {
    name: "callbackBaseUrl",
    label: "Callback Base URL",
    placeholder: "https://onecli.example.com",
    short:
      "HTTPS base URL where Approve/Deny POST back. Must be reachable from your phone — use HTTPS so iOS doesn't block it.",
    detail:
      "Where the Approve/Deny buttons send their decision. The buttons fire from your PHONE, so this must be reachable from the device — not from the gateway. The buttons POST to {base}/v1/approvals/{id}/approve|deny.\n\nUSE HTTPS. iOS App Transport Security blocks plain-HTTP requests, so a bare http://host:10255 callback silently fails on iPhone/iPad (it may work on Android/desktop). Front the gateway's API with a TLS reverse proxy that has a cert your device trusts:\n  • Reverse-proxy /v1/approvals/* to the gateway (:10255) on your existing HTTPS host, then set this to that host, e.g. https://onecli.example.com\n  • Or a public tunnel: https://onecli-gw.example.com (Cloudflare Tunnel → gateway :10255)\n\nPlain http://host:10255 is only OK if every approving device is non-iOS. Don't point this at the dashboard without the gateway route, or the callback 404s.",
    warn: (v) =>
      v.startsWith("http://")
        ? "Plain http won't work on iOS (App Transport Security blocks it), and a redirect to https can strip the auth header (→ 401). Use https://."
        : undefined,
  },
  {
    name: "timeoutSeconds",
    label: "Hold Timeout (seconds)",
    placeholder: "120",
    type: "number",
    short:
      "How long the request is held awaiting a decision. Raise it if you may be away from the screen.",
    detail:
      "How many seconds the gateway holds the agent's request while waiting for you to Approve/Deny. On timeout the request is auto-denied.\n\nRaise this for long-running agent tasks where you might be away from your phone (e.g. 600 = 10 minutes). The held request uses the LONGEST timeout among all enabled channels.",
  },
  {
    name: "priority",
    label: "Priority (optional)",
    placeholder: "high",
    short: "ntfy priority 1–5 or a name (min, low, default, high, max).",
    detail:
      "Sets the ntfy notification priority (the X-Priority header). Use a number 1–5 or a name: min, low, default, high, max.\n\nHigh/max surface more aggressively on the device. Leave blank for the server default. Supports variable expansion (see Tags).",
  },
  {
    name: "tags",
    label: "Tags (optional)",
    placeholder: "warning,robot,{agentName}",
    short:
      "Comma-separated ntfy tags/emoji. Supports variables like {agentId}, {agentName}, {host}.",
    detail:
      "Comma-separated ntfy tags. Names that match ntfy emoji shortcodes render as emoji (e.g. warning, robot, rotating_light).\n\nVariable expansion — these placeholders are substituted from the request being approved (Title, Tags, and Priority all support them):\n  {agentId}    the requesting agent's id\n  {agentName}  the agent's display name\n  {method}     HTTP method (GET, POST, …)\n  {host}       destination host\n  {path}       request path\n\nExample: warning,{agentName} tags each notification with the agent that triggered it, so you can route or filter by agent on the device.",
  },
  {
    name: "publishToken",
    label: "Publish Token",
    placeholder: "tk_… (leave blank for an open server)",
    type: "password",
    secret: true,
    short:
      "ntfy write token. Required on a private server; leave blank if the topic allows anonymous publish.",
    detail:
      "The ntfy access token the gateway uses to publish (sent as Authorization: Bearer). Format tk_…\n\nWhere to get it — on the machine running ntfy:\n  docker exec ntfy ntfy token add --label 'OneCLI approval publisher' onecli\n  docker exec ntfy ntfy token list      # view\n\nThat mints a token for the 'onecli' user, which needs write access to the topic. Use a write-only user so the token can't read the topic back.\n\nLeave blank only if your server allows anonymous publish to the topic. Stored encrypted; leave blank when editing to keep the saved value.",
  },
];

export const NtfyPathCard = ({
  enabled: initialEnabled,
  settings,
  hasCredentials,
}: NtfyPathCardProps) => {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [values, setValues] = useState<Record<string, string>>(() => ({
    serverUrl: settings.serverUrl ?? "",
    topic: settings.topic ?? "onecli-approvals",
    callbackBaseUrl: settings.callbackBaseUrl ?? "",
    timeoutSeconds: settings.timeoutSeconds ?? "120",
    priority: settings.priority ?? "",
    tags: settings.tags ?? "",
    reportSelection: settings.reportSelection ?? "true",
    publishToken: "",
    callbackToken: "",
  }));
  const [togglePending, startToggle] = useTransition();
  const [savePending, startSave] = useTransition();
  const [genPending, startGen] = useTransition();
  const [testPending, startTest] = useTransition();
  const [logLoading, setLogLoading] = useState(false);
  const [log, setLog] = useState<ApprovalLogEntry[]>([]);

  const setField = (name: string, value: string) =>
    setValues((v) => ({ ...v, [name]: value }));

  // Prefill Callback Base URL with this dashboard's own origin when unset —
  // with the Caddy gateway route, the callback lives on the same https host.
  // Done after mount to avoid an SSR hydration mismatch on the input value.
  useEffect(() => {
    if (!settings.callbackBaseUrl && typeof window !== "undefined") {
      setField("callbackBaseUrl", window.location.origin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reveal a saved secret into the field (gated by ONECLI_ALLOW_SECRET_REVEAL).
  const reveal = (field: string) => async (): Promise<boolean> => {
    try {
      const value = await revealApprovalSecret("ntfy", field);
      setField(field, value);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reveal");
      return false;
    }
  };

  const refreshLog = async () => {
    setLogLoading(true);
    try {
      setLog(await getApprovalLog(8));
    } catch {
      // non-fatal — the log view is best-effort
    } finally {
      setLogLoading(false);
    }
  };

  const handleToggle = (next: boolean) => {
    setEnabled(next);
    startToggle(async () => {
      try {
        await setApprovalPathEnabled("ntfy", next);
        toast.success(
          next ? "ntfy approvals enabled" : "ntfy approvals disabled",
        );
      } catch (err) {
        setEnabled(!next);
        toast.error(err instanceof Error ? err.message : "Failed to update");
      }
    });
  };

  const handleGenerate = () => {
    startGen(async () => {
      try {
        const token = await generateCallbackToken();
        setField("callbackToken", token);
        toast.success("Callback token generated — save to persist it");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to generate");
      }
    });
  };

  const handleSave = () => {
    startSave(async () => {
      try {
        // Omit blank secret fields so existing stored tokens are preserved.
        const payload: Record<string, string> = { ...values };
        if (!payload.publishToken) delete payload.publishToken;
        if (!payload.callbackToken) delete payload.callbackToken;

        await saveApprovalPath("ntfy", payload);
        setEnabled(true);
        setValues((v) => ({ ...v, publishToken: "", callbackToken: "" }));
        toast.success("ntfy approval path saved");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save");
      }
    });
  };

  const handleTest = () => {
    startTest(async () => {
      try {
        await sendTestApproval();
        toast.success(
          "Test approval sent — check your device, then Approve or Deny",
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send test");
        return;
      }
      await refreshLog();
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="select-text">ntfy Push</CardTitle>
            <CardDescription className="select-text">
              Publish an Approve / Deny push to a self-hosted{" "}
              <a
                href="https://ntfy.sh"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:opacity-70"
              >
                ntfy
              </a>{" "}
              server. Tapping a button resolves the held request out-of-band.
            </CardDescription>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={togglePending}
            aria-label="Enable ntfy approval path"
          />
        </div>
      </CardHeader>

      {/* Fields collapse when disabled — keeps the list short as channels grow. */}
      {enabled && (
        <CardContent className="space-y-4">
          {FIELDS.map((field) => (
            <div key={field.name} className="space-y-2">
              <FieldLabel
                htmlFor={`ntfy-${field.name}`}
                label={field.label}
                short={field.short}
                detail={field.detail}
              />
              {field.secret ? (
                <PasswordInput
                  id={`ntfy-${field.name}`}
                  placeholder={
                    hasCredentials
                      ? "•••••••• (leave blank to keep)"
                      : field.placeholder
                  }
                  value={values[field.name]}
                  onChange={(e) => setField(field.name, e.target.value)}
                  onRevealRequest={
                    hasCredentials ? reveal(field.name) : undefined
                  }
                />
              ) : (
                <Input
                  id={`ntfy-${field.name}`}
                  type={field.type ?? "text"}
                  placeholder={field.placeholder}
                  value={values[field.name]}
                  onChange={(e) => setField(field.name, e.target.value)}
                />
              )}
              {field.warn?.(values[field.name] ?? "") && (
                <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  {field.warn(values[field.name] ?? "")}
                </p>
              )}
            </div>
          ))}

          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <p className="select-text text-sm font-medium">
                Report Selection to Topic
              </p>
              <p className="text-muted-foreground select-text text-xs">
                After a decision, post a confirmation note (the decision plus
                the request&apos;s name and time) back to the topic.
                Recommended: it shows you when <em>someone else</em> approved,
                and gives iOS the feedback its silent buttons don&apos;t. Turn
                off if you only use Android and find the extra note noisy.
              </p>
            </div>
            <Switch
              checked={values.reportSelection !== "false"}
              onCheckedChange={(c) =>
                setField("reportSelection", c ? "true" : "false")
              }
              aria-label="Report selection to topic"
            />
          </div>

          <div className="space-y-2">
            <FieldLabel
              htmlFor="ntfy-callbackToken"
              label="Callback Token"
              short="Fixed bearer the Approve/Deny buttons send back. Click Generate, then Save."
              detail={
                "A fixed bearer token the Approve/Deny buttons include when they call back to the gateway. It authenticates the decision so only your notification can resolve a held request.\n\nThis is NOT per-request — it's one long-lived token for this channel, distinct from agent tokens (so a leak in a notification has minimal blast radius). Click Generate to mint a strong one (acb_…), then Save.\n\nLeave blank when editing to keep the existing token. If no token has ever been saved, callbacks are rejected (fail-closed)."
              }
            />
            <div className="flex items-center gap-2">
              <PasswordInput
                id="ntfy-callbackToken"
                placeholder={
                  hasCredentials
                    ? "•••••••• (leave blank to keep)"
                    : "acb_… — click Generate"
                }
                value={values.callbackToken}
                onChange={(e) => setField("callbackToken", e.target.value)}
                onRevealRequest={
                  hasCredentials ? reveal("callbackToken") : undefined
                }
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleGenerate}
                disabled={genPending}
                className="shrink-0"
              >
                {genPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                Generate
              </Button>
            </div>
          </div>

          <p className="text-muted-foreground select-text text-xs">
            Saved tokens stay hidden. The eye reveals a saved value only when{" "}
            <code className="bg-muted rounded px-1 py-0.5 text-[11px]">
              ONECLI_ALLOW_SECRET_REVEAL=true
            </code>{" "}
            is set on the server (off by default — enabling it is less secure,
            as the decrypted token is sent to your browser on demand).
          </p>

          <div className="flex justify-end pt-1">
            <Button type="button" onClick={handleSave} disabled={savePending}>
              {savePending && <Loader2 className="size-4 animate-spin" />}
              {savePending ? "Saving..." : "Save"}
            </Button>
          </div>

          {/* Connection test — exercises publish → device → callback without an agent. */}
          <div className="space-y-3 border-t pt-4">
            <div className="flex items-center justify-between gap-2">
              <div className="space-y-0.5">
                <p className="select-text text-sm font-medium">
                  Test the connection
                </p>
                <p className="text-muted-foreground select-text text-xs">
                  Sends a real notification you can Approve/Deny. Save your
                  settings first.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={refreshLog}
                  disabled={logLoading}
                  aria-label="Refresh approval log"
                >
                  <RotateCw
                    className={cn("size-4", logLoading && "animate-spin")}
                  />
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleTest}
                  disabled={testPending}
                >
                  {testPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  {testPending ? "Sending..." : "Send test approval"}
                </Button>
              </div>
            </div>

            <div className="bg-muted/40 rounded-md border p-3">
              <p className="text-muted-foreground mb-2 select-text text-xs font-medium">
                Recent approval events
              </p>
              {log.length === 0 ? (
                <p className="text-muted-foreground select-text font-mono text-xs">
                  No events yet. Send a test, then refresh after you
                  Approve/Deny.
                </p>
              ) : (
                <ul className="space-y-1">
                  {log.map((entry, i) => (
                    <li
                      key={`${entry.at}-${i}`}
                      className="select-text font-mono text-xs leading-relaxed"
                    >
                      <span className="text-muted-foreground">
                        {entry.at.replace("T", " ").replace(/\..*$/, "")}
                      </span>{" "}
                      {entry.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
};
