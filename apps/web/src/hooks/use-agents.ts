"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { agents } from "@/lib/api";
import type {
  AgentDetail,
  AgentEffort,
  MintSshCertificateSource,
} from "@/lib/api/types";
import { queryKeys } from "@/lib/api/keys";
import { squareCrop } from "@/lib/agents/square-crop";
import {
  getAgents,
  deleteAgent,
  renameAgent,
  regenerateAgentToken,
} from "@/lib/actions/agents";
import { invalidateGatewayCache } from "@/lib/api/cache";

export const useAgents = (enabled = true) =>
  useQuery({ queryKey: queryKeys.agents.list(), queryFn: getAgents, enabled });

/** Detail read incl. `recentRequestAt`. With `poll`, refetches every 5s until
 * a request is seen — the Install page's "waiting for the first request"
 * signal — then stops on its own. An errored read (e.g. the agent was deleted
 * mid-wait) also stops the loop instead of hammering a 404 every 5s. */
export const useAgentDetail = (
  agentId: string,
  options: { poll?: boolean } = {},
) =>
  useQuery({
    queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => agents.get(agentId),
    enabled: agentId.length > 0,
    refetchInterval: options.poll
      ? (query) =>
          query.state.error || query.state.data?.recentRequestAt ? false : 5000
      : undefined,
  });

/** Agents of an explicitly-chosen workspace (the org-level Get Started picker,
 * the sidebar's Agents group) — for page content inside /w/<id>/ routes use
 * `useAgents()`, which follows the URL scope. Chrome that can outlive a
 * workspace URL (the sidebar) must use THIS hook: `useAgents`'s server-action
 * queryFn posts to the CURRENT route and loses its workspace header the moment
 * the browser sits on a non-workspace URL (bare /org mid-redirect), turning a
 * routine refetch into a 500. */
export const useAgentsForWorkspace = (workspaceId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.agents.forWorkspace(workspaceId),
    queryFn: () => agents.list({ workspaceId }),
    enabled: enabled && workspaceId.length > 0,
  });

export const useCreateAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: agents.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      // A new agent appears in the connection→agents reverse view (app-page
      // connection cards, keyed under connections.*) — refresh it too.
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      // Creation now WRITES GRANTS (the LLM auto-attach), so the grant and
      // policy views are stale the moment it returns — same sweep a manual
      // attach does in use-grants.
      qc.invalidateQueries({ queryKey: queryKeys.grants.all() });
      qc.invalidateQueries({ queryKey: queryKeys.policy.all() });
      invalidateGatewayCache();
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to create agent",
      ),
  });
};

/**
 * Hosted-agent creation. Same invalidations as `useCreateAgent`, but
 * refusals are the caller's to render — the dialog shows them inline
 * (a duplicate name, quota, or the agents-offline state), so there is
 * deliberately no error toast here.
 */
export const useCreateHostedAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      identifier: string;
      instructions?: string;
    }) => agents.create({ ...input, kind: "hosted" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      // The LLM auto-attach writes grants here too — see `useCreateAgent`.
      qc.invalidateQueries({ queryKey: queryKeys.grants.all() });
      qc.invalidateQueries({ queryKey: queryKeys.policy.all() });
      invalidateGatewayCache();
    },
  });
};

export const useDeleteAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteAgent,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      // Drop the deleted agent from the connection→agents reverse view too.
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      // The delete cascades to the agent's conversations — refresh the chat
      // rail rather than leaving rows that 404 on click.
      qc.invalidateQueries({ queryKey: queryKeys.conversations.all() });
      invalidateGatewayCache();
      toast.success("Agent deleted");
    },
    onError: () => toast.error("Failed to delete agent"),
  });
};

export const useRenameAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, name }: { agentId: string; name: string }) =>
      renameAgent(agentId, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
      // The renamed agent is also shown in the connection→agents reverse view.
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      toast.success("Agent renamed");
    },
    onError: () => toast.error("Failed to rename agent"),
  });
};

/**
 * Save the hosted agent's brief (§3.11) from the Instructions section. No
 * gateway-cache invalidation: the gateway reads none of these columns. The
 * next sandbox (re)start picks the brief up; a running one keeps its copy.
 */
export const useUpdateInstructions = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      instructions,
    }: {
      agentId: string;
      instructions: string | null;
    }) => agents.update(agentId, { instructions }),
    onSuccess: (_data, { agentId, instructions }) => {
      // Seed what we just wrote before refetching: the editor falls back to
      // the cached value the moment its draft clears, so an invalidate alone
      // would flash the PREVIOUS text until the refetch lands.
      qc.setQueryData(queryKeys.agents.detail(agentId), (prev?: AgentDetail) =>
        prev ? { ...prev, instructions } : prev,
      );
      qc.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      toast.success("Instructions saved");
    },
    onError: () => toast.error("Failed to save instructions"),
  });
};

/**
 * What this agent can run (§3.10). Keyed by agent because the answer depends
 * on which key is granted to it, not on the workspace.
 */
export const useAgentModels = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.agents.models(agentId),
    queryFn: () => agents.models(agentId),
    enabled: agentId !== "",
  });

export const useUpdateAgentModel = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      model,
      effort,
    }: {
      agentId: string;
      model?: string | null;
      effort?: AgentEffort | null;
    }) =>
      agents.update(agentId, {
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
      }),
    onSuccess: (_data, { agentId }) => {
      // Both: `models` holds the selection, `detail` renders it on Overview.
      qc.invalidateQueries({ queryKey: queryKeys.agents.models(agentId) });
      qc.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      toast.success("Model updated");
    },
    onError: (error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : "Failed to update the model",
      ),
  });
};

/**
 * Upload (or replace) the agent's avatar; null file = remove it. The crop
 * runs INSIDE the mutation so `isPending` spans it — the caller's disabled
 * state covers the whole prepare+upload window, not just the network leg.
 * The list query renders the avatar everywhere, so the sweep invalidates it
 * too.
 */
export const useUpdateAgentImage = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      file,
    }: {
      agentId: string;
      file: File | null;
    }) => {
      if (file) await agents.uploadImage(agentId, await squareCrop(file));
      else await agents.deleteImage(agentId);
    },
    onSuccess: (_data, { agentId, file }) => {
      // root(): sweeps the URL-scoped list AND the sidebar's
      // workspace-keyed list (agents.forWorkspace) in one stroke.
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
      qc.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      toast.success(file ? "Image updated" : "Image removed");
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to update the image",
      ),
  });
};

export const useRegenerateToken = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: regenerateAgentToken,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
      invalidateGatewayCache();
      toast.success("Token regenerated");
    },
    onError: () => toast.error("Failed to regenerate token"),
  });
};

/**
 * Mint a short-lived SSH certificate for a hosted agent (sandbox-platform
 * step 5). Headless (the use-crons convention): the SSH section owns the
 * error copy, because refusals must render inline as states — 404 (no SSH
 * front door here), 422 (not an ed25519 key), 429 (mint rate limit). No
 * query invalidation: the cert is one-time material nothing caches. And no
 * `invalidateGatewayCache()`: the gateway reads no SSH state, a flush would
 * be pure noise.
 */
export const useMintSshCertificate = () =>
  useMutation({
    mutationFn: (vars: { agentId: string } & MintSshCertificateSource) =>
      agents.mintSshCertificate(
        vars.agentId,
        "sshKeyId" in vars
          ? { sshKeyId: vars.sshKeyId }
          : { publicKey: vars.publicKey },
      ),
  });
