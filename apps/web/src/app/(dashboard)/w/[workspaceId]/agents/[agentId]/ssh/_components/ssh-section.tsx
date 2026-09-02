"use client";

import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { EmptyState } from "../../_components/empty-state";
import { useInstance } from "@/hooks/use-instance";
import { useMintSshCertificate } from "@/hooks/use-agents";
import { useSshKeys } from "@/hooks/use-ssh-keys";
import { AddSshKeyForm } from "@/lib/account/_components/add-ssh-key-form";
import { SshKeyPicker } from "./ssh-key-picker";
import { SshConnectSteps } from "./ssh-connect-steps";

/**
 * The agent's SSH section (sandbox-platform step 5): pick a registered key,
 * mint a short-lived certificate with one click, connect with plain `ssh`.
 * First run registers the key inline (shared form — the account page owns
 * the full manager). Hosted-only via the section table — the rail never
 * links here for a BYO agent and the frame blocks a hand-typed URL — and
 * instance-gated in the rail: on a deployment without the SSH front door the
 * entry is simply absent, so the quiet empty state below is reachable only
 * by hand-typed URL.
 */
export const SshSection = () => {
  const agent = useAgentPageAgent();
  const instance = useInstance();
  const mint = useMintSshCertificate();
  const {
    data: sshKeys = [],
    isPending: keysPending,
    isError: keysError,
  } = useSshKeys();

  // Resolved WITHOUT ssh = this deployment has no front door. Loading (null)
  // deliberately falls through to the content: loading must never render as
  // unavailable (the availability.ts law).
  if (instance !== null && instance.ssh === undefined) {
    return (
      <EmptyState
        tone="quiet"
        title="SSH isn't available on this deployment."
      />
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold">SSH</h2>
        <p className="text-muted-foreground text-sm">
          Open a shell on this agent&apos;s computer with the tools you already
          use: ssh, scp, sftp, or VS Code Remote SSH. Your private key never
          leaves your machine.
        </p>
      </div>

      {/* A failed read must never render as the first-run arm — offering
          "register your key" to someone who HAS keys would walk them into a
          duplicate refusal. */}
      {keysPending ? (
        <p className="text-muted-foreground text-sm">Loading your SSH keys…</p>
      ) : keysError ? (
        <p className="text-muted-foreground text-sm">
          Couldn&apos;t load your SSH keys. Refresh to try again.
        </p>
      ) : sshKeys.length === 0 ? (
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Register your public key once; it works for every agent you can
            reach and lives under your account settings.
          </p>
          {/* Registering refetches the list, so the picker (with the fresh
              key selected) takes this arm's place on success. */}
          <AddSshKeyForm />
        </div>
      ) : (
        <SshKeyPicker agentId={agent.id} keys={sshKeys} mint={mint} />
      )}

      {mint.data && <SshConnectSteps minted={mint.data} />}
    </div>
  );
};
