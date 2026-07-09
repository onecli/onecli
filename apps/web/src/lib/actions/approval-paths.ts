"use server";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@onecli/db";
import { GATEWAY_API_URL } from "@/lib/env";
import { resolveProjectContext } from "@/lib/actions/resolve-user";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";
import {
  listApprovalPaths,
  getApprovalPath,
  upsertApprovalPath,
  setApprovalPathEnabled as setApprovalPathEnabledService,
  revealApprovalSecret as revealApprovalSecretService,
} from "@onecli/api/services/approval-path-service";
import { getApprovalPathFields } from "@onecli/api/services/approval-path-channels";

export const getApprovalPaths = async () => {
  const { projectId } = await resolveProjectContext();
  return listApprovalPaths({ projectId });
};

export const getApprovalPathStatus = async (channel: string) => {
  const { projectId } = await resolveProjectContext();
  return getApprovalPath({ projectId }, channel);
};

export const saveApprovalPath = async (
  channel: string,
  values: Record<string, string>,
) => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  const fields = getApprovalPathFields(channel);
  if (fields.length === 0) {
    throw new Error(`Unknown approval channel "${channel}"`);
  }

  return withAudit(
    () => upsertApprovalPath({ projectId }, channel, values, fields),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.APPROVAL_PATH,
      metadata: { channel },
    }),
  );
};

export const setApprovalPathEnabled = async (
  channel: string,
  enabled: boolean,
) => {
  const { userId, userEmail, projectId } = await resolveProjectContext();

  return withAudit(
    () => setApprovalPathEnabledService({ projectId }, channel, enabled),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.APPROVAL_PATH,
      metadata: { channel, enabled },
    }),
  );
};

/**
 * Mint a fresh callback bearer token for the ntfy Approve/Deny buttons.
 * Not persisted here — returned to the form so the user can review and save it.
 */
export const generateCallbackToken = async (): Promise<string> => {
  await resolveProjectContext(); // require auth
  return `acb_${randomBytes(32).toString("hex")}`;
};

/**
 * Reveal a saved secret field (e.g. ntfy publishToken) for the eye toggle.
 * Gated by ONECLI_ALLOW_SECRET_REVEAL (off by default): when disabled, throws a
 * message explaining how to enable it and that doing so is less secure.
 */
export const revealApprovalSecret = async (
  channel: string,
  field: string,
): Promise<string> => {
  const { projectId } = await resolveProjectContext();
  if (process.env.ONECLI_ALLOW_SECRET_REVEAL !== "true") {
    throw new Error(
      "Revealing saved secrets is turned off. To enable it, set " +
        "ONECLI_ALLOW_SECRET_REVEAL=true on the server and restart. " +
        "This is less secure — the decrypted token is sent to the browser on " +
        "demand. (Anyone who can change server env and restart can already read " +
        "the database, so this only trades a little safety for convenience.)",
    );
  }
  const value = await revealApprovalSecretService(
    { projectId },
    channel,
    field,
  );
  if (!value) throw new Error("No saved value for this field.");
  return value;
};

/**
 * Authenticate to the gateway API: prefer an API key (works in all auth modes),
 * fall back to forwarding the session cookies (oauth mode). Mirrors
 * `gateway-cache.ts`.
 */
const gatewayHeaders = async (
  projectId: string,
): Promise<Record<string, string>> => {
  const apiKey = await db.apiKey.findFirst({
    where: { projectId },
    select: { key: true },
  });
  if (apiKey) return { authorization: `Bearer ${apiKey.key}` };

  const cookieStore = await cookies();
  return {
    cookie: cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; "),
  };
};

/**
 * Trigger a synthetic approval over the ntfy channel so the publish →
 * device → callback round-trip can be verified without an agent request.
 */
export const sendTestApproval = async (): Promise<{
  approvalId: string;
  expiresInSeconds: number;
}> => {
  const { projectId } = await resolveProjectContext();
  const headers = await gatewayHeaders(projectId);
  const res = await fetch(`${GATEWAY_API_URL}/v1/approvals/test`, {
    method: "POST",
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      body.error === "ntfy_not_enabled"
        ? "Enable and save the ntfy channel first."
        : `Gateway returned ${res.status}`,
    );
  }
  return res.json() as Promise<{
    approvalId: string;
    expiresInSeconds: number;
  }>;
};

/** Read the gateway's recent approval-pipeline events for this project. */
export const getApprovalLog = async (
  limit = 3,
): Promise<{ at: string; message: string }[]> => {
  const { projectId } = await resolveProjectContext();
  const headers = await gatewayHeaders(projectId);
  const res = await fetch(
    `${GATEWAY_API_URL}/v1/approvals/log?limit=${limit}`,
    { headers, cache: "no-store" },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as {
    entries?: { at: string; message: string }[];
  };
  return body.entries ?? [];
};
