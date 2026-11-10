"use client";

import { useState } from "react";
import { FileCode2, Link2 } from "lucide-react";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Textarea } from "@onecli/ui/components/textarea";
import { useCreateSsoConnection } from "@/hooks/use-sso-connections";
import { usePlanGate } from "@/lib/plan-gate";
import { PlanGatedSubmitButton } from "./plan-gated-submit-button";

export type SsoType = "saml" | "oidc";

/**
 * The details one protocol needs, for the Add identity provider dialog's
 * second step (the dialog's first step picks `type`).
 */
export const SsoSetupForm = ({
  type,
  onDone,
  secondaryAction,
}: {
  type: SsoType;
  /** The connection was created. */
  onDone?: () => void;
  /** Beside the submit button (the dialog's Back). */
  secondaryAction?: React.ReactNode;
}) => {
  const createMutation = useCreateSsoConnection();
  const planGate = usePlanGate();
  const locked = planGate.isLocked("sso");

  const [displayName, setDisplayName] = useState("");
  const [samlSource, setSamlSource] = useState<"url" | "xml">("url");
  const [metadataUrl, setMetadataUrl] = useState("");
  const [metadataXml, setMetadataXml] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const complete =
    displayName.trim() &&
    (type === "saml"
      ? samlSource === "url"
        ? metadataUrl.trim()
        : metadataXml.trim()
      : issuer.trim() && clientId.trim() && clientSecret.trim());

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (planGate.guard("sso")) return;
    if (!complete) return;
    createMutation.mutate(
      {
        type,
        displayName: displayName.trim(),
        ...(type === "saml"
          ? samlSource === "url"
            ? { metadataUrl: metadataUrl.trim() }
            : { metadataXml: metadataXml.trim() }
          : {
              issuer: issuer.trim(),
              clientId: clientId.trim(),
              clientSecret,
            }),
      },
      { onSuccess: () => onDone?.() },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-2">
        <Label htmlFor="sso-name">Connection name</Label>
        <Input
          id="sso-name"
          placeholder="Acme Okta"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="max-w-sm"
        />
      </div>

      {type === "saml" ? (
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="sso-metadata">IdP metadata</Label>
            <button
              type="button"
              onClick={() =>
                setSamlSource(samlSource === "url" ? "xml" : "url")
              }
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
            >
              {samlSource === "url" ? (
                <>
                  <FileCode2 className="size-3.5" /> Paste XML instead
                </>
              ) : (
                <>
                  <Link2 className="size-3.5" /> Use a metadata URL instead
                </>
              )}
            </button>
          </div>
          {samlSource === "url" ? (
            <Input
              id="sso-metadata"
              placeholder="https://login.microsoftonline.com/.../federationmetadata.xml"
              value={metadataUrl}
              onChange={(e) => setMetadataUrl(e.target.value)}
            />
          ) : (
            <Textarea
              id="sso-metadata"
              placeholder="<EntityDescriptor ...>"
              value={metadataXml}
              onChange={(e) => setMetadataXml(e.target.value)}
              rows={6}
              className="font-mono text-xs"
            />
          )}
          <p className="text-muted-foreground text-xs">
            From your IdP&apos;s SAML app: federation metadata URL or the
            downloaded metadata XML.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-2">
            <Label htmlFor="sso-issuer">Issuer URL</Label>
            <Input
              id="sso-issuer"
              placeholder="https://login.example.com"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              className="max-w-sm"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sso-client-id">Client ID</Label>
            <Input
              id="sso-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="max-w-sm"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sso-client-secret">Client secret</Label>
            <Input
              id="sso-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              className="max-w-sm"
            />
            <p className="text-muted-foreground text-xs">
              Stored encrypted; never shown again.
            </p>
          </div>
        </>
      )}

      <div className="flex justify-end gap-2">
        {secondaryAction}
        <PlanGatedSubmitButton
          locked={locked}
          pending={createMutation.isPending}
          complete={!!complete}
          pendingLabel="Connecting…"
          label="Create connection"
        />
      </div>
    </form>
  );
};
