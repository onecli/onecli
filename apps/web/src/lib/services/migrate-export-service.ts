import { db } from "@onecli/db";
import { cryptoService } from "@/lib/crypto";
import { ServiceError } from "@/lib/services/errors";
import { logger } from "@/lib/logger";

const CLOUD_URL = "https://app.onecli.sh";

interface MigrateImported {
  secrets: number;
  agents: number;
  agentSecrets: number;
  rules: number;
}

interface MigrateSkipped {
  type: string;
  name: string;
  reason: string;
}

interface MigrateResult {
  imported: MigrateImported;
  skipped: MigrateSkipped[];
}

/**
 * Export all account data and send it directly to OneCLI Cloud.
 * Decrypts secrets locally and transmits over HTTPS — plaintext never
 * leaves the server process or reaches the caller.
 */
export const exportToCloud = async (
  accountId: string,
  cloudApiKey: string,
): Promise<MigrateResult> => {
  // ── Gather data ───────────────────────────────────────────────

  const [secrets, agents, agentSecrets, rules] = await Promise.all([
    db.secret.findMany({
      where: { accountId },
      select: {
        name: true,
        type: true,
        encryptedValue: true,
        hostPattern: true,
        pathPattern: true,
        injectionConfig: true,
        metadata: true,
      },
    }),
    db.agent.findMany({
      where: { accountId },
      select: {
        id: true,
        name: true,
        identifier: true,
        isDefault: true,
        secretMode: true,
      },
    }),
    db.agentSecret.findMany({
      where: { agent: { accountId } },
      select: {
        agent: { select: { identifier: true } },
        secret: { select: { name: true } },
      },
    }),
    db.policyRule.findMany({
      where: { accountId },
      select: {
        name: true,
        hostPattern: true,
        pathPattern: true,
        method: true,
        action: true,
        enabled: true,
        agentId: true,
        rateLimit: true,
        rateLimitWindow: true,
      },
    }),
  ]);

  if (secrets.length === 0 && agents.length === 0 && rules.length === 0) {
    return {
      imported: { secrets: 0, agents: 0, agentSecrets: 0, rules: 0 },
      skipped: [],
    };
  }

  // ── Decrypt secrets ───────────────────────────────────────────

  const decryptedSecrets = await Promise.all(
    secrets.map(async ({ encryptedValue, ...rest }) => {
      const value = await cryptoService.decrypt(encryptedValue);
      return { ...rest, value };
    }),
  );

  // ── Build agent id→identifier map for rule references ─────────

  const agentIdToIdentifier = new Map<string, string>();
  for (const agent of agents) {
    if (agent.identifier) {
      agentIdToIdentifier.set(agent.id, agent.identifier);
    }
  }

  // ── Build payload ─────────────────────────────────────────────

  const payload = {
    version: 1 as const,
    secrets: decryptedSecrets.map((s) => ({
      name: s.name,
      type: s.type,
      value: s.value,
      hostPattern: s.hostPattern,
      pathPattern: s.pathPattern,
      injectionConfig: s.injectionConfig as {
        headerName: string;
        valueFormat?: string;
      } | null,
      metadata: s.metadata as Record<string, unknown> | null,
    })),
    agents: agents
      .filter((a) => a.identifier)
      .map((a) => ({
        name: a.name,
        identifier: a.identifier!,
        isDefault: a.isDefault,
        secretMode: a.secretMode as "all" | "selective",
      })),
    agentSecrets: agentSecrets
      .filter((m) => m.agent.identifier)
      .map((m) => ({
        agentIdentifier: m.agent.identifier!,
        secretName: m.secret.name,
      })),
    rules: rules.map((r) => ({
      name: r.name,
      hostPattern: r.hostPattern,
      pathPattern: r.pathPattern,
      method: r.method,
      action: r.action as "block" | "rate_limit" | "manual_approval",
      enabled: r.enabled,
      agentIdentifier: r.agentId
        ? (agentIdToIdentifier.get(r.agentId) ?? null)
        : null,
      rateLimit: r.rateLimit,
      rateLimitWindow: r.rateLimitWindow as "minute" | "hour" | "day" | null,
    })),
  };

  // ── Send to cloud ─────────────────────────────────────────────

  const response = await fetch(`${CLOUD_URL}/api/migrate/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cloudApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    const msg = errorBody.error ?? `Cloud returned ${response.status}`;
    logger.error(
      { status: response.status, msg },
      "migration import request failed",
    );
    throw new ServiceError("BAD_REQUEST", `Cloud import failed: ${msg}`);
  }

  return (await response.json()) as MigrateResult;
};
