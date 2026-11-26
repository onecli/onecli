"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import { SsoSetupForm, type SsoType } from "./sso-setup-form";

const PROTOCOLS: { value: SsoType; label: string; description: string }[] = [
  {
    value: "saml",
    label: "SAML 2.0",
    description: "Standard enterprise SSO: Okta, Entra ID, Google Workspace.",
  },
  {
    value: "oidc",
    label: "OpenID Connect",
    description: "OAuth-based sign-in: Auth0, Keycloak, any OIDC issuer.",
  },
];

/**
 * Connecting an identity provider in two steps: pick the protocol, then
 * fill in what that protocol needs. Opened from the empty Identity
 * provider panel; closes itself once the connection is created.
 */
export const AddIdentityProviderDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const [protocol, setProtocol] = useState<SsoType>("saml");
  const [step, setStep] = useState<"pick" | "configure">("pick");
  const chosen = PROTOCOLS.find((p) => p.value === protocol);

  const changeOpen = (next: boolean) => {
    onOpenChange(next);
    // Every opening starts at the protocol choice.
    if (!next) setStep("pick");
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === "pick"
              ? "Add identity provider"
              : `Connect ${chosen?.label}`}
          </DialogTitle>
          <DialogDescription>
            {step === "pick"
              ? "Pick a protocol to configure."
              : "Paste the details from your identity provider's app."}
          </DialogDescription>
        </DialogHeader>

        {step === "pick" ? (
          <>
            <div
              role="radiogroup"
              aria-label="Protocol"
              className="flex flex-col gap-2"
            >
              {PROTOCOLS.map((p) => {
                const selected = p.value === protocol;
                return (
                  <button
                    key={p.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setProtocol(p.value)}
                    className={cn(
                      "flex items-center justify-between gap-4 rounded-lg border px-4 py-3 text-left transition-colors",
                      selected
                        ? "border-brand/40 bg-brand-wash"
                        : "hover:border-foreground/20 hover:bg-foreground/[0.02]",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {p.label}
                      </span>
                      <span className="text-muted-foreground block text-xs">
                        {p.description}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        selected ? "border-brand" : "border-foreground/25",
                      )}
                    >
                      {selected && (
                        <span className="bg-brand size-2 rounded-full" />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => changeOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => setStep("configure")}>Continue</Button>
            </DialogFooter>
          </>
        ) : (
          <SsoSetupForm
            type={protocol}
            onDone={() => changeOpen(false)}
            secondaryAction={
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep("pick")}
              >
                <ArrowLeft className="size-3.5" aria-hidden />
                Back
              </Button>
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
};
